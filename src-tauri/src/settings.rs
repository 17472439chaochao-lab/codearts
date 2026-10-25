use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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
    /// 有会话在跑时阻止电脑休眠。Option 是故意的：界面多处 `settings_save` 只带自己要改的字段，
    /// 缺省必须解释成"这次没说"，否则切个工作区就把用户开的断言关掉了。
    pub keep_awake: Option<bool>,
    /// 点红叉是收进托盘还是退出。缺省（None）按 false 处理，保持「关窗即退出」的老行为。
    pub close_to_tray: Option<bool>,
}

/// 缓存项：同一份路径 + 同一个 mtime 就算命中。
/// 只用 mtime 而不是「保存后自己更缓存」单条路，是因为用户可能在终端里手改配置，
/// 外部改写后文件必然刷新 mtime，命中判断自然失效。
struct CacheEntry {
    path: PathBuf,
    mtime: Option<SystemTime>,
    settings: Settings,
}

/// 一次会话里设置文件会被反复读（文件树展开、会话忙轮询、每轮 SSE 收尾都碰），
/// 缓存把这段重复 IO + 解析压掉；配置很小，存一份克隆比每次重读便宜得多。
static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

impl Settings {
    pub fn load(app: &tauri::AppHandle) -> Result<Self> {
        load_at(&config_path(app)?)
    }

    pub fn save(&self, app: &tauri::AppHandle) -> Result<()> {
        save_at(&config_path(app)?, self)
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

/// mtime 读不到（文件不存在/被删）时返回 None，此时缓存一律不命中
fn mtime_of(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn load_at(path: &Path) -> Result<Settings> {
    let mtime = mtime_of(path);
    if let Some(hit) = cache_hit(path, mtime) {
        return Ok(hit);
    }
    if !path.exists() {
        // 没有文件就是默认值；不写缓存，免得用户刚点保存就被这份空配置盖掉
        return Ok(Settings::default());
    }
    let text = std::fs::read_to_string(path)?;
    match serde_json::from_str::<Settings>(&text) {
        Ok(s) => {
            // 解析成功才进缓存：写坏的配置每次都要走一遍备份逻辑，不能缓存成正常值
            store(path, mtime, &s);
            Ok(s)
        }
        // 配置写坏不该让整个壳卡在检测页：原文件留一份备份，先按默认值跑起来，
        // 用户下次保存就会写回一份干净的
        Err(e) => {
            match backup_corrupt(path) {
                Ok(dst) => eprintln!("配置文件损坏，已备份到 {}（{e}）", dst.display()),
                Err(err) => eprintln!("配置文件损坏且备份失败（{err}）：{e}"),
            }
            Ok(Settings::default())
        }
    }
}

fn save_at(path: &Path, settings: &Settings) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // 写到一半崩溃不能把原配置卷了：先落临时文件再原子替换
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(settings).unwrap())
        .msg("写入配置失败")?;
    std::fs::rename(&tmp, path).msg("写入配置失败")?;
    // 落盘后立刻刷新缓存：rename 之后 mtime 一定变了，不主动更新会让下一次 load 白读一遍
    store(path, mtime_of(path), settings);
    Ok(())
}

fn cache_hit(path: &Path, mtime: Option<SystemTime>) -> Option<Settings> {
    let guard = CACHE.lock().ok()?;
    let entry = guard.as_ref()?;
    if entry.path == path && entry.mtime.is_some() && entry.mtime == mtime {
        return Some(entry.settings.clone());
    }
    None
}

fn store(path: &Path, mtime: Option<SystemTime>, settings: &Settings) {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(CacheEntry {
            path: path.to_path_buf(),
            mtime,
            settings: settings.clone(),
        });
    }
}

/// 测试用：把模块级缓存清空，避免用例之间互相污染
#[cfg(test)]
fn clear_cache() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

/// 把写坏的配置挪到 `settings.corrupt-<时间戳>.json`，不覆盖已有备份
fn backup_corrupt(path: &Path) -> std::io::Result<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut dst = path.with_extension(format!("corrupt-{stamp}.json"));
    let mut n = 1;
    while dst.exists() {
        dst = path.with_extension(format!("corrupt-{stamp}-{n}.json"));
        n += 1;
    }
    std::fs::rename(path, &dst)?;
    Ok(dst)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codearts-settings-{}-{}-{}",
            tag,
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn discovers_cli_under_users() {
        let homes = candidate_homes();
        assert!(homes.iter().any(|h| h.starts_with("/Users")), "应包含 /Users 扫描");
        if homes.iter().any(|h| h.join(KERNEL_REL_PATH).is_file()) {
            let found = discover_kernel_bin().expect("本机已安装的 CLI 应被扫到");
            assert!(found.ends_with(KERNEL_REL_PATH));
        }
    }

    /// 缓存的契约：同一份文件重复读只解析一次，但外部改写（mtime 变了）必须立刻看到新值，
    /// 自己保存过的值也不能被旧缓存盖回去。
    #[test]
    fn cache_follows_mtime_and_own_saves() {
        clear_cache();
        let dir = temp_dir("cache");
        let path = dir.join("settings.json");

        let first = Settings {
            close_to_tray: Some(true),
            project_dir: Some("/tmp/a".into()),
            ..Default::default()
        };
        save_at(&path, &first).unwrap();

        let hit = load_at(&path).unwrap();
        assert_eq!(hit.close_to_tray, Some(true));
        assert_eq!(hit.project_dir.as_deref(), Some("/tmp/a"));

        // 外部把文件改成另一份内容：mtime 变了，缓存必须失效
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, r#"{"keepAwake":true}"#).unwrap();
        let external = load_at(&path).unwrap();
        assert_eq!(external.keep_awake, Some(true), "外部改写后不该命中旧缓存");
        assert_eq!(external.close_to_tray, None);

        // 再走自己的 save：新值立刻可读
        let next = Settings {
            keep_awake: Some(false),
            ..Default::default()
        };
        save_at(&path, &next).unwrap();
        assert_eq!(load_at(&path).unwrap().keep_awake, Some(false));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 文件不存在时给默认值；写坏的文件要备份成 corrupt-*，并且不把默认值塞进缓存
    #[test]
    fn missing_and_corrupt_files_fall_back_to_defaults() {
        clear_cache();
        let dir = temp_dir("corrupt");
        let path = dir.join("settings.json");
        assert_eq!(load_at(&path).unwrap().close_to_tray, None);

        std::fs::write(&path, "{ this is not json").unwrap();
        let fallback = load_at(&path).unwrap();
        assert_eq!(fallback.project_dir, None);
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("corrupt"))
            .collect();
        assert_eq!(backups.len(), 1, "损坏的配置应留一份备份：{backups:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
