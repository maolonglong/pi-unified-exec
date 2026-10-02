use std::collections::HashMap;
use std::ffi::CStr;
use std::ffi::CString;
use std::ffi::c_char;
use std::ffi::c_void;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::ptr;
use std::sync::Mutex;

use persistent_exec_core::ErrorKind;
use persistent_exec_core::ExecError;
use persistent_exec_core::ExecRuntime;
use persistent_exec_core::SpawnRequest;
use serde::Deserialize;
use serde::Serialize;

const API_VERSION: u32 = 1;

#[derive(Debug)]
struct FfiRuntime {
    runtime: ExecRuntime,
    utf8_pending: Mutex<HashMap<u64, Vec<u8>>>,
}

impl FfiRuntime {
    fn new() -> Result<Self, ExecError> {
        Ok(Self {
            runtime: ExecRuntime::new()?,
            utf8_pending: Mutex::new(HashMap::new()),
        })
    }

    fn decode_output(
        &self,
        session_id: u64,
        head: Vec<u8>,
        tail: Vec<u8>,
        omitted_bytes: usize,
        exit_code: Option<i32>,
    ) -> String {
        let mut pending_by_session = self
            .utf8_pending
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let pending = pending_by_session.entry(session_id).or_default();
        pending.extend(head);
        let mut decoded = decode_utf8(pending, /*flush*/ omitted_bytes > 0);
        if omitted_bytes > 0 {
            decoded.push_str(&format!("\n... {omitted_bytes} bytes omitted ...\n"));
        }
        pending.extend(tail);
        decoded.push_str(&decode_utf8(pending, /*flush*/ exit_code.is_some()));
        if exit_code.is_some() {
            pending_by_session.remove(&session_id);
        }
        decoded
    }

    fn forget_session(&self, session_id: u64) {
        self.utf8_pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&session_id);
    }
}

fn decode_utf8(bytes: &mut Vec<u8>, flush: bool) -> String {
    let source = std::mem::take(bytes);
    let mut decoded = String::new();
    let mut cursor = 0;
    while cursor < source.len() {
        match std::str::from_utf8(&source[cursor..]) {
            Ok(valid) => {
                decoded.push_str(valid);
                return decoded;
            }
            Err(error) => {
                let valid_end = cursor + error.valid_up_to();
                decoded.push_str(
                    std::str::from_utf8(&source[cursor..valid_end])
                        .expect("valid_up_to identifies valid UTF-8"),
                );
                match error.error_len() {
                    Some(error_len) => {
                        decoded.push('\u{fffd}');
                        cursor = valid_end + error_len;
                    }
                    None if flush => {
                        decoded.push('\u{fffd}');
                        return decoded;
                    }
                    None => {
                        bytes.extend_from_slice(&source[valid_end..]);
                        return decoded;
                    }
                }
            }
        }
    }
    decoded
}

#[repr(C)]
pub struct PersistentExecResult {
    pub success: bool,
    pub error_code: u32,
    pub error: *mut c_char,
    pub handle: *mut c_void,
    pub data: *mut c_char,
    pub int_value: i64,
}

impl PersistentExecResult {
    fn empty() -> *mut Self {
        Box::into_raw(Box::new(Self {
            success: true,
            error_code: 0,
            error: ptr::null_mut(),
            handle: ptr::null_mut(),
            data: ptr::null_mut(),
            int_value: 0,
        }))
    }

    fn handle(handle: *mut c_void) -> *mut Self {
        let result = Self::empty();
        unsafe {
            (*result).handle = handle;
        }
        result
    }

    fn integer(value: i64) -> *mut Self {
        let result = Self::empty();
        unsafe {
            (*result).int_value = value;
        }
        result
    }

    fn json<T: Serialize>(value: &T) -> *mut Self {
        match serde_json::to_string(value) {
            Ok(json) => {
                let result = Self::empty();
                unsafe {
                    (*result).data = cstring(&json);
                }
                result
            }
            Err(error) => Self::error(
                ErrorKind::Internal,
                &format!("serialization failed: {error}"),
            ),
        }
    }

    fn error(kind: ErrorKind, message: &str) -> *mut Self {
        Box::into_raw(Box::new(Self {
            success: false,
            error_code: error_code(kind),
            error: cstring(message),
            handle: ptr::null_mut(),
            data: ptr::null_mut(),
            int_value: 0,
        }))
    }
}

fn cstring(value: &str) -> *mut c_char {
    CString::new(value.replace('\0', "�"))
        .expect("NUL bytes were replaced")
        .into_raw()
}

fn error_code(kind: ErrorKind) -> u32 {
    match kind {
        ErrorKind::InvalidInput => 1,
        ErrorKind::NotFound => 2,
        ErrorKind::InvalidState => 3,
        ErrorKind::ResourceExhausted => 4,
        ErrorKind::Busy => 5,
        ErrorKind::SpawnFailed => 6,
        ErrorKind::Internal => 7,
    }
}

fn ffi_boundary(
    operation: impl FnOnce() -> *mut PersistentExecResult,
) -> *mut PersistentExecResult {
    std::panic::catch_unwind(AssertUnwindSafe(operation)).unwrap_or_else(|_| {
        PersistentExecResult::error(ErrorKind::Internal, "native runtime panicked")
    })
}

fn ffi_boundary_void(operation: impl FnOnce()) {
    let _ = std::panic::catch_unwind(AssertUnwindSafe(operation));
}

#[unsafe(no_mangle)]
pub extern "C" fn persistent_exec_create() -> *mut PersistentExecResult {
    ffi_boundary(|| match FfiRuntime::new() {
        Ok(runtime) => PersistentExecResult::handle(Box::into_raw(Box::new(runtime)).cast()),
        Err(error) => PersistentExecResult::error(error.kind(), error.message()),
    })
}

/// Destroy a runtime and terminate every process it owns.
///
/// # Safety
/// `handle` must be null or a live pointer returned by [`persistent_exec_create`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn persistent_exec_destroy(handle: *mut c_void) {
    ffi_boundary_void(|| {
        if handle.is_null() {
            return;
        }
        let runtime = unsafe { Box::from_raw(handle.cast::<FfiRuntime>()) };
        runtime.runtime.shutdown();
    });
}

/// Spawn a command from a versioned JSON request.
///
/// # Safety
/// `handle` must reference a live runtime and `request_json` must reference a
/// NUL-terminated string for the duration of this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn persistent_exec_spawn(
    handle: *mut c_void,
    request_json: *const c_char,
) -> *mut PersistentExecResult {
    ffi_boundary(|| {
        let runtime = match unsafe { runtime_ref(handle) } {
            Ok(runtime) => runtime,
            Err(error) => return PersistentExecResult::error(error.kind(), error.message()),
        };
        let request: SpawnJson = match unsafe { parse_request(request_json) } {
            Ok(request) => request,
            Err(error) => return PersistentExecResult::error(error.kind(), error.message()),
        };
        match runtime.runtime.spawn(SpawnRequest {
            cmd: request.cmd,
            workdir: PathBuf::from(request.workdir),
            tty: request.tty,
        }) {
            Ok(session_id) => match i64::try_from(session_id) {
                Ok(session_id) => PersistentExecResult::integer(session_id),
                Err(_) => PersistentExecResult::error(
                    ErrorKind::ResourceExhausted,
                    "session identifier space exhausted",
                ),
            },
            Err(error) => PersistentExecResult::error(error.kind(), error.message()),
        }
    })
}

/// Write stdin or send an interrupt from a versioned JSON request.
///
/// # Safety
/// The pointer requirements are the same as [`persistent_exec_spawn`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn persistent_exec_write(
    handle: *mut c_void,
    request_json: *const c_char,
) -> *mut PersistentExecResult {
    ffi_boundary(|| {
        let runtime = match unsafe { runtime_ref(handle) } {
            Ok(runtime) => runtime,
            Err(error) => return PersistentExecResult::error(error.kind(), error.message()),
        };
        let request: WriteJson = match unsafe { parse_request(request_json) } {
            Ok(request) => request,
            Err(error) => return PersistentExecResult::error(error.kind(), error.message()),
        };
        match runtime.runtime.write(request.session_id, request.chars) {
            Ok(()) => PersistentExecResult::empty(),
            Err(error) => PersistentExecResult::error(error.kind(), error.message()),
        }
    })
}

/// Read and consume incremental output from a versioned JSON request.
///
/// # Safety
/// The pointer requirements are the same as [`persistent_exec_spawn`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn persistent_exec_poll(
    handle: *mut c_void,
    request_json: *const c_char,
) -> *mut PersistentExecResult {
    ffi_boundary(|| {
        let runtime = match unsafe { runtime_ref(handle) } {
            Ok(runtime) => runtime,
            Err(error) => return PersistentExecResult::error(error.kind(), error.message()),
        };
        let request: SessionJson = match unsafe { parse_request(request_json) } {
            Ok(request) => request,
            Err(error) => return PersistentExecResult::error(error.kind(), error.message()),
        };
        match runtime.runtime.poll(request.session_id) {
            Ok(response) => PersistentExecResult::json(&PollJson {
                output: runtime.decode_output(
                    request.session_id,
                    response.output,
                    response.output_tail,
                    response.omitted_bytes,
                    response.exit_code,
                ),
                omitted_bytes: response.omitted_bytes,
                original_bytes: response.original_bytes,
                exit_code: response.exit_code,
            }),
            Err(error) => {
                if error.kind() == ErrorKind::NotFound {
                    // The runtime reclaimed or finished this session; drop its decoder state.
                    runtime.forget_session(request.session_id);
                }
                PersistentExecResult::error(error.kind(), error.message())
            }
        }
    })
}

/// Terminate a session from a versioned JSON request.
///
/// # Safety
/// The pointer requirements are the same as [`persistent_exec_spawn`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn persistent_exec_terminate(
    handle: *mut c_void,
    request_json: *const c_char,
) -> *mut PersistentExecResult {
    ffi_boundary(|| {
        let runtime = match unsafe { runtime_ref(handle) } {
            Ok(runtime) => runtime,
            Err(error) => return PersistentExecResult::error(error.kind(), error.message()),
        };
        let request: SessionJson = match unsafe { parse_request(request_json) } {
            Ok(request) => request,
            Err(error) => return PersistentExecResult::error(error.kind(), error.message()),
        };
        match runtime.runtime.terminate(request.session_id) {
            Ok(()) => PersistentExecResult::empty(),
            Err(error) => PersistentExecResult::error(error.kind(), error.message()),
        }
    })
}

/// Free a result envelope and its error/data strings. The runtime handle is not freed.
///
/// # Safety
/// `result` must be null or a pointer returned by this library that has not
/// already been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn persistent_exec_free_result(result: *mut PersistentExecResult) {
    if result.is_null() {
        return;
    }
    let result = unsafe { Box::from_raw(result) };
    if !result.error.is_null() {
        drop(unsafe { CString::from_raw(result.error) });
    }
    if !result.data.is_null() {
        drop(unsafe { CString::from_raw(result.data) });
    }
}

unsafe fn runtime_ref<'a>(handle: *mut c_void) -> Result<&'a FfiRuntime, ExecError> {
    if handle.is_null() {
        Err(ExecError::new(
            ErrorKind::InvalidInput,
            "runtime handle is null",
        ))
    } else {
        Ok(unsafe { &*handle.cast::<FfiRuntime>() })
    }
}

unsafe fn parse_request<T: for<'de> Deserialize<'de>>(
    request_json: *const c_char,
) -> Result<T, ExecError> {
    if request_json.is_null() {
        return Err(ExecError::new(
            ErrorKind::InvalidInput,
            "request JSON is null",
        ));
    }
    let request = unsafe { CStr::from_ptr(request_json) }
        .to_str()
        .map_err(|_| ExecError::new(ErrorKind::InvalidInput, "request JSON is not UTF-8"))?;
    let value: serde_json::Value = serde_json::from_str(request).map_err(|error| {
        ExecError::new(
            ErrorKind::InvalidInput,
            format!("invalid request JSON: {error}"),
        )
    })?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(u64::from(API_VERSION)) {
        return Err(ExecError::new(
            ErrorKind::InvalidInput,
            format!("request version must be {API_VERSION}"),
        ));
    }
    serde_json::from_value(value).map_err(|error| {
        ExecError::new(ErrorKind::InvalidInput, format!("invalid request: {error}"))
    })
}

#[derive(Debug, Deserialize)]
struct SpawnJson {
    #[allow(dead_code)]
    version: u32,
    cmd: String,
    workdir: String,
    #[serde(default)]
    tty: bool,
}

#[derive(Debug, Deserialize)]
struct WriteJson {
    #[allow(dead_code)]
    version: u32,
    session_id: u64,
    #[serde(default)]
    chars: String,
}

#[derive(Debug, Deserialize)]
struct SessionJson {
    #[allow(dead_code)]
    version: u32,
    session_id: u64,
}

#[derive(Debug, Serialize)]
struct PollJson {
    output: String,
    omitted_bytes: usize,
    original_bytes: usize,
    exit_code: Option<i32>,
}

#[cfg(test)]
#[path = "ffi_tests.rs"]
mod tests;
