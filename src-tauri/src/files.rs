use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{Error, MsgExt, Result};
use crate::settings::Settings;

/// 首页资源管理器一层最多列这么多条：node_modules 这种目录不该一次全塞给 WebView
const MAX_ENTRIES: usize = 4000;
/// 预览上限。再大的文件给壳子渲染只会卡住界面，截断并明确告知
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const BINARY_PROBE: usize = 8192;
/// VCS 元数据和系统垃圾文件不进树；其余一律照常展示
const SKIP_NAMES: &[&str] = &[".git", ".DS_Store"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    name: String,
    /// 相对工作区根目录，始终用 `/` 分隔
    path: String,
    dir: bool,
    size: u64,
    mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    entries: Vec<FileEntry>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    /// 二进制/非 UTF-8 文件为 None
    content: Option<String>,
    binary: bool,
    truncated: bool,
    size: u64,
    mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    name: String,
    path: String,
    /// workspace = 工作区内 .opencode/plans；kernel = 内核数据目录（非 Git 工作区）
    source: String,
    size: u64,
    mtime: u64,
}

type PlanRoot = (&'static str, PathBuf);

#[tauri::command]
pub fn files_list(app: tauri::AppHandle, rel: Option<String>) -> Result<FileList> {
    let root = Settings::load(&app)?.project_dir()?;
    list(&root, rel.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn file_read(app: tauri::AppHandle, rel: String) -> Result<FileContent> {
    let root = Settings::load(&app)?.project_dir()?;
    read(&root, &rel)
}

#[tauri::command]
pub fn plans_list(app: tauri::AppHandle) -> Result<Vec<PlanEntry>> {
    let roots = plan_roots(&Settings::load(&app)?);
    Ok(collect_plans(&roots))
}

#[tauri::command]
pub fn plan_read(app: tauri::AppHandle, path: String) -> Result<FileContent> {
    let roots = plan_roots(&Settings::load(&app)?);
    read_plan(&roots, &path)
}

/// 内核把计划写在仓库的 `.opencode/plans`；非 Git 工作区则写进数据目录的 `plans`。
/// 符号链接解析后必须仍落在仓库或数据目录内，否则丢掉这个根。
fn plan_roots(settings: &Settings) -> Vec<PlanRoot> {
    let mut roots = Vec::new();
    if let Ok(project) = settings.project_dir() {
        // 内核把计划写在 git worktree 根上；在工作区子目录里打开时也要能找到
        let base = project
            .ancestors()
            .find(|p| p.join(".git").exists())
            .unwrap_or(project.as_path())
            .to_path_buf();
        let logical = base.join(".opencode").join("plans");
        if let Some(root) = contained_plan_root(&logical, &base) {
            roots.push(("workspace", root));
        }
    }
    let data = settings.kernel_data_dir();
    let logical = data.join("plans");
    if let Some(root) = contained_plan_root(&logical, &data) {
        roots.push(("kernel", root));
    }
    roots
}

/// 目录还不存在时，只要已存在的祖先没有链出 jail，就保留逻辑路径。
fn contained_plan_root(logical: &Path, jail: &Path) -> Option<PathBuf> {
    if !logical.starts_with(jail) {
        return None;
    }
    let mut cur = logical.to_path_buf();
    loop {
        if let Ok(real) = cur.canonicalize() {
            if let Ok(jail_real) = jail.canonicalize() {
                if !real.starts_with(&jail_real) {
                    return None;
                }
                return Some(if logical.exists() {
                    real
                } else {
                    logical.to_path_buf()
                });
            }
            // jail 尚未创建：现存祖先必须是它的词法前缀
            return jail.starts_with(&cur).then(|| logical.to_path_buf());
        }
        if !cur.pop() {
            return None;
        }
    }
}

fn collect_plans(roots: &[PlanRoot]) -> Vec<PlanEntry> {
    let mut plans = Vec::new();
    let mut seen = HashSet::new();
    for (source, root) in roots {
        let Ok(root) = root.canonicalize() else { continue };
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".md") {
                continue;
            }
            let Ok(md) = entry.metadata() else { continue };
            if !md.is_file() {
                continue;
            }
            let Ok(path) = entry.path().canonicalize() else { continue };
            // 符号链接指回另一个计划根时只列一次
            if !path.starts_with(&root) || !seen.insert(path.clone()) {
                continue;
            }
            plans.push(PlanEntry {
                name,
                path: path.display().to_string(),
                source: (*source).to_string(),
                size: md.len(),
                mtime: mtime_of(&md),
            });
        }
    }
    plans.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.name.cmp(&b.name)));
    plans
}

fn read_plan(roots: &[PlanRoot], path: &str) -> Result<FileContent> {
    let target = PathBuf::from(path).canonicalize().msg("计划文件不存在")?;
    if target.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err(Error::Msg("计划文件必须是 Markdown".into()));
    }
    let inside = roots.iter().any(|(_, root)| {
        root.canonicalize()
            .map(|r| target.starts_with(r))
            .unwrap_or(false)
    });
    if !inside {
        return Err(Error::Msg("不属于计划目录".into()));
    }
    read_at(&target)
}

/// 前端传入的是相对路径；绝对路径、`..`、盘符一律拒绝。
/// 再加一道 canonicalize 归属检查，防住指向工作区外的符号链接。
fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let root = root.canonicalize().msg("工作区不存在")?;
    if rel.starts_with(['/', '\\']) {
        return Err(Error::Msg("只接受工作区内的相对路径".into()));
    }
    let rel_path = Path::new(rel);
    if rel_path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(Error::Msg("非法路径".into()));
    }
    let target = root.join(rel_path).canonicalize().msg("路径不存在")?;
    if !target.starts_with(&root) {
        return Err(Error::Msg("路径越界".into()));
    }
    Ok(target)
}

fn list(root: &Path, rel: &str) -> Result<FileList> {
    let dir = resolve(root, rel)?;
    if !dir.is_dir() {
        return Err(Error::Msg("不是目录".into()));
    }
    let parent = rel.trim_matches('/');
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP_NAMES.contains(&name.as_str()) {
            continue;
        }
        // metadata 跟随符号链接：指向文件的链接照样能打开，越界读取仍由 resolve 拦
        let Ok(md) = entry.metadata() else { continue };
        let path = if parent.is_empty() {
            name.clone()
        } else {
            format!("{parent}/{name}")
        };
        entries.push(FileEntry {
            name,
            path,
            dir: md.is_dir(),
            size: if md.is_file() { md.len() } else { 0 },
            mtime: mtime_of(&md),
        });
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
    }
    // 目录在前，同类按名字排；read_dir 的顺序在 macOS 上不稳定
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(FileList { entries, truncated })
}

fn read(root: &Path, rel: &str) -> Result<FileContent> {
    read_at(&resolve(root, rel)?)
}

fn read_at(path: &Path) -> Result<FileContent> {
    let md = std::fs::metadata(path)?;
    if md.is_dir() {
        return Err(Error::Msg("这是一个目录".into()));
    }
    let mut buf = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_TEXT_BYTES as u64 + 1)
        .read_to_end(&mut buf)?;
    let truncated = buf.len() > MAX_TEXT_BYTES;
    if truncated {
        buf.truncate(MAX_TEXT_BYTES);
    }
    let binary = looks_binary(&buf);
    Ok(FileContent {
        content: (!binary).then(|| String::from_utf8_lossy(&buf).into_owned()),
        binary,
        truncated,
        size: md.len(),
        mtime: mtime_of(&md),
    })
}

fn looks_binary(buf: &[u8]) -> bool {
    let probe = &buf[..buf.len().min(BINARY_PROBE)];
    if probe.contains(&0) {
        return true;
    }
    match std::str::from_utf8(probe) {
        Ok(_) => false,
        // 探测窗口刚好切在多字节字符中间不算二进制
        Err(e) => e.error_len().is_some() || e.valid_up_to() + 4 < probe.len(),
    }
}

fn mtime_of(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "codearts-files-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_dirs_first_and_skips_vcs_metadata() {
        let root = TempRoot::new();
        std::fs::create_dir(root.0.join("src")).unwrap();
        std::fs::write(root.0.join("README.md"), "hello").unwrap();
        std::fs::create_dir(root.0.join(".git")).unwrap();
        std::fs::write(root.0.join(".DS_Store"), "x").unwrap();

        let listed = list(&root.0, "").unwrap();
        let names: Vec<_> = listed.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "README.md"]);
        assert!(listed.entries[0].dir);
        assert!(!listed.truncated);

        std::fs::write(root.0.join("src/main.rs"), "fn main() {}").unwrap();
        let nested = list(&root.0, "src").unwrap();
        assert_eq!(nested.entries[0].path, "src/main.rs");
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        let root = TempRoot::new();
        assert!(list(&root.0, "../").is_err());
        assert!(read(&root.0, "/etc/hosts").is_err());
        assert!(list(&root.0, "src/../../").is_err());
    }

    #[test]
    fn reads_text_and_flags_binary() {
        let root = TempRoot::new();
        std::fs::write(root.0.join("a.txt"), "你好\nworld").unwrap();
        let text = read(&root.0, "a.txt").unwrap();
        assert_eq!(text.content.as_deref(), Some("你好\nworld"));
        assert!(!text.binary);
        assert_eq!(text.size, "你好\nworld".len() as u64);

        std::fs::write(root.0.join("a.bin"), [0u8, 1, 2, 3]).unwrap();
        let bin = read(&root.0, "a.bin").unwrap();
        assert!(bin.binary);
        assert!(bin.content.is_none());
    }

    #[test]
    fn plan_root_follows_git_worktree() {
        let root = TempRoot::new();
        let repo = root.0.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("sub")).unwrap();

        let mut settings = Settings::default();
        settings.project_dir = Some(repo.join("sub").display().to_string());
        settings.kernel_home = Some(root.0.display().to_string());

        let roots = plan_roots(&settings);
        assert_eq!(roots[0].1, repo.join(".opencode").join("plans"));
        assert_eq!(
            roots[1].1,
            root.0.join(".codeartsdoer").join("cli-data").join("plans")
        );
    }

    #[test]
    fn lists_and_reads_only_plan_markdown() {
        let root = TempRoot::new();
        let plans = root.0.join("plans");
        std::fs::create_dir_all(plans.join("old.md")).unwrap();
        std::fs::write(plans.join("1760000000000-first-plan.md"), "# 计划\n").unwrap();
        std::fs::write(plans.join("notes.txt"), "x").unwrap();

        let roots = vec![("kernel", plans.clone())];
        let listed = collect_plans(&roots);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "1760000000000-first-plan.md");
        assert_eq!(listed[0].source, "kernel");
        assert_eq!(
            read_plan(&roots, &listed[0].path).unwrap().content.as_deref(),
            Some("# 计划\n")
        );

        let outside = root.0.join("outside.md");
        std::fs::write(&outside, "no").unwrap();
        assert!(read_plan(&roots, &outside.display().to_string()).is_err());
        assert!(read_plan(&roots, &plans.join("notes.txt").display().to_string()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn blocks_symlink_escape() {
        let root = TempRoot::new();
        let outside = TempRoot::new();
        std::fs::write(outside.0.join("secret.txt"), "nope").unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret.txt"), root.0.join("link.txt")).unwrap();
        assert!(read(&root.0, "link.txt").is_err());

        std::os::unix::fs::symlink(&outside.0, root.0.join("outdir")).unwrap();
        assert!(list(&root.0, "outdir").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn plan_root_rejects_symlink_escape() {
        let root = TempRoot::new();
        let outside = TempRoot::new();
        std::fs::create_dir_all(outside.0.join("plans")).unwrap();
        std::fs::write(outside.0.join("plans").join("leak.md"), "# x\n").unwrap();
        let data = root.0.join(".codeartsdoer").join("cli-data");
        std::fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(outside.0.join("plans"), data.join("plans")).unwrap();

        let mut settings = Settings::default();
        settings.kernel_home = Some(root.0.display().to_string());
        let roots = plan_roots(&settings);
        assert!(roots.iter().all(|(_, p)| p != &data.join("plans") && !p.starts_with(&outside.0)));
        assert!(collect_plans(&roots).is_empty() || collect_plans(&roots).iter().all(|p| !p.path.contains("leak")));
    }
}
