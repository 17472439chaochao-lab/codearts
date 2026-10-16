use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

use crate::error::{Error::Msg, MsgExt, Result};

pub const AK: &str = "ak";
pub const SK: &str = "sk";
/// 内核 serve 的端口与服务密码，App 重启后可以接管还活着的实例
pub const ENDPOINT: &str = "endpoint";

/// 本机未签名的 dev 二进制走钥匙串会写进 data-protection keychain、回读即 NoEntry，
/// 所以统一用 0600 文件，与内核自己存 cli.env 的做法一致。
pub fn set(account: &str, value: &str) -> Result<()> {
    let path = store_dir()?.join(account);
    let mut f = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .msg(format!("无法写入 {}", path.display()))?;
    f.write_all(value.as_bytes())?;
    f.flush()?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

pub fn get(account: &str) -> Result<Option<String>> {
    match fs::read_to_string(store_dir()?.join(account)) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Msg(format!("读取凭据失败：{e}"))),
    }
}

pub fn remove(account: &str) -> Result<()> {
    let path = store_dir()?.join(account);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Msg(format!("删除凭据失败：{e}"))),
    }
}

fn store_dir() -> Result<PathBuf> {
    let home = std::env::var("HOME")
        .msg("无法解析 HOME")?;
    let dir = PathBuf::from(home)
        .join("Library/Application Support")
        .join("com.wuchengchao.codeartsdesktop")
        .join("secrets");
    fs::create_dir_all(&dir).msg(format!("无法创建 {}", dir.display()))?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    Ok(dir)
}
