use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use crate::error::{Error, Result};

/// macOS 自带的电源断言工具；`-i` 只挡系统空闲休眠，不动显示屏。
const CAFFEINATE: &str = "/usr/bin/caffeinate";

/// 阻止休眠的断言句柄。加解锁都走这里，退出前必须显式释放，
/// 否则 caffeinate 会变成孤儿进程一直挡着休眠。
#[derive(Default)]
pub struct WakeLock {
    child: Mutex<Option<Child>>,
}

impl WakeLock {
    /// 已经握着时返回 true；系统没有 caffeinate 时报错而不是静默失败
    pub fn hold(&self) -> Result<bool> {
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

    /// 返回本次是否真松掉了一把锁
    pub fn release(&self) -> bool {
        let Some(mut child) = self.child.lock().unwrap().take() else {
            return false;
        };
        let _ = child.kill();
        let _ = child.wait();
        true
    }

    pub fn held(&self) -> bool {
        self.child
            .lock()
            .unwrap()
            .as_mut()
            .is_some_and(|c| c.try_wait().ok().flatten().is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
