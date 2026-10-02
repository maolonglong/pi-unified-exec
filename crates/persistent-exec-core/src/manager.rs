use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use persistent_exec_pty::SpawnedProcess;
use persistent_exec_pty::TerminalSize;
use tokio::runtime::Runtime;

use crate::error::ErrorKind;
use crate::error::ExecError;
use crate::error::Result;
use crate::session::Session;
use crate::session::collect_process_output;

const MAX_SESSIONS: usize = 64;
/// The most recently used sessions are never reclaimed to make room for a new one.
const PROTECTED_RECENT_SESSIONS: usize = 8;

/// Applied after the inherited environment so commands never block on a pager or color probe.
const COMMAND_ENV: [(&str, &str); 6] = [
    ("NO_COLOR", "1"),
    ("TERM", "dumb"),
    ("COLORTERM", ""),
    ("PAGER", "cat"),
    ("GIT_PAGER", "cat"),
    ("GH_PAGER", "cat"),
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    pub cmd: String,
    pub workdir: PathBuf,
    pub tty: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PollResponse {
    /// First retained bytes consumed by this poll.
    pub output: Vec<u8>,
    /// Last retained bytes, contiguous with `output` unless `omitted_bytes` is nonzero.
    pub output_tail: Vec<u8>,
    /// Bytes discarded between the two retained segments.
    pub omitted_bytes: usize,
    /// Retained plus omitted raw bytes consumed by this poll, before UTF-8 decoding.
    pub original_bytes: usize,
    pub exit_code: Option<i32>,
}

/// Owns all process sessions for one agent session.
#[derive(Debug)]
pub struct ExecRuntime {
    runtime: Option<Runtime>,
    registry: Mutex<SessionRegistry>,
    /// Serializes spawns so capacity checks and insertions cannot interleave.
    spawn_gate: Mutex<()>,
    next_session_id: AtomicU64,
}

#[derive(Debug)]
struct SessionEntry {
    session: Arc<Session>,
    last_used: u64,
}

#[derive(Debug, Default)]
struct SessionRegistry {
    sessions: HashMap<u64, SessionEntry>,
    /// Monotonic counter standing in for a clock: higher means more recently used.
    clock: u64,
}

impl SessionRegistry {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// Makes room for one more session, reclaiming an old one when the registry is full.
    ///
    /// Returns the reclaimed session, which the caller must terminate outside the lock.
    fn make_room(&mut self) -> Result<Option<Arc<Session>>> {
        if self.sessions.len() < MAX_SESSIONS {
            return Ok(None);
        }
        let session_id = self.session_to_reclaim().ok_or_else(|| {
            ExecError::new(
                ErrorKind::ResourceExhausted,
                format!("at most {MAX_SESSIONS} sessions may run concurrently"),
            )
        })?;
        Ok(self.sessions.remove(&session_id).map(|entry| entry.session))
    }

    /// Prefers the least recently used exited session, then the least recently used live one.
    fn session_to_reclaim(&self) -> Option<u64> {
        let mut by_recency = self
            .sessions
            .iter()
            .map(|(id, entry)| (*id, entry.last_used, entry.session.has_exited()))
            .collect::<Vec<_>>();
        by_recency.sort_unstable_by_key(|(_, last_used, _)| *last_used);
        let reclaimable = by_recency.len().saturating_sub(PROTECTED_RECENT_SESSIONS);
        let candidates = &by_recency[..reclaimable];
        candidates
            .iter()
            .find(|(_, _, exited)| *exited)
            .or_else(|| candidates.first())
            .map(|(id, _, _)| *id)
    }
}

impl ExecRuntime {
    pub fn new() -> Result<Self> {
        let runtime = Runtime::new().map_err(|error| {
            ExecError::new(
                ErrorKind::Internal,
                format!("failed to initialize async runtime: {error}"),
            )
        })?;
        Ok(Self {
            runtime: Some(runtime),
            registry: Mutex::new(SessionRegistry::default()),
            spawn_gate: Mutex::new(()),
            next_session_id: AtomicU64::new(1),
        })
    }

    pub fn spawn(&self, request: SpawnRequest) -> Result<u64> {
        validate_spawn_request(&request)?;
        let _gate = self
            .spawn_gate
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(session) = self.registry().make_room()? {
            session.terminate();
        }

        let spawned = self
            .runtime()
            .block_on(spawn_shell_command(&request))
            .map_err(|error| {
                ExecError::new(
                    ErrorKind::SpawnFailed,
                    format!("failed to spawn command: {error}"),
                )
            })?;
        let session_id = self.next_session_id.fetch_add(1, Ordering::Relaxed);
        let SpawnedProcess {
            session: process,
            stdout_rx,
            stderr_rx,
            exit_rx,
        } = spawned;
        let session = Arc::new(Session::new(process, request.tty));
        {
            let mut registry = self.registry();
            let last_used = registry.tick();
            registry.sessions.insert(
                session_id,
                SessionEntry {
                    session: Arc::clone(&session),
                    last_used,
                },
            );
        }
        self.runtime().spawn(collect_process_output(
            session, stdout_rx, stderr_rx, exit_rx,
        ));

        Ok(session_id)
    }

    pub fn write(&self, session_id: u64, chars: String) -> Result<()> {
        let session = self.get_session(session_id)?;
        if chars == "\u{3}" {
            session.interrupt()
        } else {
            session.write(chars.into_bytes())
        }
    }

    pub fn poll(&self, session_id: u64) -> Result<PollResponse> {
        let session = self.get_session(session_id)?;
        let output = session.take_output();
        if output.exit_code.is_some() {
            self.registry().sessions.remove(&session_id);
        }
        Ok(PollResponse {
            original_bytes: output
                .output
                .len()
                .saturating_add(output.output_tail.len())
                .saturating_add(output.omitted_bytes),
            output: output.output,
            output_tail: output.output_tail,
            omitted_bytes: output.omitted_bytes,
            exit_code: output.exit_code,
        })
    }

    pub fn terminate(&self, session_id: u64) -> Result<()> {
        let session = self.get_session(session_id)?;
        session.terminate();
        Ok(())
    }

    pub fn shutdown(&self) {
        let sessions = self
            .registry()
            .sessions
            .drain()
            .map(|(_, entry)| entry.session)
            .collect::<Vec<_>>();
        for session in sessions {
            session.terminate();
        }
    }

    fn runtime(&self) -> &Runtime {
        self.runtime
            .as_ref()
            .expect("runtime is available until ExecRuntime::drop")
    }

    fn registry(&self) -> MutexGuard<'_, SessionRegistry> {
        self.registry
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn get_session(&self, session_id: u64) -> Result<Arc<Session>> {
        let mut registry = self.registry();
        let last_used = registry.tick();
        let entry = registry.sessions.get_mut(&session_id).ok_or_else(|| {
            ExecError::new(
                ErrorKind::NotFound,
                format!("unknown session_id {session_id}"),
            )
        })?;
        entry.last_used = last_used;
        Ok(Arc::clone(&entry.session))
    }
}

impl Drop for ExecRuntime {
    fn drop(&mut self) {
        self.shutdown();
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

fn validate_spawn_request(request: &SpawnRequest) -> Result<()> {
    if request.cmd.trim().is_empty() {
        return Err(ExecError::new(
            ErrorKind::InvalidInput,
            "cmd must not be empty",
        ));
    }
    if !request.workdir.is_dir() {
        return Err(ExecError::new(
            ErrorKind::InvalidInput,
            format!("workdir is not a directory: {}", request.workdir.display()),
        ));
    }
    Ok(())
}

async fn spawn_shell_command(request: &SpawnRequest) -> anyhow::Result<SpawnedProcess> {
    let (program, args) = shell_command(&request.cmd);
    let environment = command_environment();
    let cwd = Path::new(&request.workdir);
    if request.tty {
        persistent_exec_pty::spawn_pty_process(
            &program,
            &args,
            cwd,
            &environment,
            &None,
            TerminalSize::default(),
            &[],
        )
        .await
    } else {
        // Without a terminal nothing can answer a prompt, so readers of stdin see EOF.
        persistent_exec_pty::spawn_pipe_process_no_stdin(
            &program,
            &args,
            cwd,
            &environment,
            &None,
            &[],
        )
        .await
    }
}

fn command_environment() -> HashMap<String, String> {
    let mut environment = std::env::vars().collect::<HashMap<_, _>>();
    environment.extend(
        COMMAND_ENV
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string())),
    );
    environment
}

#[cfg(unix)]
fn shell_command(cmd: &str) -> (String, Vec<String>) {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string());
    (shell, vec!["-c".to_string(), cmd.to_string()])
}

#[cfg(windows)]
fn shell_command(cmd: &str) -> (String, Vec<String>) {
    (
        "powershell.exe".to_string(),
        vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            cmd.to_string(),
        ],
    )
}
