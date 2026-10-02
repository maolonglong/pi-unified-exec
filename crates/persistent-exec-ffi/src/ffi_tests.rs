use std::ffi::CStr;
use std::ffi::CString;
use std::ffi::c_void;
use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;
use serde::Deserialize;

use super::FfiRuntime;
use super::PersistentExecResult;
use super::decode_utf8;
use super::persistent_exec_create;
use super::persistent_exec_destroy;
use super::persistent_exec_free_result;
use super::persistent_exec_poll;
use super::persistent_exec_spawn;

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct PollResult {
    output: String,
    omitted_bytes: usize,
    original_bytes: usize,
    exit_code: Option<i32>,
}

unsafe fn take_result(result: *mut PersistentExecResult) -> (*mut c_void, i64, Option<String>) {
    assert!(!result.is_null());
    let result_ref = unsafe { &*result };
    assert!(
        result_ref.success,
        "native error code {}",
        result_ref.error_code
    );
    let data = if result_ref.data.is_null() {
        None
    } else {
        Some(
            unsafe { CStr::from_ptr(result_ref.data) }
                .to_str()
                .expect("data should be UTF-8")
                .to_string(),
        )
    };
    let values = (result_ref.handle, result_ref.int_value, data);
    unsafe { persistent_exec_free_result(result) };
    values
}

#[test]
fn c_abi_runs_and_polls_a_command() {
    let create = persistent_exec_create();
    let (handle, _, _) = unsafe { take_result(create) };
    assert!(!handle.is_null());

    let request = CString::new(format!(
        r#"{{"version":1,"cmd":{},"workdir":{}}}"#,
        serde_json::to_string(short_output_command()).expect("command should serialize"),
        serde_json::to_string(env!("CARGO_MANIFEST_DIR")).expect("path should serialize")
    ))
    .expect("request should not contain NUL");
    let spawn = unsafe { persistent_exec_spawn(handle, request.as_ptr()) };
    let (_, session_id, _) = unsafe { take_result(spawn) };

    let poll_request = CString::new(format!(r#"{{"version":1,"session_id":{session_id}}}"#))
        .expect("request should not contain NUL");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = String::new();
    let mut original_bytes = 0;
    let exit_code = loop {
        let poll = unsafe { persistent_exec_poll(handle, poll_request.as_ptr()) };
        let (_, _, data) = unsafe { take_result(poll) };
        let data: PollResult = serde_json::from_str(data.as_deref().expect("poll data expected"))
            .expect("poll data should deserialize");
        output.push_str(&data.output);
        original_bytes += data.original_bytes;
        if let Some(exit_code) = data.exit_code {
            break exit_code;
        }
        assert!(Instant::now() < deadline, "command did not exit in time");
        std::thread::sleep(Duration::from_millis(10));
    };

    assert_eq!(
        (output, exit_code),
        (expected_short_output().to_string(), 0)
    );
    assert_eq!(original_bytes, expected_short_output().len());
    unsafe { persistent_exec_destroy(handle) };
}

#[cfg(unix)]
fn short_output_command() -> &'static str {
    "printf ffi-ok"
}

#[cfg(unix)]
fn expected_short_output() -> &'static str {
    "ffi-ok"
}

#[cfg(windows)]
fn short_output_command() -> &'static str {
    "echo ffi-ok"
}

#[cfg(windows)]
fn expected_short_output() -> &'static str {
    "ffi-ok\r\n"
}

#[test]
fn utf8_decoder_preserves_code_points_across_poll_boundaries() {
    let mut pending = vec![0xe2, 0x82];
    assert_eq!(decode_utf8(&mut pending, /*flush*/ false), "");
    assert_eq!(pending, vec![0xe2, 0x82]);

    pending.push(0xac);
    assert_eq!(decode_utf8(&mut pending, /*flush*/ false), "€");
    assert_eq!(pending, Vec::<u8>::new());
}

#[test]
fn omission_notice_separates_utf8_discontinuity_and_reports_exact_bytes() {
    let runtime = FfiRuntime::new().expect("runtime should initialize");
    let output = runtime.decode_output(7, vec![b'h', 0xe2], vec![0x82, 0xac, b't'], 19, Some(0));

    assert_eq!(output, "h�\n... 19 bytes omitted ...\n��t");
}

#[test]
fn final_poll_preserves_utf8_across_retained_segments_without_omission() {
    let runtime = FfiRuntime::new().expect("runtime should initialize");
    let output = runtime.decode_output(7, vec![0xe2], vec![0x82, 0xac], 0, Some(0));
    assert_eq!(output, "€");
}

#[test]
fn c_abi_rejects_unknown_request_versions() {
    let create = persistent_exec_create();
    let (handle, _, _) = unsafe { take_result(create) };
    let request =
        CString::new(r#"{"version":2,"session_id":1}"#).expect("request should not contain NUL");

    let result = unsafe { persistent_exec_poll(handle, request.as_ptr()) };
    let result_ref = unsafe { &*result };

    assert_eq!((result_ref.success, result_ref.error_code), (false, 1));
    unsafe {
        persistent_exec_free_result(result);
        persistent_exec_destroy(handle);
    }
}

#[cfg(unix)]
fn long_running_command() -> &'static str {
    "sleep 60"
}

#[cfg(windows)]
fn long_running_command() -> &'static str {
    "ping -n 60 127.0.0.1 >NUL"
}

#[test]
fn reclaiming_a_session_drops_its_decoder_state() {
    let (handle, _, _) = unsafe { take_result(persistent_exec_create()) };
    let spawn_request = CString::new(format!(
        r#"{{"version":1,"cmd":{},"workdir":{}}}"#,
        serde_json::to_string(long_running_command()).expect("command should serialize"),
        serde_json::to_string(env!("CARGO_MANIFEST_DIR")).expect("path should serialize")
    ))
    .expect("request should not contain NUL");
    let spawn = |handle| {
        let (_, session_id, _) =
            unsafe { take_result(persistent_exec_spawn(handle, spawn_request.as_ptr())) };
        session_id
    };

    // Polling gives the session decoder state; it is then abandoned and never polled again.
    let abandoned = spawn(handle);
    let poll_request = CString::new(format!(r#"{{"version":1,"session_id":{abandoned}}}"#))
        .expect("request should not contain NUL");
    unsafe { take_result(persistent_exec_poll(handle, poll_request.as_ptr())) };
    let runtime = unsafe { &*handle.cast::<FfiRuntime>() };
    assert_eq!(runtime.utf8_pending.lock().expect("lock").len(), 1);

    // The registry holds 64 sessions, so the 65th spawn reclaims the least recently used one.
    for _ in 0..64 {
        spawn(handle);
    }
    assert_eq!(runtime.utf8_pending.lock().expect("lock").len(), 0);

    unsafe { persistent_exec_destroy(handle) };
}
