use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, MsgExt, Result};

/// 可持久化的非敏感配置。密钥不落这个文件（走 secrets 模块的 0600 文件）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// 内核进程的 HOME，决定 cli-data / settings.json 落在哪
    pub kernel_home: Option<String>,
    /// codearts 可执行文件路径，留空则自动探测
    pub kernel_bin: Option<String>,
    /// 当前项目目录，serve 的 cwd，必须进信任白名单
    pub project_dir: Option<String>,
    /// 工作区列表，最近使用的排最前；`project_dir` 一定是其中的某一项
    pub projects: Option<Vec<String>>,
}

impl Settings {
    pub fn load(app: &tauri::AppHandle) -> Result<Self> {
        let path = config_path(app)?;
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(&path)?;
        serde_json::from_str(&text).msg("配置文件损坏")
    }

    pub fn save(&self, app: &tauri::AppHandle) -> Result<()> {
        let path = config_path(app)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // 写到一半崩溃不能把原配置卷了：先落临时文件再原子替换
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self).unwrap())
            .msg("写入配置失败")?;
        std::fs::rename(&tmp, &path).msg("写入配置失败")
    }

    pub fn kernel_home(&self) -> PathBuf {
        match &self.kernel_home {
            Some(p) if !p.is_empty() => PathBuf::from(p),
            // 优先落在真正装了码道的那份家目录（passwd），不被污染的 $HOME 带偏
            _ => preferred_home(),
        }
    }

    pub fn kernel_bin(&self) -> Result<PathBuf> {
        // 配置里的路径只在它落在已探测到的官方安装位置时才采用
        if let Some(p) = &self.kernel_bin {
            if !p.is_empty() {
                if let Some(found) = discover_kernel_bin() {
                    if paths_same(Path::new(p), &found) {
                        return Ok(found);
                    }
                }
            }
        }
        discover_kernel_bin()
            .ok_or_else(|| Error::Msg("未找到 codearts 内核：请先安装码道 CLI".into()))
    }

    /// 内核的数据目录，信任白名单 settings.json 就在这里
    pub fn kernel_data_dir(&self) -> PathBuf {
        self.kernel_home().join(".codeartsdoer").join("cli-data")
    }

    pub fn project_dir(&self) -> Result<PathBuf> {
        let p = self
            .project_dir
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::Msg("尚未选择项目目录".into()))?;
        let path = PathBuf::from(p);
        if path.is_dir() {
            Ok(path)
        } else {
            Err(Error::Msg(format!("项目目录不存在：{}", path.display())))
        }
    }
}

/// 先认 passwd / `$HOME`，再扫 `/Users` 下各账号的官方安装路径。
/// 桌面端被 FlyEnv 等拉起时 `$HOME` 常不是装 CLI 的那个用户。
fn discover_kernel_bin() -> Option<PathBuf> {
    for home in candidate_homes() {
        let candidate = home.join(KERNEL_REL_PATH);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// passwd → `$HOME` → `/Users/*`（去重，排序保证可复现）。
fn candidate_homes() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut push = |p: PathBuf| {
        if p.as_os_str().is_empty() {
            return;
        }
        if !out.iter().any(|x| x == &p) {
            out.push(p);
        }
    };
    if let Some(h) = passwd_home() {
        push(h);
    }
    if let Ok(h) = std::env::var("HOME") {
        push(PathBuf::from(h));
    }
    if let Ok(entries) = std::fs::read_dir("/Users") {
        let mut users: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        users.sort();
        for home in users {
            if home.is_dir() {
                push(home);
            }
        }
    }
    out
}

fn preferred_home() -> PathBuf {
    // 与二进制探测同一顺序：谁家有 codearts / .codeartsdoer 就用谁
    for home in candidate_homes() {
        if home.join(KERNEL_REL_PATH).is_file() || home.join(".codeartsdoer").is_dir() {
            return home;
        }
    }
    candidate_homes().into_iter().next().unwrap_or_default()
}

fn passwd_home() -> Option<PathBuf> {
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() {
            return None;
        }
        let dir = std::ffi::CStr::from_ptr((*pw).pw_dir);
        let s = dir.to_str().ok()?;
        if s.is_empty() {
            return None;
        }
        Some(PathBuf::from(s))
    }
}

fn paths_same(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// 码道 CLI 官方安装脚本的落地位置，相对各用户 HOME
const KERNEL_REL_PATH: &str = ".codeartsdoer/installers/bin/codearts";

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .msg("无法解析应用配置目录")?;
    Ok(dir.join("settings.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_cli_under_users() {
        let homes = candidate_homes();
        assert!(homes.iter().any(|h| h.starts_with("/Users")), "应包含 /Users 扫描");
        if homes.iter().any(|h| h.join(KERNEL_REL_PATH).is_file()) {
            let found = discover_kernel_bin().expect("本机已安装的 CLI 应被扫到");
            assert!(found.ends_with(KERNEL_REL_PATH));
        }
    }
}
