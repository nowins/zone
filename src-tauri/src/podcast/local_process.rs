use std::path::Path;

// Start suspended, attach to a kill-on-close Windows Job, then run. The child
// cannot outlive Zone, even if Zone is force-terminated during inference.
#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows::{core::{PCWSTR, PWSTR}, Win32::{Foundation::{CloseHandle, HANDLE}, System::{
        JobObjects::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY},
        Threading::{CreateProcessW, GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
            BELOW_NORMAL_PRIORITY_CLASS, CREATE_NO_WINDOW, CREATE_SUSPENDED, PROCESS_INFORMATION, STARTUPINFOW},
    }}};
    struct Owned(HANDLE);
    impl Drop for Owned { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }
    pub(crate) struct EngineProcess { process: Owned, job: Owned }
    // Quote Windows argv directly; no shell interprets paths or arguments.
    fn quote(value: &OsStr) -> Vec<u16> {
        let mut output = vec![34]; let mut slashes = 0;
        for c in value.encode_wide() {
            if c == 92 { slashes += 1; continue; }
            output.extend(std::iter::repeat_n(92, if c == 34 { slashes * 2 + 1 } else { slashes }));
            slashes = 0; output.push(c);
        }
        output.extend(std::iter::repeat_n(92, slashes * 2)); output.push(34); output
    }
    impl EngineProcess {
        pub(crate) fn start(exe: &Path, arguments: &[&OsStr], cwd: &Path) -> Result<Self, String> {
            unsafe {
                let job = Owned(CreateJobObjectW(None, None).map_err(|_| "无法创建本地引擎资源限制")?);
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
                limits.BasicLimitInformation.ActiveProcessLimit = 1;
                limits.ProcessMemoryLimit = 1536 * 1024 * 1024;
                SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32).map_err(|_| "无法限制本地引擎内存")?;
                let application: Vec<_> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
                let directory: Vec<_> = cwd.as_os_str().encode_wide().chain(Some(0)).collect();
                let mut command = quote(exe.as_os_str());
                for argument in arguments { command.push(32); command.extend(quote(argument)); }
                command.push(0);
                let startup = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
                let mut info = PROCESS_INFORMATION::default();
                CreateProcessW(PCWSTR(application.as_ptr()), Some(PWSTR(command.as_mut_ptr())), None, None, false,
                    CREATE_NO_WINDOW | CREATE_SUSPENDED | BELOW_NORMAL_PRIORITY_CLASS, None, PCWSTR(directory.as_ptr()), &startup, &mut info).map_err(|_| "无法启动本地引擎，请检查安装文件和系统策略")?;
                let process = Owned(info.hProcess); let thread = Owned(info.hThread);
                if AssignProcessToJobObject(job.0, process.0).is_err() {
                    let _ = TerminateProcess(process.0, 1); let _ = WaitForSingleObject(process.0, 5000);
                    return Err("无法隔离本地引擎进程，已停止处理".into());
                }
                if ResumeThread(thread.0) == u32::MAX { return Err("无法运行本地引擎".into()); }
                Ok(Self { process, job })
            }
        }
        pub(crate) fn status(&self) -> Result<Option<u32>, String> {
            let mut code = 0;
            unsafe { GetExitCodeProcess(self.process.0, &mut code).map_err(|_| "无法读取本地引擎状态")?; }
            Ok(if code == 259 { None } else { Some(code) })
        }
        pub(crate) fn stop(&self) {
            unsafe { let _ = TerminateJobObject(self.job.0, 1); let _ = WaitForSingleObject(self.process.0, 5000); }
        }
        #[cfg(test)] pub(crate) fn id(&self) -> u32 { unsafe { windows::Win32::System::Threading::GetProcessId(self.process.0) } }
    }
    impl Drop for EngineProcess { fn drop(&mut self) { self.stop(); } }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test] fn arguments_preserve_spaces_unicode_quotes_and_trailing_slashes() {
            let text = String::from_utf16(&quote(OsStr::new("中文 路径\\"))).unwrap();
            assert_eq!(text, "\"中文 路径\\\\\"");
            assert_eq!(String::from_utf16(&quote(OsStr::new("a\"b"))).unwrap(), "\"a\\\"b\"");
        }
        #[test]
        #[ignore = "Helper for the real engine owner-exit test"]
        fn native_job_owner_helper() {
            let Some(root) = std::env::var_os("ZONE_WHISPER_JOB_DIR").map(std::path::PathBuf::from) else { panic!("only run via owner-exit test"); };
            let fixtures = std::path::PathBuf::from(std::env::var_os("ZONE_WHISPER_TEST_FIXTURES").unwrap());
            let engine = std::path::PathBuf::from(std::env::var_os("ZONE_WHISPER_TEST_ENGINE").unwrap()).join("zone-whisper.exe");
            let model = fixtures.join("ggml-base-q5_1.bin"); let input = root.join("input.wav"); let output = root.join("output.json"); let progress = root.join("progress.txt");
            let child = EngineProcess::start(&engine, &[model.as_os_str(), input.as_os_str(), output.as_os_str(), OsStr::new("en"), OsStr::new("1"), progress.as_os_str()], &root).unwrap();
            std::fs::write(root.join("child-pid.txt"), child.id().to_string()).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(120));
        }
        #[test]
        #[ignore = "Requires the actual built engine and explicit model fixtures"]
        fn real_engine_is_killed_when_owner_is_force_terminated() {
            use std::{os::windows::process::CommandExt, time::{Duration, Instant}};
            use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
            let directory = crate::podcast::test_support::test_directory("whisper-job-exit");
            let samples = vec![0i16; 60 * 16000];
            std::fs::write(directory.join("input.wav"), crate::podcast::pcm_export::wav(&samples)).unwrap();
            let mut owner = std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact", "podcast::local_process::platform::tests::native_job_owner_helper", "--ignored", "--nocapture"]).env("ZONE_WHISPER_JOB_DIR", &directory).creation_flags(0x08000000).spawn().unwrap();
            let started = Instant::now();
            while !directory.join("child-pid.txt").is_file() {
                assert!(started.elapsed() < Duration::from_secs(10), "owner failed to create actual engine child");
                std::thread::sleep(Duration::from_millis(50));
            }
            let pid: u32 = std::fs::read_to_string(directory.join("child-pid.txt")).unwrap().parse().unwrap();
            let engine = Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) }.unwrap());
            let mut code = 0; unsafe { GetExitCodeProcess(engine.0, &mut code) }.unwrap(); assert_eq!(code, 259);
            owner.kill().unwrap(); owner.wait().unwrap();
            assert_eq!(unsafe { WaitForSingleObject(engine.0, 5000) }.0, 0, "Job must terminate engine after owner crash");
            std::fs::write(std::path::PathBuf::from(std::env::var_os("ZONE_WHISPER_TEST_FIXTURES").unwrap()).join("owner-exit-result.json"), format!("{{\"ownerForcedExit\":true,\"enginePid\":{pid},\"engineTerminated\":true}}")).unwrap();
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
}
#[cfg(windows)] pub(crate) use platform::EngineProcess;
