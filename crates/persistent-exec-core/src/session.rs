use std::sync::Mutex;

use persistent_exec_pty::ProcessHandle;
use persistent_exec_pty::ProcessSignal;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::time::Duration;
use tokio::time::Instant;

use crate::error::ErrorKind;
use crate::error::ExecError;
use crate::error::Result;
use crate::output::OutputBuffer;

const EXIT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Default)]
struct SessionState {
    output: OutputBuffer,
    exit_code: Option<i32>,
}

#[derive(Debug)]
pub(crate) struct Session {
    process: ProcessHandle,
    tty: bool,
    state: Mutex<SessionState>,
}

impl Session {
    pub(crate) fn new(process: ProcessHandle, tty: bool) -> Self {
        Self {
            process,
            tty,
            state: Mutex::new(SessionState::default()),
        }
    }

    pub(crate) fn write(&self, bytes: Vec<u8>) -> Result<()> {
        if self.is_finished() {
            return Err(ExecError::new(
                ErrorKind::InvalidState,
                "session has already exited",
            ));
        }

        self.process
            .writer_sender()
            .try_send(bytes)
            .map_err(|error| {
                let (kind, message) = match error {
                    mpsc::error::TrySendError::Full(_) => {
                        (ErrorKind::Busy, "session stdin queue is full")
                    }
                    mpsc::error::TrySendError::Closed(_) => {
                        (ErrorKind::InvalidState, "session stdin is closed")
                    }
                };
                ExecError::new(kind, message)
            })
    }

    pub(crate) fn interrupt(&self) -> Result<()> {
        if self.tty {
            return self.write(vec![0x03]);
        }
        match self.process.signal(ProcessSignal::Interrupt) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::Unsupported => self.write(vec![0x03]),
            Err(error) => Err(ExecError::new(
                ErrorKind::Internal,
                format!("failed to interrupt process group: {error}"),
            )),
        }
    }

    pub(crate) fn terminate(&self) {
        self.process.request_terminate();
    }

    pub(crate) fn take_output(&self) -> SessionOutput {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let (output, output_tail, omitted_bytes) = state.output.take();
        SessionOutput {
            output,
            output_tail,
            omitted_bytes,
            exit_code: state.exit_code,
        }
    }

    pub(crate) fn has_exited(&self) -> bool {
        self.process.has_exited()
    }

    fn is_finished(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .exit_code
            .is_some()
    }

    fn push_output(&self, output: &[u8]) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .output
            .push(output);
    }

    fn finish(&self, exit_code: i32) {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .exit_code = Some(exit_code);
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SessionOutput {
    pub(crate) output: Vec<u8>,
    pub(crate) output_tail: Vec<u8>,
    pub(crate) omitted_bytes: usize,
    pub(crate) exit_code: Option<i32>,
}

pub(crate) async fn collect_process_output(
    session: std::sync::Arc<Session>,
    mut stdout_rx: mpsc::Receiver<Vec<u8>>,
    mut stderr_rx: mpsc::Receiver<Vec<u8>>,
    mut exit_rx: oneshot::Receiver<i32>,
) {
    let mut stdout_open = true;
    let mut stderr_open = true;

    let exit_code = loop {
        tokio::select! {
            output = stdout_rx.recv(), if stdout_open => match output {
                Some(output) => session.push_output(&output),
                None => stdout_open = false,
            },
            output = stderr_rx.recv(), if stderr_open => match output {
                Some(output) => session.push_output(&output),
                None => stderr_open = false,
            },
            exit = &mut exit_rx => break exit.unwrap_or(-1),
        }
    };

    let deadline = Instant::now() + EXIT_DRAIN_TIMEOUT;
    while stdout_open || stderr_open {
        tokio::select! {
            output = stdout_rx.recv(), if stdout_open => match output {
                Some(output) => session.push_output(&output),
                None => stdout_open = false,
            },
            output = stderr_rx.recv(), if stderr_open => match output {
                Some(output) => session.push_output(&output),
                None => stderr_open = false,
            },
            () = tokio::time::sleep_until(deadline) => break,
        }
    }

    session.finish(exit_code);
}
