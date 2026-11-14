#[cfg(not(windows))]
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[cfg(not(windows))]
use crate::error::Error;
use crate::error::Result;

/// macOS 自带的电源断言工具；`-i` 只挡系统空闲休眠，不动显示屏。
#[cfg(not(windows))]
const CAFFEINATE: &str = "/usr/bin/caffeinate";

/// 阻止休眠的断言句柄。加解锁都走这里，退出前必须显式释放，
/// 否则 caffeinate 会变成孤儿进程一直挡着休眠。
/// Windows 不拉子进程：SetThreadExecutionState 的断言挂在调用线程上、
/// 线程一退就失效，所以用一个常驻线程持有，释放时让线程清断言退出。
#[derive(Default)]
pub struct WakeLock {
    #[cfg(not(windows))]
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    holder: Mutex<Option<(std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>)>>,
}

impl WakeLock {
    /// 已经握着时返回 true；系统没有对应能力时报错而不是静默失败
    pub fn hold(&self) -> Result<bool> {
        #[cfg(not(windows))]
        {
            let mut guard = self.child.lock().unwrap();
            if guard.as_mut().is_some_and(|c| c.try_wait().ok().flatten().is_none()) {
                return Ok(true);
            }
            *guard = Some(
                Command::new(CAFFEINATE)
                    .arg("-i")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| Error::Msg(format!("无法启动 caffeinate：{e}")))?,
            );
            Ok(true)
        }
        #[cfg(windows)]
        {
            let mut guard = self.holder.lock().unwrap();
            if guard.as_ref().is_some_and(|(_, t)| !t.is_finished()) {
                return Ok(true);
            }
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let handle = std::thread::spawn(move || {
                win::hold();
                // 线程活着就是断言本体：release 丢掉发送端，唤醒后清断言退出
                let _ = rx.recv();
                win::clear();
            });
            *guard = Some((tx, handle));
            Ok(true)
        }
    }

    /// 返回本次是否真松掉了一把锁
    pub fn release(&self) -> bool {
        #[cfg(not(windows))]
        {
            let Some(mut child) = self.child.lock().unwrap().take() else {
                return false;
            };
            let _ = child.kill();
            let _ = child.wait();
            true
        }
        #[cfg(windows)]
        {
            let taken = self.holder.lock().unwrap().take();
            let Some((tx, handle)) = taken else {
                return false;
            };
            drop(tx);
            handle.join().is_ok()
        }
    }

    /// 只在测试里用：生产路径靠 hold/release 的返回值判断状态，
    /// 保留这个方法是为了让幂等性可以被断言，所以不编进非测试构建。
    #[cfg(all(test, not(windows)))]
    pub fn held(&self) -> bool {
        self.child
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|c| c.try_wait().ok().flatten().is_none())
    }
}

/// Windows：直接声明这一个 kernel32 调用，不为此引入整个 windows crate。
/// ES_SYSTEM_REQUIRED 挡系统空闲休眠、不动显示屏，与 caffeinate -i 语义对齐。
#[cfg(windows)]
mod win {
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    pub fn hold() {
        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
    }

    pub fn clear() {
        unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn hold_release_roundtrip() {
        if !std::path::Path::new(CAFFEINATE).exists() {
            return;
        }
        let lock = WakeLock::default();
        assert!(!lock.held());
        assert!(lock.hold().unwrap());
        assert!(lock.held(), "加锁后 caffeinate 子进程应活着");
        assert!(lock.hold().unwrap(), "重复加锁应幂等");
        assert!(lock.release());
        assert!(!lock.held(), "释放后不该留下孤儿进程");
        assert!(!lock.release(), "没锁时释放返回 false");
    }

    #[cfg(windows)]
    #[test]
    fn hold_release_roundtrip() {
        let lock = WakeLock::default();
        assert!(lock.hold().unwrap());
        assert!(lock.hold().unwrap(), "重复加锁应幂等");
        assert!(lock.release());
        assert!(!lock.release(), "没锁时释放返回 false");
    }
}
