use std::path::PathBuf;
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::sync::Barrier;
use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;

use crate::ErrorKind;
use crate::ExecRuntime;
use crate::PollResponse;
use crate::SpawnRequest;

fn request(cmd: &str, tty: bool) -> SpawnRequest {
    SpawnRequest {
        cmd: cmd.to_string(),
        workdir: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        tty,
    }
}

fn collect_until_exit(runtime: &ExecRuntime, session_id: u64) -> PollResponse {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = Vec::new();
    let mut omitted_bytes = 0;
    loop {
        let response = runtime.poll(session_id).expect("poll should succeed");
        output.extend(response.output);
        output.extend(response.output_tail);
        omitted_bytes += response.omitted_bytes;
        if let Some(exit_code) = response.exit_code {
            let original_bytes = output.len().saturating_add(omitted_bytes);
            return PollResponse {
                output,
                output_tail: Vec::new(),
                omitted_bytes,
                original_bytes,
                exit_code: Some(exit_code),
            };
        }
        assert!(Instant::now() < deadline, "process did not exit in time");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tokio::test]
async fn runtime_can_be_dropped_from_an_async_context() {
    drop(ExecRuntime::new().expect("runtime should initialize"));
}

#[test]
fn completed_command_returns_output_and_exit_code() {
    let runtime = ExecRuntime::new().expect("runtime should initialize");
    let session_id = runtime
        .spawn(request(short_output_command(), false))
        .expect("spawn should succeed");

    let response = collect_until_exit(&runtime, session_id);

    assert_eq!(
        response,
        PollResponse {
            output: expected_short_output().to_vec(),
            output_tail: Vec::new(),
            omitted_bytes: 0,
            original_bytes: expected_short_output().len(),
            exit_code: Some(0),
        }
    );
    assert_eq!(
        runtime
            .poll(session_id)
            .expect_err("session is consumed")
            .kind(),
        ErrorKind::NotFound
    );
}

#[cfg(unix)]
#[test]
fn pipe_session_accepts_stdin_and_returns_incremental_output() {
    let runtime = ExecRuntime::new().expect("runtime should initialize");
    let session_id = runtime
        .spawn(request(
            "printf ready; read line; printf 'received:%s' \"$line\"",
            false,
        ))
        .expect("spawn should succeed");

    let deadline = Instant::now() + Duration::from_secs(5);
    let first = loop {
        let response = runtime.poll(session_id).expect("poll should succeed");
        if !response.output.is_empty() {
            break response;
        }
        assert!(Instant::now() < deadline, "initial output did not arrive");
        std::thread::sleep(Duration::from_millis(10));
    };
    runtime
        .write(session_id, "hello\n".to_string())
        .expect("stdin write should succeed");
    let second = collect_until_exit(&runtime, session_id);

    assert_eq!(first.output, b"ready");
    assert_eq!(second.output, b"received:hello");
    assert_eq!(second.exit_code, Some(0));
}

#[cfg(unix)]
#[test]
fn concurrent_spawns_keep_the_session_count_bounded() {
    const CALLERS: usize = 80;
    const SESSION_LIMIT: usize = 64;
    let runtime = Arc::new(ExecRuntime::new().expect("runtime should initialize"));
    let barrier = Arc::new(Barrier::new(CALLERS));
    let handles = (0..CALLERS)
        .map(|_| {
            let runtime = Arc::clone(&runtime);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                runtime.spawn(request("sleep 60", false))
            })
        })
        .collect::<Vec<_>>();

    let session_ids = handles
        .into_iter()
        .map(|handle| {
            handle
                .join()
                .expect("spawn thread should not panic")
                .expect("the oldest session is reclaimed instead of rejecting the spawn")
        })
        .collect::<Vec<_>>();
    let live = session_ids
        .iter()
        .filter(|session_id| runtime.poll(**session_id).is_ok())
        .count();

    assert_eq!(live, SESSION_LIMIT);
    runtime.shutdown();
}

#[cfg(unix)]
#[test]
fn exited_sessions_that_were_never_polled_are_reclaimed() {
    const SESSION_LIMIT: u64 = 64;
    let runtime = ExecRuntime::new().expect("runtime should initialize");
    let session_ids = (0..SESSION_LIMIT)
        .map(|_| {
            runtime
                .spawn(request("true", false))
                .expect("spawn should succeed")
        })
        .collect::<Vec<_>>();
    std::thread::sleep(Duration::from_millis(1_500));

    let next = runtime
        .spawn(request("sleep 60", false))
        .expect("an abandoned exited session must not exhaust the limit");

    assert_eq!(
        runtime
            .poll(session_ids[0])
            .expect_err("oldest is reclaimed")
            .kind(),
        ErrorKind::NotFound
    );
    assert!(runtime.poll(next).is_ok());
    runtime.shutdown();
}

#[cfg(unix)]
#[test]
fn live_sessions_beyond_the_limit_evict_the_least_recently_used() {
    const SESSION_LIMIT: usize = 64;
    let pid_file =
        std::env::temp_dir().join(format!("persistent-exec-evict-{}", std::process::id()));
    let _ = std::fs::remove_file(&pid_file);
    let runtime = ExecRuntime::new().expect("runtime should initialize");
    let victim = runtime
        .spawn(request(
            &format!("echo $$ > '{}'; exec sleep 60", pid_file.display()),
            false,
        ))
        .expect("spawn should succeed");
    let others = (1..SESSION_LIMIT)
        .map(|_| {
            runtime
                .spawn(request("sleep 60", false))
                .expect("spawn should succeed")
        })
        .collect::<Vec<_>>();
    let deadline = Instant::now() + Duration::from_secs(5);
    let pid = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|text| text.trim().parse::<libc::pid_t>().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline, "pid file was not written");
        std::thread::sleep(Duration::from_millis(10));
    };
    // Touching the second-oldest session leaves the first one least recently used.
    runtime.poll(others[0]).expect("session is live");

    runtime
        .spawn(request("sleep 60", false))
        .expect("the least recently used session is evicted");

    assert_eq!(
        runtime.poll(victim).expect_err("victim is evicted").kind(),
        ErrorKind::NotFound
    );
    assert!(runtime.poll(others[0]).is_ok());
    let deadline = Instant::now() + Duration::from_secs(5);
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(
            Instant::now() < deadline,
            "evicted process was not terminated"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = std::fs::remove_file(&pid_file);
    runtime.shutdown();
}

#[test]
fn interrupt_finishes_a_running_session() {
    let runtime = ExecRuntime::new().expect("runtime should initialize");
    let session_id = runtime
        .spawn(request(long_running_command(), cfg!(windows)))
        .expect("spawn should succeed");

    runtime
        .write(session_id, "\u{3}".to_string())
        .expect("interrupt should succeed");
    let response = collect_until_exit(&runtime, session_id);

    assert_ne!(response.exit_code, Some(0));
}

#[cfg(unix)]
#[test]
fn pty_ctrl_c_interrupts_the_interactive_foreground_job() {
    let runtime = ExecRuntime::new().expect("runtime should initialize");
    let session_id = runtime
        .spawn(request("exec bash --noprofile --norc -i", true))
        .expect("spawn should succeed");
    // The marker is emitted by the foreground job, not matched in terminal echo.
    runtime
        .write(
            session_id,
            "sh -c 'printf \"FOREGROUND_%s\\n\" READY; exec sleep 60'\n".to_string(),
        )
        .expect("foreground job should start");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut output = Vec::new();
    loop {
        let response = runtime.poll(session_id).expect("poll should succeed");
        output.extend(response.output);
        output.extend(response.output_tail);
        if String::from_utf8_lossy(&output).contains("FOREGROUND_READY\r\n") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "PTY handshake did not arrive; output: {:?}",
            String::from_utf8_lossy(&output)
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    runtime
        .write(session_id, "\u{3}".to_string())
        .expect("Ctrl-C write should succeed");
    runtime
        .write(session_id, "echo PTY_INTERRUPTED; exit\n".to_string())
        .expect("shell should accept input after Ctrl-C");

    let response = collect_until_exit(&runtime, session_id);
    assert_eq!(response.exit_code, Some(0));
    assert!(
        String::from_utf8_lossy(&response.output).contains("PTY_INTERRUPTED"),
        "interactive shell did not resume after Ctrl-C"
    );
}

#[cfg(unix)]
#[test]
fn pipe_interrupt_resets_inherited_signal_state() {
    use std::os::unix::process::CommandExt;

    const CHILD: &str = "PERSISTENT_EXEC_SIGNAL_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        interrupt_finishes_a_running_session();
        return;
    }

    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .args([
            "--exact",
            "tests::pipe_interrupt_resets_inherited_signal_state",
        ])
        .env(CHILD, "1");
    // Only alter the isolated child's signal state, never the parallel test runner's.
    unsafe {
        child.pre_exec(|| {
            libc::signal(libc::SIGINT, libc::SIG_IGN);
            let mut signals: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut signals);
            libc::sigaddset(&mut signals, libc::SIGINT);
            if libc::sigprocmask(libc::SIG_BLOCK, &signals, std::ptr::null_mut()) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    assert!(child.status().unwrap().success());
}

#[cfg(unix)]
fn short_output_command() -> &'static str {
    "printf persistent-exec"
}

#[cfg(unix)]
fn expected_short_output() -> &'static [u8] {
    b"persistent-exec"
}

#[cfg(windows)]
fn short_output_command() -> &'static str {
    "echo persistent-exec"
}

#[cfg(windows)]
fn expected_short_output() -> &'static [u8] {
    b"persistent-exec\r\n"
}

#[cfg(unix)]
fn long_running_command() -> &'static str {
    "sleep 60"
}

#[cfg(windows)]
fn long_running_command() -> &'static str {
    "ping -n 60 127.0.0.1 >NUL"
}
