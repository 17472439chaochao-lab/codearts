//! 会话导出：把前端拼好的 Markdown 落到用户选的路径。
//!
//! 这条路走的是系统保存对话框给出的绝对路径，不在工作区里，所以不能用 files.rs 的
//! 工作区 jail；换来的是两个更硬的前置条件：必须是绝对路径，且只写文本、只写这一份。

use std::path::{Path, PathBuf};

use crate::error::{Error, MsgExt, Result};

/// 一段会话的 Markdown 正常是几十到几百 KB；给到 8MB 已经远超需要，防的是误传大对象
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// 返回实际落盘的绝对路径，前端拿它弹提示
#[tauri::command]
pub fn export_write(path: String, content: String) -> Result<String> {
    write_export(Path::new(path.trim()), &content).map(|p| p.display().to_string())
}

fn write_export(path: &Path, content: &str) -> Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(Error::Msg("导出路径为空".into()));
    }
    if !path.is_absolute() {
        return Err(Error::Msg("导出路径必须是绝对路径".into()));
    }
    // 不允许拿它去写目录；同名目录存在时 rename 会失败，提前给一句人话
    if path.is_dir() {
        return Err(Error::Msg(format!("{} 是个目录，换个文件名", path.display())));
    }
    if content.len() > MAX_BYTES {
        return Err(Error::Msg(format!(
            "导出内容 {} MB，超过 {} MB 上限",
            content.len() / 1024 / 1024,
            MAX_BYTES / 1024 / 1024
        )));
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| Error::Msg("导出路径缺少所在目录".into()))?;
    std::fs::create_dir_all(dir).msg(format!("无法创建目录 {}", dir.display()))?;
    // 与配置写入同一套做法：先落临时文件再原子替换，中途失败不会留下半份导出
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension()
            .map(|e| e.to_string_lossy().into_owned())
            .unwrap_or_else(|| "txt".into())
    ));
    std::fs::write(&tmp, content).msg(format!("写入 {} 失败", tmp.display()))?;
    std::fs::rename(&tmp, path).msg(format!("保存 {} 失败", path.display()))?;
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codearts-export-{}-{}-{}",
            tag,
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_absolute_paths_and_creates_missing_parents() {
        let dir = temp_dir("ok");
        let target = dir.join("nested").join("会话.md");
        let out = write_export(&target, "# 标题\n正文\n").unwrap();
        assert_eq!(out, target);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "# 标题\n正文\n");
        // 临时文件不能留在用户目录里
        let leftovers: Vec<_> = std::fs::read_dir(target.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不该留下临时文件：{leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_relative_dir_and_oversized_payloads() {
        assert!(write_export(Path::new("rel.md"), "x").is_err());
        assert!(write_export(Path::new(""), "x").is_err());
        let dir = temp_dir("bad");
        assert!(write_export(&dir, "x").is_err(), "目标是目录时应拒绝");
        let big = "a".repeat(MAX_BYTES + 1);
        assert!(write_export(&dir.join("big.md"), &big).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
