use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, MsgExt, Result};

/// 可持久化的非敏感配置。密钥一律走 Keychain，不落这个文件。
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
        std::fs::write(&path, serde_json::to_string_pretty(self).unwrap())
            .msg("写入配置失败")
    }

    pub fn kernel_home(&self) -> PathBuf {
        match &self.kernel_home {
            Some(p) if !p.is_empty() => PathBuf::from(p),
            _ => std::env::var("HOME").map(PathBuf::from).unwrap_or_default(),
        }
    }

    pub fn kernel_bin(&self) -> Result<PathBuf> {
        if let Some(p) = &self.kernel_bin {
            if !p.is_empty() {
                let path = PathBuf::from(p);
                if path.exists() {
                    return Ok(path);
                }
                return Err(Error::Msg(format!("配置的内核路径不存在：{}", path.display())));
            }
        }
        discover_kernel_bin(&self.kernel_home()).ok_or_else(|| {
            Error::Msg("未找到 codearts 内核，请在设置里填写 installers/bin/codearts 的绝对路径".into())
        })
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

/// 先认配置/环境的 HOME，再兜一遍本机其它用户目录：桌面应用被别的产品进程拉起时
/// 拿到的 HOME 未必是登录用户的那个，只扫 $HOME 会误报"没装内核"。
fn discover_kernel_bin(home: &Path) -> Option<PathBuf> {
    let in_home = home.join(KERNEL_REL_PATH);
    if in_home.is_file() {
        return Some(in_home);
    }
    let users = Path::new("/Users");
    let entries = std::fs::read_dir(users).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(KERNEL_REL_PATH);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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
