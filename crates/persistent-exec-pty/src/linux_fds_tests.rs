//! Child-visible descriptor inheritance and launch-error reporting.

use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::Command;

use pretty_assertions::assert_eq;

use crate::linux_fds::close_inherited_fds_except;

// Called only from pre_exec: reject one syscall in the child without changing
// the test runner's permissions or allocating memory after fork.
fn deny_syscall(syscall_number: libc::c_long) -> io::Result<()> {
    let mut filter = [
        libc::sock_filter {
            code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as _,
            jt: 0,
            jf: 0,
            k: std::mem::offset_of!(libc::seccomp_data, nr) as _,
        },
        libc::sock_filter {
            code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as _,
            jt: 0,
            jf: 1,
            k: syscall_number as _,
        },
        libc::sock_filter {
            code: (libc::BPF_RET | libc::BPF_K) as _,
            jt: 0,
            jf: 0,
            k: libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
        },
        libc::sock_filter {
            code: (libc::BPF_RET | libc::BPF_K) as _,
            jt: 0,
            jf: 0,
            k: libc::SECCOMP_RET_ALLOW,
        },
    ];
    let program = libc::sock_fprog {
        len: filter.len() as _,
        filter: filter.as_mut_ptr(),
    };
    // SAFETY: The kernel copies the stack-owned filter before prctl returns.
    let installed = unsafe {
        libc::prctl(
            libc::PR_SET_NO_NEW_PRIVS,
            1_usize,
            0_usize,
            0_usize,
            0_usize,
        ) != -1
            && libc::prctl(
                libc::PR_SET_SECCOMP,
                libc::SECCOMP_MODE_FILTER as usize,
                &raw const program,
                0_usize,
                0_usize,
            ) != -1
    };
    if installed {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Opens a descriptor above the stdio range that survives exec unless cleaned up.
fn inheritable_descriptor() -> (File, libc::c_int) {
    let file = File::open("/dev/null").expect("open /dev/null");
    // SAFETY: F_DUPFD duplicates onto a new descriptor owned by this test.
    let raw = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_DUPFD, 100) };
    assert_ne!(raw, -1, "{}", io::Error::last_os_error());
    // SAFETY: the duplicate is newly created and owned here.
    let duplicate = unsafe { std::os::fd::FromRawFd::from_raw_fd(raw) };
    (duplicate, raw)
}

/// Runs `sh` after cleanup and reports whether each descriptor is open in the child.
fn child_sees(fds: &[libc::c_int], preserved: Vec<libc::c_int>, deny_close_range: bool) -> String {
    let script = fds
        .iter()
        .map(|fd| format!("if [ -e /proc/self/fd/{fd} ]; then printf 1; else printf 0; fi"))
        .collect::<Vec<_>>()
        .join(";");
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(script);
    // SAFETY: the hook only issues syscalls and touches stack storage.
    unsafe {
        command.pre_exec(move || {
            if deny_close_range {
                deny_syscall(libc::SYS_close_range)?;
            }
            close_inherited_fds_except(&preserved);
            Ok(())
        });
    }
    let output = command.output().expect("child runs");
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout).expect("utf8")
}

#[test]
fn cleanup_closes_unrelated_descriptors_and_keeps_preserved_ones() {
    let (_first, kept) = inheritable_descriptor();
    let (_second, dropped) = inheritable_descriptor();
    for deny_close_range in [false, true] {
        assert_eq!(
            child_sees(&[kept, dropped], vec![kept], deny_close_range),
            "10",
            "deny_close_range={deny_close_range}"
        );
        assert_eq!(
            child_sees(&[kept, dropped], Vec::new(), deny_close_range),
            "00",
            "deny_close_range={deny_close_range}"
        );
    }
}

#[test]
fn cleanup_does_not_change_the_parent_descriptors() {
    let (_file, fd) = inheritable_descriptor();
    child_sees(&[fd], Vec::new(), false);
    // SAFETY: fcntl only reads this descriptor's flags.
    assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, 0);
}

#[test]
fn cleanup_fallback_preserves_exec_failure_reporting() {
    let mut command = Command::new("/nonexistent/persistent-exec-test-binary");
    // SAFETY: the hook only issues syscalls and touches stack storage.
    unsafe {
        command.pre_exec(|| {
            deny_syscall(libc::SYS_close_range)?;
            close_inherited_fds_except(&[]);
            Ok(())
        });
    }
    let error = command.spawn().expect_err("exec must fail");
    assert_eq!(error.raw_os_error(), Some(libc::ENOENT));
}

#[test]
fn cleanup_failures_do_not_prevent_launch() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "exit 42"]);
    // SAFETY: the hook only issues syscalls and touches stack storage.
    unsafe {
        command.pre_exec(|| {
            deny_syscall(libc::SYS_close_range)?;
            deny_syscall(libc::SYS_getdents64)?;
            close_inherited_fds_except(&[]);
            Ok(())
        });
    }
    assert_eq!(command.status().expect("launch").code(), Some(42));
}
