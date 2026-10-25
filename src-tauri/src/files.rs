use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};

use base64::Engine as _;
use serde::Serialize;

use crate::error::{Error, MsgExt, Result};
use crate::settings::Settings;

/// 首页资源管理器一层最多列这么多条：node_modules 这种目录不该一次全塞给 WebView
const MAX_ENTRIES: usize = 4000;
/// 预览上限。再大的文件给壳子渲染只会卡住界面，截断并明确告知
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
/// 图片预览上限。图片要 base64 后整串过 IPC，比文本贵得多，再大就把 WebView 拖住；
/// 超过这个尺寸只报类型和大小，不转 data URL
const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const BINARY_PROBE: usize = 8192;
/// 认图片格式只需要文件头这几个字节
const SNIFF_BYTES: u64 = 16;
/// VCS 元数据和系统垃圾文件不进树；其余一律照常展示
const SKIP_NAMES: &[&str] = &[".git", ".DS_Store"];
/// 「计划」页签一次最多列这么多份，防止某个大目录里的 plans 把列表刷爆
const MAX_PLANS: usize = 200;
/// 壳子代内核落盘的计划正文上限：真计划是万字级，超过这个尺寸的多半是模型跑飞了
const MAX_PLAN_BYTES: usize = 512 * 1024;
const MAX_PLAN_STEM_CHARS: usize = 48;
/// 找技能自建 plans 目录时最多访问多少个目录：大 monorepo 里不能无边递归
const MAX_SCAN_DIRS: usize = 1500;
/// 扫描结果缓存时长：够挡住 agent 干活时的连环刷新，又不至于让新建目录久久不出现
const SCAN_TTL: Duration = Duration::from_secs(20);
/// 明显不会有计划的构建产物/依赖目录，遍历时直接跳过
const NO_SCAN_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "venv",
    "__pycache__",
    "coverage",
    "Pods",
    "obj",
];

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
    /// 二进制与图片为 None；GBK 等非 UTF-8 文本会转成 UTF-8 后返回
    content: Option<String>,
    binary: bool,
    truncated: bool,
    size: u64,
    mtime: u64,
    /// 图片按 `data:<mime>;base64,...` 回传，界面直接塞进 <img>；文本文件为 None
    data_url: Option<String>,
    /// 文件头认出来的图片类型。体积超限时 data_url 为空但这里仍有值，界面据此说清原因
    mime: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    name: String,
    path: String,
    /// workspace = 工作区内的 .codeartsdoer/plans（兼容 .opencode/plans）；
    /// kernel = 内核数据目录或家目录下的 plans；
    /// project = 工作区里技能自己建的 plans 目录（如 docs/superpowers/plans）
    source: String,
    size: u64,
    mtime: u64,
}

type PlanRoot = (&'static str, PathBuf);

#[tauri::command]
pub fn files_list(
    app: tauri::AppHandle,
    rel: Option<String>,
    directory: Option<String>,
) -> Result<FileList> {
    let settings = Settings::load(&app)?;
    let root = workspace_root(&settings, directory.as_deref())?;
    list(&root, rel.as_deref().unwrap_or(""))
}

#[tauri::command]
pub fn file_read(
    app: tauri::AppHandle,
    rel: String,
    directory: Option<String>,
) -> Result<FileContent> {
    let settings = Settings::load(&app)?;
    let root = workspace_root(&settings, directory.as_deref())?;
    read(&root, &rel)
}

#[tauri::command]
pub fn plans_list(app: tauri::AppHandle, directory: Option<String>) -> Result<Vec<PlanEntry>> {
    let settings = Settings::load(&app)?;
    let root = workspace_root(&settings, directory.as_deref())?;
    Ok(collect_plans(&plan_roots_cached(&settings, Some(&root))))
}

#[tauri::command]
pub fn plan_read(
    app: tauri::AppHandle,
    path: String,
    directory: Option<String>,
) -> Result<FileContent> {
    let settings = Settings::load(&app)?;
    let root = workspace_root(&settings, directory.as_deref())?;
    read_plan(&plan_roots(&settings, Some(&root)), &path)
}

/// 把规划模式的计划正文落盘，返回绝对路径。
/// 内核的 plan agent 只把计划当聊天文本输出、从不写文件（实测 26.9.26 一整轮只有
/// read/bash/grep/question），「计划」页签因此永远为空，这里代它写一次。
/// 同一个会话（按创建时间认）只有一份文件，且只留最完整的那版正文。
#[tauri::command]
pub fn plan_save(
    app: tauri::AppHandle,
    directory: Option<String>,
    title: String,
    created: u64,
    content: String,
) -> Result<String> {
    let settings = Settings::load(&app)?;
    let root = workspace_root(&settings, directory.as_deref())?;
    save_plan(&settings, &root, &title, created, &content)
}

/// 资源管理器读哪个工作区：不带 `directory` 时用落盘的当前区；点开别的区的会话时前端显式带上那个区，
/// 否则会出现"翻着 A 区的会话、树里是 B 区的文件"。这个参数来自 WebView，所以只放行
/// settings 里登记过的工作区，不能拿它去读任意路径。
pub(crate) fn workspace_root(settings: &Settings, directory: Option<&str>) -> Result<PathBuf> {
    let Some(raw) = directory.map(str::trim).filter(|s| !s.is_empty()) else {
        return settings.project_dir();
    };
    let want = Path::new(raw)
        .canonicalize()
        .map_err(|_| Error::Msg(format!("目录不存在：{raw}")))?;
    let mut known: Vec<PathBuf> = settings
        .projects
        .iter()
        .flatten()
        .filter_map(|p| Path::new(p).canonicalize().ok())
        .collect();
    known.extend(settings.project_dir().ok());
    if !known.iter().any(|p| *p == want) {
        return Err(Error::Msg("这个目录不在已添加的工作区里".into()));
    }
    Ok(want)
}

/// 内核规划模式的落盘路径（`Session.plan()`）：有 git 时 `<worktree>/.opencode/plans/<创建时间>-<slug>.md`，
/// 没有 git 时 `<内核数据目录>/plans/…`。`.codeartsdoer/plans` 是 team-planner 子代理的模板路径，一并兜上；
/// 工作区里技能自建的 plans 目录再按目录名收进来。
/// 符号链接解析后必须仍落在仓库或数据目录内，否则丢掉这个根。
fn plan_roots(settings: &Settings, workspace: Option<&Path>) -> Vec<PlanRoot> {
    plan_roots_with(settings, workspace, false)
}

/// `plans_list` 走缓存版：agent 干活时前端每几秒就会来问一次，
/// 每次都从工作区根重扫一遍的话，开着「计划」页签等于持续跑一遍 find。
fn plan_roots_cached(settings: &Settings, workspace: Option<&Path>) -> Vec<PlanRoot> {
    plan_roots_with(settings, workspace, true)
}

fn plan_roots_with(settings: &Settings, workspace: Option<&Path>, cached: bool) -> Vec<PlanRoot> {
    let mut roots = Vec::new();
    // 跨区会话要看的是那个区自己的计划，不是一律跟着落盘的当前区
    if let Some(project) = workspace.map(PathBuf::from).or(settings.project_dir().ok()) {
        // 内核把计划写在 git worktree 根上；在工作区子目录里打开时也要能找到
        let base = project
            .ancestors()
            .find(|p| p.join(".git").exists())
            .unwrap_or(project.as_path())
            .to_path_buf();
        for rel in [".codeartsdoer/plans", ".opencode/plans"] {
            let logical = base.join(rel);
            if let Some(root) = contained_plan_root(&logical, &base) {
                roots.push(("workspace", root));
            }
        }
        // 技能（如 writing-plans）把计划写在工作区自己的 plans 目录，内核不知道这些路径
        let dirs = if cached {
            project_plan_dirs_cached(&project)
        } else {
            let mut dirs = Vec::new();
            let mut budget = MAX_SCAN_DIRS;
            project_plan_dirs(&project, &project, 0, &mut dirs, &mut budget);
            dirs
        };
        roots.extend(dirs.into_iter().map(|dir| ("project", dir)));
    }
    // `{{.codeartsdoer}}` 也可能落到用户目录；CLI 在非仓库目录会用它
    let home = settings.kernel_home();
    let logical = home.join(".codeartsdoer").join("plans");
    if let Some(root) = contained_plan_root(&logical, &home) {
        roots.push(("kernel", root));
    }
    let data = settings.kernel_data_dir();
    let logical = data.join("plans");
    if let Some(root) = contained_plan_root(&logical, &data) {
        roots.push(("kernel", root));
    }
    roots
}

/// 工作区里名叫 `plans` 的目录（技能写的计划）。不跟符号链接，只在工程根内找。
fn project_plan_dirs(
    jail: &Path,
    dir: &Path,
    depth: usize,
    out: &mut Vec<PathBuf>,
    budget: &mut usize,
) {
    const MAX_DEPTH: usize = 4;
    const MAX_DIRS: usize = 20;
    if depth > MAX_DEPTH || out.len() >= MAX_DIRS || *budget == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    *budget -= 1;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        if name == "plans" {
            if let Some(root) = contained_plan_root(&entry.path(), jail) {
                out.push(root);
            }
            continue;
        }
        if name.starts_with('.') || NO_SCAN_DIRS.contains(&name.as_str()) {
            continue;
        }
        project_plan_dirs(jail, &entry.path(), depth + 1, out, budget);
    }
}

/// 只按 20 秒一次的真实扫描算：agent 跑起来后 `file.edited` 会让前端反复来要清单
fn project_plan_dirs_cached(project: &Path) -> Vec<PathBuf> {
    if let Ok(map) = scan_cache().lock() {
        if let Some((at, dirs)) = map.get(project) {
            if at.elapsed() < SCAN_TTL {
                return dirs.clone();
            }
        }
    }
    let mut dirs = Vec::new();
    let mut budget = MAX_SCAN_DIRS;
    project_plan_dirs(project, project, 0, &mut dirs, &mut budget);
    if let Ok(mut map) = scan_cache().lock() {
        // 工作区数量有上限，攒到一定规模就整表清掉，不必做 LRU
        if map.len() > 64 {
            map.clear();
        }
        map.insert(project.to_path_buf(), (Instant::now(), dirs.clone()));
    }
    dirs
}

fn scan_cache() -> &'static Mutex<HashMap<PathBuf, (Instant, Vec<PathBuf>)>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (Instant, Vec<PathBuf>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
        walk_plans(&root, &root, 0, source, &mut plans, &mut seen);
    }
    plans.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| a.name.cmp(&b.name)));
    plans.truncate(MAX_PLANS);
    plans
}

/// 计划是一个功能一个目录，最多再向下找几层，避免把整个工作区扫一遍
fn walk_plans(
    root: &Path,
    dir: &Path,
    depth: usize,
    source: &str,
    plans: &mut Vec<PlanEntry>,
    seen: &mut HashSet<PathBuf>,
) {
    const MAX_DEPTH: usize = 3;
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            if depth < MAX_DEPTH && !name.starts_with('.') {
                walk_plans(root, &path, depth + 1, source, plans, seen);
            }
            continue;
        }
        if !name.ends_with(".md") {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let Ok(path) = path.canonicalize() else { continue };
        // 符号链接指回另一个计划根时只列一次
        if !path.starts_with(root) || !seen.insert(path.clone()) {
            continue;
        }
        plans.push(PlanEntry {
            name,
            path: path.display().to_string(),
            source: source.to_string(),
            size: md.len(),
            mtime: mtime_of(&md),
        });
    }
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

/// 壳子代内核写计划用哪个目录：跟 `plan_roots` 认的两个内核落盘根保持一致，
/// 写完 `plans_list` 才认、`plan_read` 才读得回来。返回 (越界检查的 jail, 计划目录)。
fn plan_write_root(settings: &Settings, workspace: &Path) -> (PathBuf, PathBuf) {
    match workspace.ancestors().find(|p| p.join(".git").exists()) {
        Some(base) => (base.to_path_buf(), base.join(".opencode").join("plans")),
        None => {
            let data = settings.kernel_data_dir();
            (data.clone(), data.join("plans"))
        }
    }
}

/// 会话标题当文件名，「计划」页签上才有可读的条目；分隔符和控制字符换成 `-`，过长的截断。
fn plan_stem(title: &str) -> String {
    let mut out = String::new();
    for ch in title.trim().chars() {
        if out.chars().count() >= MAX_PLAN_STEM_CHARS {
            break;
        }
        match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '.' => out.push('-'),
            c if c.is_control() => out.push('-'),
            c => out.push(c),
        }
    }
    let cleaned = out
        .split('-')
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if cleaned.is_empty() {
        "plan".to_string()
    } else {
        cleaned
    }
}

/// 同一会话的自动改名不能各存一份：先按 `<创建时间>-` 前缀找回已有文件名。
fn existing_plan_name(dir: &Path, created: u64) -> Option<String> {
    let prefix = format!("{created}-");
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n.starts_with(&prefix) && n.ends_with(".md"))
}

fn save_plan(
    settings: &Settings,
    workspace: &Path,
    title: &str,
    created: u64,
    content: &str,
) -> Result<String> {
    let body = content.trim();
    if body.is_empty() {
        return Err(Error::Msg("计划正文为空，未保存".into()));
    }
    if body.len() > MAX_PLAN_BYTES {
        return Err(Error::Msg(format!(
            "计划正文 {} 字节，超过 {} 字节的保存上限",
            body.len(),
            MAX_PLAN_BYTES
        )));
    }
    if created == 0 {
        return Err(Error::Msg("缺少会话创建时间".into()));
    }
    let (jail, dir) = plan_write_root(settings, workspace);
    if contained_plan_root(&dir, &jail).is_none() {
        return Err(Error::Msg("计划目录被符号链接指向了工作区外".into()));
    }
    let name = existing_plan_name(&dir, created)
        .unwrap_or_else(|| format!("{created}-{}.md", plan_stem(title)));
    let logical = dir.join(&name);
    // 目录或同名文件被换成链出 jail 的符号链接时，这里再拒一次
    if contained_plan_root(&logical, &jail).is_none() {
        return Err(Error::Msg("计划文件路径越界".into()));
    }
    let title = title.trim();
    let heading = if title.is_empty() {
        "计划".to_string()
    } else {
        format!("# {title}")
    };
    let doc = if body.starts_with("# ") {
        body.to_string()
    } else {
        format!("{heading}\n\n{body}\n")
    };
    std::fs::create_dir_all(&dir).msg("无法创建计划目录")?;
    // 一个会话一份计划、只留最完整的那版：后面「计划无需改动」这类短回复不能把长计划冲掉
    if let Ok(old) = std::fs::read_to_string(&logical) {
        if old == doc || old.chars().count() > doc.chars().count() {
            return Ok(logical.display().to_string());
        }
    }
    std::fs::write(&logical, &doc).msg("计划写入失败")?;
    Ok(logical.display().to_string())
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

/// 写路径的越界检查：与 `resolve` 同一套规则，但允许目标文件还不存在
/// （"还原为改动前"要能把新增文件删掉、把删掉的文件写回来）。
/// 关键是父目录必须 canonicalize 后仍落在工作区里，且最后一段只能是普通文件名，
/// 这样 `../`、绝对路径、以及指向工作区外的符号链接目录都过不去。
fn resolve_write(root: &Path, rel: &str) -> Result<PathBuf> {
    let root = root.canonicalize().msg("工作区不存在")?;
    if rel.starts_with(['/', '\\']) {
        return Err(Error::Msg("只接受工作区内的相对路径".into()));
    }
    let rel_path = Path::new(rel);
    let comps: Vec<Component> = rel_path.components().collect();
    let Some(Component::Normal(name)) = comps.last() else {
        return Err(Error::Msg("非法路径".into()));
    };
    if comps
        .iter()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(Error::Msg("非法路径".into()));
    }
    let parent = rel_path.parent().unwrap_or(Path::new(""));
    let parent_abs = root.join(parent).canonicalize().msg("上级目录不存在")?;
    if !parent_abs.starts_with(&root) {
        return Err(Error::Msg("路径越界".into()));
    }
    let target = parent_abs.join(name);
    // 目标已存在时再核一次：文件本身可能是链到工作区外的符号链接
    if target.exists() {
        let real = target.canonicalize().msg("路径不存在")?;
        if !real.starts_with(&root) {
            return Err(Error::Msg("路径越界".into()));
        }
    }
    Ok(target)
}

/// 工作区里最大能还原的文件：diff 的 before 全文来自内核，超过这个尺寸的多半不是文本
const MAX_RESTORE_BYTES: usize = 8 * 1024 * 1024;

/// 把某个文件还原成改动前的样子。`content` 为 None 表示这份文件在改动前根本不存在
/// （diff 的 status = added），还原就等于删掉它。
#[tauri::command]
pub fn file_restore(
    app: tauri::AppHandle,
    rel: String,
    content: Option<String>,
    directory: Option<String>,
) -> Result<String> {
    let settings = Settings::load(&app)?;
    let root = workspace_root(&settings, directory.as_deref())?;
    restore(&root, &rel, content.as_deref())
}

fn restore(root: &Path, rel: &str, content: Option<&str>) -> Result<String> {
    let target = resolve_write(root, rel)?;
    match content {
        None => {
            if target.exists() {
                std::fs::remove_file(&target).msg("删除文件失败")?;
                Ok(format!("已删除 {}", rel))
            } else {
                Ok(format!("{rel} 本来就不存在"))
            }
        }
        Some(text) => {
            if text.len() > MAX_RESTORE_BYTES {
                return Err(Error::Msg(format!(
                    "还原内容 {} MB，超过 {} MB 上限",
                    text.len() / 1024 / 1024,
                    MAX_RESTORE_BYTES / 1024 / 1024
                )));
            }
            // 先落临时文件再原子替换：写到一半失败不会留下半个文件
            let tmp = target.with_extension("codearts-restore.tmp");
            std::fs::write(&tmp, text).msg("写入还原内容失败")?;
            std::fs::rename(&tmp, &target).msg("还原文件失败")?;
            Ok(format!("已还原 {}", rel))
        }
    }
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
    let mut file = std::fs::File::open(path)?;
    // 图片按文件头认，不看扩展名：改过后缀的图、没后缀的截图都得能看
    let mut head = Vec::with_capacity(SNIFF_BYTES as usize);
    file.by_ref()
        .take(SNIFF_BYTES)
        .read_to_end(&mut head)?;
    if let Some(mime) = image_mime(&head) {
        return read_image(&mut file, mime, &md);
    }
    file.seek(SeekFrom::Start(0))?;
    let mut buf = Vec::new();
    file.take(MAX_TEXT_BYTES as u64 + 1).read_to_end(&mut buf)?;
    let truncated = buf.len() > MAX_TEXT_BYTES;
    if truncated {
        buf.truncate(MAX_TEXT_BYTES);
    }
    let binary = looks_binary(&buf);
    Ok(FileContent {
        content: (!binary).then(|| decode_text(&buf)),
        binary,
        truncated,
        size: md.len(),
        mtime: mtime_of(&md),
        data_url: None,
        mime: None,
    })
}

/// 图片走 data URL：WebView 不能读 file://，base64 是唯一不用起本地服务就能显示的路径
fn read_image(
    file: &mut std::fs::File,
    mime: &str,
    md: &std::fs::Metadata,
) -> Result<FileContent> {
    let size = md.len();
    let too_big = size > MAX_IMAGE_BYTES;
    let data_url = if too_big {
        None
    } else {
        file.seek(SeekFrom::Start(0))?;
        let mut buf = Vec::with_capacity(size as usize);
        file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut buf)?;
        Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&buf)
        ))
    };
    Ok(FileContent {
        content: None,
        binary: true,
        truncated: too_big,
        size,
        mtime: mtime_of(md),
        data_url,
        mime: Some(mime.to_string()),
    })
}

/// 只认文件头一眼能确定的位图格式。SVG 本身是文本，照旧按源码预览
fn image_mime(head: &[u8]) -> Option<&'static str> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if head.starts_with(PNG) {
        return Some("image/png");
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if head.len() >= 12 {
        // WebP 是 RIFF 容器，`WEBP` 在偏移 8；HEIC/AVIF 是 ISO BMFF，品牌在偏移 8
        if head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
            return Some("image/webp");
        }
        if &head[4..8] == b"ftyp" {
            match &head[8..12] {
                b"avif" | b"avis" => return Some("image/avif"),
                b"heic" | b"heix" | b"hevc" | b"mif1" | b"msf1" => return Some("image/heic"),
                _ => {}
            }
        }
    }
    if head.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if head.starts_with(b"II*\0") || head.starts_with(b"MM\0*") {
        return Some("image/tiff");
    }
    if head.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    None
}

/// 二进制判定只看控制字符：NUL 或 0x00–0x08 / 0x0E–0x1F 占超过 2%。
/// 不再要求"必须是合法 UTF-8"——GBK 的中文一个字节都不是合法 UTF-8，老项目会被整片误判成二进制。
fn looks_binary(buf: &[u8]) -> bool {
    let probe = &buf[..buf.len().min(BINARY_PROBE)];
    if probe.contains(&0) {
        return true;
    }
    let ctrl = probe
        .iter()
        .filter(|b| **b < 0x09 || (**b > 0x0d && **b < 0x20))
        .count();
    ctrl * 50 > probe.len()
}

/// UTF-8 优先，不是 UTF-8 就当 GB18030（兼容 GBK/GB2312）解。
/// 解码失败仍返回替换字符版：调用方已经排除了二进制，给原文总比给一片问号强。
fn decode_text(buf: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(buf) {
        return s.trim_start_matches('\u{feff}').to_string();
    }
    let (text, _, _) = encoding_rs::GB18030.decode(buf);
    text.trim_start_matches('\u{feff}').to_string()
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

    /// 图片以前被 looks_binary 判成二进制（PNG 文件头里就有 NUL），预览只剩一行提示。
    /// 现在按文件头认格式并以 data URL 回传；文本文件仍走原来的文本分支。
    #[test]
    fn reads_images_as_data_urls_and_text_as_text() {
        let root = TempRoot::new();
        // 1x1 透明 PNG 的头部：够让嗅探认出来，不需要真能解码
        const PNG: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H',
            b'D', b'R',
        ];
        std::fs::write(root.0.join("shot.png"), PNG).unwrap();
        let png = read(&root.0, "shot.png").unwrap();
        assert_eq!(png.mime.as_deref(), Some("image/png"));
        assert!(png
            .data_url
            .as_deref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(png.content.is_none() && png.binary && !png.truncated);

        // 回传的字节必须和磁盘上一模一样，否则 <img> 只会显示裂图
        use base64::Engine as _;
        let payload = png.data_url.as_deref().unwrap().split(",").nth(1).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(payload).unwrap(),
            PNG
        );

        // 没有扩展名的截图照样认得出
        std::fs::write(root.0.join("screenshot"), PNG).unwrap();
        assert_eq!(
            read(&root.0, "screenshot").unwrap().mime.as_deref(),
            Some("image/png")
        );

        // JPEG 走另一条分支，确认不是只有 PNG 能过
        std::fs::write(
            root.0.join("a.jpg"),
            [0xFFu8, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F'],
        )
        .unwrap();
        assert_eq!(read(&root.0, "a.jpg").unwrap().mime.as_deref(), Some("image/jpeg"));

        // 文本文件不能被当成图片
        std::fs::write(root.0.join("notes.md"), "# 标题\n").unwrap();
        let txt = read(&root.0, "notes.md").unwrap();
        assert!(txt.mime.is_none() && txt.data_url.is_none());
        assert_eq!(txt.content.as_deref(), Some("# 标题\n"));
    }

    #[test]
    fn sniffs_common_bitmaps_and_leaves_other_formats_alone() {
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(image_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_mime(b"BM6\0\0\0"), Some("image/bmp"));
        assert_eq!(image_mime(b"\0\0\0\x1aftypheic"), Some("image/heic"));
        // 拿不准的一律不认：PDF / ZIP / 空文件交给 looks_binary 走原来的路
        assert_eq!(image_mime(b"%PDF-1.7"), None);
        assert_eq!(image_mime(b"PK\x03\x04"), None);
        assert_eq!(image_mime(b""), None);
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

    /// 还原是唯一一条"壳子替用户写盘"的路，越界检查必须和读路径同一套：
    /// 相对路径 + 父目录归属校验，新增文件（还不存在）也要走通。
    #[test]
    fn restore_writes_inside_jail_only() {
        let root = TempRoot::new();
        let outside = TempRoot::new();
        std::fs::create_dir_all(root.0.join("src")).unwrap();
        std::fs::write(root.0.join("src/a.rs"), "改后的内容\n").unwrap();

        // 有内容 = 写回改动前的版本
        restore(&root.0, "src/a.rs", Some("改前\n")).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.0.join("src/a.rs")).unwrap(),
            "改前\n"
        );

        // 新增文件的还原 = 删掉它
        std::fs::write(root.0.join("src/new.rs"), "x\n").unwrap();
        restore(&root.0, "src/new.rs", None).unwrap();
        assert!(!root.0.join("src/new.rs").exists());

        // 删掉的文件可以写回来（父目录仍在）
        restore(&root.0, "src/back.rs", Some("回来了\n")).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.0.join("src/back.rs")).unwrap(),
            "回来了\n"
        );

        // 越界一律拒绝
        assert!(restore(&root.0, "../escape.rs", Some("x")).is_err());
        assert!(restore(&root.0, "/tmp/abs.rs", Some("x")).is_err());
        assert!(restore(&root.0, "src/../../escape.rs", Some("x")).is_err());
        assert!(restore(&root.0, "missing-dir/a.rs", Some("x")).is_err());

        // 指向工作区外的符号链接目录不能被当成合法父目录
        std::os::unix::fs::symlink(&outside.0, root.0.join("link")).unwrap();
        assert!(restore(&root.0, "link/a.rs", Some("x")).is_err());
        assert!(!outside.0.join("a.rs").exists());
    }

    #[test]
    fn workspace_root_only_accepts_registered_workspaces() {
        let base = TempRoot::new();
        let mut dirs = vec![];
        for name in ["a", "b", "stray"] {
            let d = base.0.join(name);
            std::fs::create_dir_all(&d).unwrap();
            dirs.push(d);
        }
        let (a, b, stray) = (&dirs[0], &dirs[1], &dirs[2]);

        let mut settings = Settings::default();
        settings.project_dir = Some(a.display().to_string());
        settings.projects = Some(vec![a.display().to_string(), b.display().to_string()]);

        assert_eq!(workspace_root(&settings, None).unwrap(), settings.project_dir().unwrap());
        assert_eq!(
            workspace_root(&settings, Some(&b.display().to_string())).unwrap(),
            b.canonicalize().unwrap()
        );
        // 空串按"没带参数"处理，仍然回当前区
        assert_eq!(workspace_root(&settings, Some("  ")).unwrap(), settings.project_dir().unwrap());
        assert!(workspace_root(&settings, Some(&stray.display().to_string())).is_err());
        assert!(workspace_root(&settings, Some("/tmp")).is_err());
        assert!(workspace_root(&settings, Some("/no/such/dir")).is_err());
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {        let root = TempRoot::new();
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
    fn reads_gbk_text_instead_of_calling_it_binary() {
        let root = TempRoot::new();
        // 「中文测试」的 GBK 编码：旧实现按"合法 UTF-8"判定，会把整片老项目当成二进制
        let gbk: [u8; 8] = [0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4];
        std::fs::write(root.0.join("gbk.txt"), gbk).unwrap();
        let f = read(&root.0, "gbk.txt").unwrap();
        assert!(!f.binary, "GBK 文本不该被判成二进制");
        assert_eq!(f.content.as_deref(), Some("中文测试"));
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

        let roots = plan_roots(&settings, None);
        assert_eq!(roots[0].1, repo.join(".codeartsdoer").join("plans"));
        assert_eq!(roots[1].1, repo.join(".opencode").join("plans"));
        assert_eq!(roots[2].1, root.0.join(".codeartsdoer").join("plans"));
        assert_eq!(
            roots[3].1,
            root.0.join(".codeartsdoer").join("cli-data").join("plans")
        );
    }

    #[test]
    fn lists_and_reads_only_plan_markdown() {
        let root = TempRoot::new();
        let plans = root.0.join("plans");
        std::fs::create_dir_all(plans.join("old.md")).unwrap();
        std::fs::write(plans.join("1760000000000-first-plan.md"), "# 计划\n").unwrap();
        std::fs::create_dir_all(plans.join("auth-refactor")).unwrap();
        std::fs::write(plans.join("auth-refactor").join("plan.md"), "# 认证重构\n").unwrap();
        std::fs::write(plans.join("notes.txt"), "x").unwrap();

        let roots = vec![("kernel", plans.clone())];
        let listed = collect_plans(&roots);
        assert_eq!(listed.len(), 2);
        let first = listed.iter().find(|p| p.name.ends_with("first-plan.md")).unwrap();
        assert_eq!(first.source, "kernel");
        assert_eq!(
            read_plan(&roots, &first.path).unwrap().content.as_deref(),
            Some("# 计划\n")
        );
        let nested = listed.iter().find(|p| p.path.contains("auth-refactor")).unwrap();
        assert_eq!(
            read_plan(&roots, &nested.path).unwrap().content.as_deref(),
            Some("# 认证重构\n")
        );

        let outside = root.0.join("outside.md");
        std::fs::write(&outside, "no").unwrap();
        assert!(read_plan(&roots, &outside.display().to_string()).is_err());
        assert!(read_plan(&roots, &plans.join("notes.txt").display().to_string()).is_err());
    }

    #[test]
    fn picks_up_skill_plan_dirs_inside_the_workspace() {
        let root = TempRoot::new();
        let project = root.0.join("proj");
        std::fs::create_dir_all(project.join("docs/superpowers/plans")).unwrap();
        std::fs::write(
            project.join("docs/superpowers/plans/2026-10-19-role-mutex.md"),
            "# 互斥\n",
        )
        .unwrap();
        std::fs::create_dir_all(project.join("node_modules/pkg/plans")).unwrap();
        std::fs::write(project.join("node_modules/pkg/plans/dep.md"), "# no\n").unwrap();

        let mut settings = Settings::default();
        settings.project_dir = Some(project.display().to_string());
        settings.kernel_home = Some(root.0.display().to_string());

        let roots = plan_roots(&settings, None);
        let listed = collect_plans(&roots);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].source, "project");
        assert_eq!(
            read_plan(&roots, &listed[0].path)
                .unwrap()
                .content
                .as_deref(),
            Some("# 互斥\n")
        );
    }

    #[test]
    fn saves_plan_where_the_kernel_would_and_lists_it() {
        let root = TempRoot::new();
        let repo = root.0.join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("sub")).unwrap();

        let mut settings = Settings::default();
        settings.kernel_home = Some(root.0.display().to_string());

        let saved =
            save_plan(&settings, &repo.join("sub"), "商品接入计划", 1760000000000, "## 目标\n先同步 SPU").unwrap();
        assert_eq!(
            saved,
            repo.join(".opencode/plans/1760000000000-商品接入计划.md")
                .display()
                .to_string()
        );

        let roots = plan_roots(&settings, Some(&repo.join("sub")));
        let listed = collect_plans(&roots);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].source, "workspace");
        // 列表与预览走的是同一条校验链：写完立刻能读
        assert_eq!(
            read_plan(&roots, &saved).unwrap().content.as_deref(),
            Some("# 商品接入计划\n\n## 目标\n先同步 SPU\n")
        );
    }

    #[test]
    fn keeps_one_plan_file_per_session_when_the_title_changes() {
        let root = TempRoot::new();
        let project = root.0.join("plain");
        std::fs::create_dir_all(&project).unwrap();
        let mut settings = Settings::default();
        settings.kernel_home = Some(root.0.display().to_string());

        let first = save_plan(&settings, &project, "旧标题", 1760000000001, "长计划").unwrap();
        let second = save_plan(&settings, &project, "自动改名后的标题", 1760000000001, "更长的计划").unwrap();
        assert_eq!(first, second);
        // 文件名认会话（前缀复用），正文里的标题跟着会话改名走
        assert_eq!(
            std::fs::read_to_string(&second).unwrap(),
            "# 自动改名后的标题\n\n更长的计划\n"
        );
        // 短回复不覆盖长计划：规划轮后面那句「计划无需改动」也会在 idle 时送来
        let shorter = save_plan(&settings, &project, "确认", 1760000000001, "计划无需改动").unwrap();
        assert_eq!(shorter, second);
        assert_eq!(
            std::fs::read_to_string(&shorter).unwrap(),
            "# 自动改名后的标题\n\n更长的计划\n"
        );
        // 非 git 工作区落内核数据目录；plan_roots 里登记的是 canonicalize 后的真实路径
        let roots = plan_roots(&settings, Some(&project));
        assert!(roots
            .iter()
            .any(|(_, p)| p == &root.0.canonicalize().unwrap().join(".codeartsdoer").join("cli-data").join("plans")));
        assert_eq!(collect_plans(&roots).len(), 1);

        assert!(save_plan(&settings, &project, "空", 1760000000002, "   ").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_save_through_an_escaped_plan_directory() {
        let root = TempRoot::new();
        let outside = TempRoot::new();
        let project = root.0.join("plain");
        std::fs::create_dir_all(&project).unwrap();
        let data = root.0.join(".codeartsdoer").join("cli-data");
        std::fs::create_dir_all(&data).unwrap();
        std::os::unix::fs::symlink(&outside.0, data.join("plans")).unwrap();

        let mut settings = Settings::default();
        settings.kernel_home = Some(root.0.display().to_string());
        assert!(save_plan(&settings, &project, "外逃", 1760000000003, "正文").is_err());
        assert!(std::fs::read_dir(&outside.0).unwrap().next().is_none());
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
        let roots = plan_roots(&settings, None);
        assert!(roots.iter().all(|(_, p)| p != &data.join("plans") && !p.starts_with(&outside.0)));
        assert!(collect_plans(&roots).is_empty() || collect_plans(&roots).iter().all(|p| !p.path.contains("leak")));
    }
}
