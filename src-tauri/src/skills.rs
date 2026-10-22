//! 技能安装：把 GitHub 上的技能包解压进内核的技能目录。
//!
//! 内核读 `<项目根>/.codeartsdoer/skills/<name>/SKILL.md`（用户级 `<HOME>/.codeartsdoer/skills` 同构），
//! 但实测 26.9.26 的 serve 只在实例启动时扫描：运行中新写文件等 60s 也不进 `/skill`，
//! 所以装完要由前端调一次 `POST /cag/instance/reload?directory=` 让实例重载。
//! `GET /v1/skills?reload=true` 只刷它自己的那份目录，`/skill` 看不到新技能，替代不了实例重载。
//! 本应用装过的技能记在同级的 `skill-manager.json`，更新/卸载只按这份清单动手。
//! 安装一律走用户级（全局），作用域不给界面选。

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use tar::Archive;

use crate::error::{Error, MsgExt, Result};
use crate::settings::Settings;

/// GitHub 压缩包上限：技能包正常只有几 MB，超了就是拿错了仓库
const MAX_ARCHIVE_BYTES: usize = 48 * 1024 * 1024;
const MAX_ENTRIES: usize = 5000;
const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_BUNDLE_FILES: usize = 200;
const MAX_BUNDLE_BYTES: usize = 8 * 1024 * 1024;
/// 2026-10-19 实测：`jnMetaCode/superpowers-zh` 一个仓库就有 21 个技能，20 会正好卡住正经的技能包
const MAX_BUNDLES: usize = 64;
const SKILL_MD: &str = "SKILL.md";

/// 一次安装的返回值，前端按这几个数组分别提示
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub installed: Vec<String>,
    pub conflicts: Vec<String>,
    pub invalid: Vec<String>,
    pub removed: Vec<String>,
    pub root: String,
    pub message: String,
}

/// 清单里的一条：记来源，更新时原样回抓
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ManagedSkill {
    pub name: String,
    /// 给用户看的原样来源，如 `owner/repo/skills/foo@v1`
    pub source: String,
    /// `owner/repo`
    pub repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    pub installed_at: u64,
    pub updated_at: u64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Manifest {
    version: u32,
    skills: BTreeMap<String, ManagedSkill>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedView {
    pub project: Vec<ManagedSkill>,
    pub user: Vec<ManagedSkill>,
    pub project_root: String,
    pub user_root: String,
}

#[derive(Debug, Clone, PartialEq)]
struct Scope {
    dot: PathBuf,
}

impl Scope {
    fn skills_dir(&self) -> PathBuf {
        self.dot.join("skills")
    }

    fn manifest_file(&self) -> PathBuf {
        self.dot.join("skill-manager.json")
    }
}

/// 只接受两个已知作用域，路径一律由 Settings 推导，WebView 传不进目录
fn scope_of(settings: &Settings, scope: &str) -> Result<Scope> {
    match scope.trim().to_ascii_lowercase().as_str() {
        "project" | "" => {
            let project = settings.project_dir()?;
            // 内核按实例目录解析 `.codeartsdoer`，也就是 git worktree 根；子目录里打开时同一套规则
            let base = project
                .ancestors()
                .find(|p| p.join(".git").exists())
                .unwrap_or(project.as_path())
                .to_path_buf();
            Ok(Scope { dot: base.join(".codeartsdoer") })
        }
        "user" => Ok(Scope {
            dot: settings.kernel_home().join(".codeartsdoer"),
        }),
        other => Err(Error::Msg(format!("未知作用域：{other}"))),
    }
}

#[derive(Debug, PartialEq)]
pub struct Source {
    /// `owner/repo`
    repo: String,
    /// 仓库内子路径，不含首尾斜杠
    sub: Option<String>,
    /// 分支 / tag / commit，缺省 HEAD（codeload 认这个 ref）
    reference: String,
    display: String,
}

impl Source {
    fn tarball(&self) -> String {
        format!(
            "https://codeload.github.com/{}/tar.gz/{}",
            self.repo, self.reference
        )
    }
}

/// 支持 `owner/repo`、`owner/repo/sub/path`、`@tag`，以及直接粘贴仓库链接。
/// 只认 github.com：换主机意味着把下载指向任意地址，代理层的信任边界不该由输入框决定。
pub fn parse_source(input: &str) -> Result<Source> {
    let raw = input.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err(Error::Msg(
            "技能来源不能为空，例如 owner/repo 或 owner/repo@v1".into(),
        ));
    }
    let text = raw.strip_prefix("git@github.com:").unwrap_or(raw);
    let text = {
        let no_scheme = text
            .strip_prefix("https://")
            .or_else(|| text.strip_prefix("http://"))
            .unwrap_or(text);
        match no_scheme.strip_prefix("github.com/") {
            Some(tail) if tail.contains('/') => tail,
            Some(_) => return Err(Error::Msg("GitHub 链接缺仓库名".into())),
            None if no_scheme.contains("://") => {
                return Err(Error::Msg("第一版只支持 github.com".into()))
            }
            None => no_scheme,
        }
    };

    let (coords, reference) = match text.rsplit_once('@') {
        Some((coords, r)) if !r.is_empty() && !coords.is_empty() => (coords, Some(r)),
        Some(_) => return Err(Error::Msg("技能来源格式不对".into())),
        None => (text, None),
    };

    let mut segs = coords.split('/').filter(|s| !s.is_empty());
    let need = || Error::Msg("技能来源至少要有 owner/repo".into());
    let owner = segs.next().ok_or_else(need)?;
    let repo = segs.next().ok_or_else(need)?;
    // owner 不含点：`gitlab.com/foo/bar` 这种粘贴写法要挡掉，否则会被当成 owner 放进来
    if owner.is_empty()
        || owner.len() > 100
        || !owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || owner.starts_with('-')
        || owner.ends_with('-')
    {
        return Err(Error::Msg(format!("不是合法的 GitHub owner：{owner}")));
    }
    check_segment(repo.trim_end_matches(".git"))?;
    let repo = format!("{owner}/{}", repo.trim_end_matches(".git"));

    // 粘贴链接常见 `/tree/<ref>/<sub>`：ref 取一段，剩下的当子路径
    let mut segs: Vec<&str> = segs.collect();
    let mut reference = reference.map(|r| r.to_string());
    if reference.is_none()
        && matches!(segs.first(), Some(&"tree") | Some(&"blob"))
        && segs.len() > 2
    {
        reference = Some(segs[1].to_string());
        segs = segs[2..].to_vec();
    }
    for s in &segs {
        check_segment(s)?;
    }
    let sub = if segs.is_empty() {
        None
    } else {
        Some(segs.join("/"))
    };
    let reference = match reference {
        Some(r) => {
            check_reference(&r)?;
            r
        }
        None => "HEAD".to_string(),
    };
    let display = format!(
        "{repo}{}{}",
        sub.as_deref().map(|s| format!("/{s}")).unwrap_or_default(),
        if reference == "HEAD" { String::new() } else { format!("@{reference}") }
    );
    Ok(Source {
        repo,
        sub,
        reference,
        display,
    })
}

fn check_segment(s: &str) -> Result<()> {
    let ok = !s.is_empty()
        && s.len() <= 100
        && !s.starts_with('.')
        && s != ".."
        && s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(Error::Msg(format!("技能来源里有非法片段：{s}")))
    }
}

fn check_reference(r: &str) -> Result<()> {
    let ok = !r.is_empty()
        && r.len() <= 120
        && !r.starts_with('-')
        && !r.contains("..")
        && !r.contains("//")
        && r.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'));
    if ok {
        Ok(())
    } else {
        Err(Error::Msg(format!("分支或标签名不合法：{r}")))
    }
}

/// 解压后的文件树：键是剥掉压缩包根目录（和子路径）之后的相对路径
type Tree = BTreeMap<String, Vec<u8>>;

#[derive(Debug)]
struct Bundle {
    name: String,
    files: Vec<(String, Vec<u8>)>,
}

/// codeload 的包顶层固定是 `<repo>-<ref>/`，剥掉它；符号链接、硬链接、非常规条目直接丢
fn strip_root(path: &Path, sub: Option<&str>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
            Component::CurDir => {}
            // 绝对路径、`..`、盘符：宁可丢条目也不落盘
            _ => return None,
        }
    }
    if parts.len() < 2 {
        return None;
    }
    let mut rest: Vec<String> = parts[1..].to_vec();
    if let Some(s) = sub {
        let want: Vec<&str> = s.split('/').filter(|x| !x.is_empty()).collect();
        if rest.len() <= want.len()
            || !rest[..want.len()].iter().map(|p| p.as_str()).eq(want.iter().copied())
        {
            return None;
        }
        rest = rest[want.len()..].to_vec();
    }
    Some(rest.join("/"))
}

fn unpack(bytes: &[u8], sub: Option<&str>) -> Result<Tree> {
    let gz = GzDecoder::new(std::io::Cursor::new(bytes));
    let mut ar = Archive::new(gz);
    let mut out: Tree = BTreeMap::new();
    let mut count = 0usize;
    let mut total = 0usize;
    for entry in ar.entries().msg("压缩包读不出来（应为 tar.gz）")? {
        let mut entry = entry.msg("压缩包条目损坏")?;
        // 只落地普通文件：链接会被后面的写入拼到目录外，目录由父路径自动建
        if !entry.header().entry_type().is_file() {
            continue;
        }
        count += 1;
        if count > MAX_ENTRIES {
            return Err(Error::Msg(format!("压缩包文件数超过 {MAX_ENTRIES}")));
        }
        let p = entry.path().msg("压缩包里有非法路径")?.into_owned();
        let Some(rel) = strip_root(&p, sub) else { continue };
        let mut buf = Vec::new();
        entry
            .by_ref()
            .take((MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut buf)?;
        if buf.len() > MAX_FILE_BYTES {
            return Err(Error::Msg(format!(
                "{rel} 单文件超过 {} MiB",
                MAX_FILE_BYTES / 1024 / 1024
            )));
        }
        total += buf.len();
        if total > MAX_BUNDLE_BYTES * 4 {
            return Err(Error::Msg("技能包内容过大".into()));
        }
        out.insert(rel, buf);
    }
    Ok(out)
}

/// 约定只有两种：仓库（或子路径）根上就是一份 SKILL.md，或者技能放在 `skills/<name>/`、`<name>/`
fn classify(tree: &Tree) -> Result<Vec<Bundle>> {
    if tree.contains_key(SKILL_MD) {
        return Ok(vec![bundle(tree, "")?]);
    }
    let mut prefixes: BTreeSet<String> = BTreeSet::new();
    for key in tree.keys() {
        let segs: Vec<&str> = key.split('/').collect();
        let prefix = match segs.as_slice() {
            [first, second, ..] if *first == "skills" && segs.len() >= 3 => {
                format!("skills/{second}/")
            }
            [first, _, ..] if !first.starts_with('.') && *first != "node_modules" => {
                format!("{first}/")
            }
            _ => continue,
        };
        if tree.contains_key(&format!("{prefix}SKILL.md")) {
            prefixes.insert(prefix);
        }
    }
    let mut bundles = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for prefix in prefixes {
        let b = bundle(tree, &prefix)?;
        // 两份 SKILL.md 自称同一个 name：装第一份，其余报给用户，不做静默覆盖
        if seen.insert(b.name.clone()) {
            bundles.push(b);
        }
    }
    if bundles.is_empty() {
        return Err(Error::Msg(
            "没找到 SKILL.md：技能要么在仓库根目录，要么放在 skills/<名称>/ 下".into(),
        ));
    }
    if bundles.len() > MAX_BUNDLES {
        return Err(Error::Msg(format!(
            "这个仓库有 {} 个技能，一次最多装 {MAX_BUNDLES} 个；想少装几个就填 owner/repo/skills/名称 指名单个技能",
            bundles.len()
        )));
    }
    Ok(bundles)
}

fn bundle(tree: &Tree, prefix: &str) -> Result<Bundle> {
    let md = tree
        .get(&format!("{prefix}SKILL.md"))
        .ok_or_else(|| Error::Msg(format!("{prefix}SKILL.md 缺失")))?;
    let name = frontmatter_name(md).ok_or_else(|| {
        Error::Msg(format!(
            "{prefix}SKILL.md 的 frontmatter 不合格：需要 kebab-case 的 name 和非空 description"
        ))
    })?;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total = 0usize;
    for (key, bytes) in tree.iter().filter(|(k, _)| k.starts_with(prefix)) {
        let rel = &key[prefix.len()..];
        if rel.is_empty() {
            continue;
        }
        if files.len() >= MAX_BUNDLE_FILES {
            return Err(Error::Msg(format!("{name} 文件数超过 {MAX_BUNDLE_FILES}")));
        }
        total += bytes.len();
        if total > MAX_BUNDLE_BYTES {
            return Err(Error::Msg(format!("{name} 内容过大")));
        }
        files.push((rel.to_string(), bytes.clone()));
    }
    Ok(Bundle { name, files })
}

/// 手写 frontmatter 取值：只认顶层 `key: value`，够用且不用为此引 YAML 依赖。
/// `description:` 后面换行缩进（块标量）也算有值——技能正文本来就长。
fn frontmatter_name(md: &[u8]) -> Option<String> {
    if !md.starts_with(b"---") {
        return None;
    }
    let text = String::from_utf8_lossy(&md[..md.len().min(16 * 1024)]);
    let rest = text.get(3..)?;
    let block = rest.get(..rest.find("\n---")?)?;
    let lines: Vec<&str> = block.lines().collect();
    let mut name: Option<String> = None;
    let mut has_desc = false;
    for (i, line) in lines.iter().enumerate() {
        if line.is_empty() || line.starts_with([' ', '\t', '#']) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        match key.trim() {
            "name" if name.is_none() => name = Some(value.to_string()),
            "description" => {
                has_desc = !value.is_empty()
                    || lines
                        .get(i + 1)
                        .is_some_and(|next| next.starts_with([' ', '\t']));
            }
            _ => {}
        }
    }
    let name = name?;
    if has_desc && is_kebab(&name) {
        Some(name)
    } else {
        None
    }
}

/// 内核的校验规则：`^[a-z0-9]+(-[a-z0-9]+)*$`，最长 64
fn is_kebab(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_manifest(path: &Path) -> Result<Manifest> {
    if !path.exists() {
        return Ok(Manifest::default());
    }
    let text = std::fs::read_to_string(path).msg("读取技能清单失败")?;
    serde_json::from_str(&text).msg("技能清单损坏，请检查或删除 ".to_string() + &path.display().to_string())
}

/// 写坏了不能把原清单带下水：临时文件 + rename
fn save_manifest(path: &Path, m: &Manifest) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| Error::Msg("技能清单路径异常".into()))?;
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(m).unwrap())
        .msg("写入技能清单失败")?;
    std::fs::rename(&tmp, path).msg("写入技能清单失败")
}

fn skill_dir(root: &Path, name: &str) -> Result<PathBuf> {
    if !is_kebab(name) {
        return Err(Error::Msg(format!("技能名称不合法：{name}")));
    }
    let dir = root.join(name);
    if !dir.starts_with(root) {
        return Err(Error::Msg("技能目录越界".into()));
    }
    Ok(dir)
}

/// 相对路径再次过一遍成分：压缩包里的内容不可信，即便 unpack 已经过滤过
fn safe_rel(rel: &str) -> Result<()> {
    for c in Path::new(rel).components() {
        if !matches!(c, Component::Normal(_) | Component::CurDir) {
            return Err(Error::Msg(format!("技能包里路径非法：{rel}")));
        }
    }
    Ok(())
}

#[derive(PartialEq)]
enum Mode {
    Install,
    /// 只换清单里记着的那一个
    Update,
}

fn write_bundles(scope: &Scope, source: &Source, bundles: Vec<Bundle>, mode: Mode) -> Result<Report> {
    let root = scope.skills_dir();
    std::fs::create_dir_all(&root).msg("创建技能目录失败")?;
    let mut manifest = load_manifest(&scope.manifest_file())?;
    let mut report = Report {
        root: root.display().to_string(),
        ..Default::default()
    };

    for b in bundles {
        let dest = skill_dir(&root, &b.name)?;
        if dest.exists() && mode == Mode::Install {
            report.conflicts.push(b.name);
            continue;
        }
        if mode == Mode::Update {
            let managed = manifest
                .skills
                .get(&b.name)
                .map(|m| m.repo == source.repo)
                .unwrap_or(false);
            if !managed {
                report.conflicts.push(b.name.clone());
                continue;
            }
            // 目录被手工删过时 canonicalize 会失败，那不叫异常，直接当首次写入；
            // 还在的话先确认要替换的目录确实在技能目录里
            if dest.exists() {
                let real = dest.canonicalize().msg("技能目录异常")?;
                let real_root = root.canonicalize()?;
                if !real.starts_with(&real_root) || real == real_root {
                    return Err(Error::Msg("技能目录越界".into()));
                }
            }
        }
        // 先写到同级临时目录再整体换上去：中途失败不会留下半残的技能目录
        let staging = root.join(format!(".{}.staging-{}", b.name, now_ms()));
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).msg("创建技能目录失败")?;
        let staged = (|| -> Result<()> {
            for (rel, bytes) in &b.files {
                safe_rel(rel)?;
                let target = staging.join(rel);
                if let Some(p) = target.parent() {
                    std::fs::create_dir_all(p)?;
                }
                std::fs::write(&target, bytes).msg(format!("写入 {}/{} 失败", b.name, rel))?;
            }
            Ok(())
        })();
        if let Err(e) = staged {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
        if dest.exists() {
            let trash = root.join(format!(".{}.old-{}", b.name, now_ms()));
            std::fs::rename(&dest, &trash).msg("替换旧技能失败")?;
            if let Err(e) = std::fs::rename(&staging, &dest) {
                // 新目录挂不上去就把旧的放回原处，别让用户既没新的也没旧的
                let _ = std::fs::rename(&trash, &dest);
                let _ = std::fs::remove_dir_all(&staging);
                return Err(e).msg("替换技能目录失败");
            }
            let _ = std::fs::remove_dir_all(&trash);
        } else {
            std::fs::rename(&staging, &dest).msg("落盘技能目录失败")?;
        }
        let now = now_ms();
        let entry = manifest.skills.entry(b.name.clone()).or_insert(ManagedSkill {
            name: b.name.clone(),
            source: source.display.clone(),
            repo: source.repo.clone(),
            sub: source.sub.clone(),
            reference: Some(source.reference.clone()),
            installed_at: now,
            updated_at: now,
        });
        entry.source = source.display.clone();
        entry.repo = source.repo.clone();
        entry.sub = source.sub.clone();
        entry.reference = Some(source.reference.clone());
        entry.updated_at = now;
        report.installed.push(b.name);
    }
    manifest.version = 1;
    save_manifest(&scope.manifest_file(), &manifest)?;
    report.message = summarize(&report);
    Ok(report)
}

fn summarize(r: &Report) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !r.installed.is_empty() {
        parts.push(format!("已装入 {}", r.installed.join("、")));
    }
    if !r.removed.is_empty() {
        parts.push(format!("已移除 {}", r.removed.join("、")));
    }
    if !r.conflicts.is_empty() {
        parts.push(format!("同名已存在，未覆盖：{}", r.conflicts.join("、")));
    }
    if parts.is_empty() {
        "没有可装的内容".into()
    } else {
        parts.join("；")
    }
}

async fn fetch(source: &Source) -> Result<Vec<u8>> {
    let client = reqwest::Client::builder()
        .user_agent("codearts-desktop")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()?;
    let url = source.tarball();
    let mut resp = client.get(&url).send().await.map_err(|e| {
        Error::Msg(format!(
            "抓 {url} 失败：{e}；访问 GitHub 需要代理时，请在启动应用的终端里配好 HTTPS_PROXY"
        ))
    })?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(160).collect();
        return Err(Error::Msg(format!(
            "GitHub 返回 {status}：{snippet}（仓库是否私有、分支或标签是否存在都要核对）"
        )));
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if buf.len() + chunk.len() > MAX_ARCHIVE_BYTES {
            return Err(Error::Msg(format!(
                "压缩包超过 {} MiB，换个技能目录或子路径",
                MAX_ARCHIVE_BYTES / 1024 / 1024
            )));
        }
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        return Err(Error::Msg("GitHub 返回了空压缩包".into()));
    }
    Ok(buf)
}

/// 安装只落用户级（全局）：`Settings::kernel_home()` 会自己挑装了码道的那份家目录，
/// 多用户机器不需要界面给选。更新/卸载仍按清单所在作用域动手，项目级残留也管得了。
#[tauri::command]
pub async fn skill_install_github(app: tauri::AppHandle, source: String) -> Result<Report> {
    let scope = scope_of(&Settings::load(&app)?, "user")?;
    let source = parse_source(&source)?;
    let bytes = fetch(&source).await?;
    let tree = unpack(&bytes, source.sub.as_deref())?;
    let bundles = classify(&tree)?;
    write_bundles(&scope, &source, bundles, Mode::Install)
}

/// 按清单里记录的来源回抓，只替换这一个技能
#[tauri::command]
pub async fn skill_update_github(
    app: tauri::AppHandle,
    name: String,
    scope: String,
) -> Result<Report> {
    let scope = scope_of(&Settings::load(&app)?, &scope)?;
    let manifest = load_manifest(&scope.manifest_file())?;
    let entry = manifest
        .skills
        .get(name.trim())
        .ok_or_else(|| Error::Msg("这个技能不是本应用装的，先卸载再按新来源安装".into()))?
        .clone();
    let source = Source {
        repo: entry.repo.clone(),
        sub: entry.sub.clone(),
        reference: entry.reference.clone().unwrap_or_else(|| "HEAD".into()),
        display: entry.source.clone(),
    };
    let bytes = fetch(&source).await?;
    let tree = unpack(&bytes, source.sub.as_deref())?;
    let bundles: Vec<Bundle> = classify(&tree)?
        .into_iter()
        .filter(|b| b.name == entry.name)
        .collect();
    if bundles.is_empty() {
        return Err(Error::Msg(format!(
            "{} 里已经不含 {name}，旧版本先留着没动",
            source.display
        )));
    }
    write_bundles(&scope, &source, bundles, Mode::Update)
}

#[tauri::command]
pub fn skill_uninstall(app: tauri::AppHandle, name: String, scope: String) -> Result<Report> {
    let scope = scope_of(&Settings::load(&app)?, &scope)?;
    let name = name.trim();
    let mut manifest = load_manifest(&scope.manifest_file())?;
    if manifest.skills.remove(name).is_none() {
        return Err(Error::Msg(format!(
            "{name} 不在本应用的技能清单里；确实要删就手动清理 {}",
            scope.skills_dir().display()
        )));
    }
    let root = scope.skills_dir();
    let dest = skill_dir(&root, name)?;
    // 删目录比写目录更要紧：解析后必须仍在技能目录内
    if dest.exists() {
        let real = dest.canonicalize()?;
        let real_root = root.canonicalize()?;
        if !real.starts_with(&real_root) || real == real_root {
            return Err(Error::Msg("技能目录越界，已取消删除".into()));
        }
        std::fs::remove_dir_all(&real).msg("删除技能目录失败")?;
    }
    save_manifest(&scope.manifest_file(), &manifest)?;
    let report = Report {
        removed: vec![name.to_string()],
        root: root.display().to_string(),
        message: format!("已移除 {name}"),
        ..Default::default()
    };
    Ok(report)
}

#[tauri::command]
pub fn skills_managed(app: tauri::AppHandle) -> Result<ManagedView> {
    let settings = Settings::load(&app)?;
    let rows = |scope: &str| -> (Vec<ManagedSkill>, String) {
        match scope_of(&settings, scope) {
            Ok(s) => {
                let root = s.skills_dir().display().to_string();
                let list = load_manifest(&s.manifest_file())
                    .unwrap_or_default()
                    .skills
                    .into_values()
                    .collect();
                (list, root)
            }
            Err(_) => (Vec::new(), String::new()),
        }
    };
    let (project, project_root) = rows("project");
    let (user, user_root) = rows("user");
    Ok(ManagedView {
        project,
        user,
        project_root,
        user_root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tar::{Builder, Header};

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "codearts-skills-{}-{}",
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

    /// 造一个 codeload 形状的包：顶层固定 `<repo>-<ref>/`
    fn make_tar(entries: &[(&str, &str)], root: &str) -> Vec<u8> {
        let mut ar = Builder::new(GzEncoder::new(Vec::new(), Compression::default()));
        for (path, body) in entries {
            let full = format!("{root}/{path}");
            let mut h = Header::new_gnu();
            h.set_path(&full).unwrap();
            h.set_size(body.len() as u64);
            h.set_mode(0o644);
            h.set_entry_type(tar::EntryType::Regular);
            ar.append_data(&mut h, &full, body.as_bytes()).unwrap();
        }
        // 恶意条目：包内符号链接，落盘前必须被丢掉
        let link = format!("{root}/skills/demo/link.md");
        let mut h = Header::new_gnu();
        h.set_path(&link).unwrap();
        h.set_size(0);
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_link_name("../../../../etc/passwd").unwrap();
        ar.append_data(&mut h, link.as_str(), &[][..]).unwrap();
        ar.into_inner().unwrap().finish().unwrap()
    }

    const GOOD: &str = "---\nname: commit-helper\ndescription: 帮我把改动整理成提交\n---\n\n# 用法\n";

    #[test]
    fn parses_github_sources() {
        let s = parse_source("owner/repo").unwrap();
        assert_eq!(s.tarball(), "https://codeload.github.com/owner/repo/tar.gz/HEAD");
        assert_eq!(s.display, "owner/repo");

        let s = parse_source("https://github.com/foo/bar/tree/dev/skills/x").unwrap();
        assert_eq!(s.reference, "dev");
        assert_eq!(s.sub.as_deref(), Some("skills/x"));
        assert_eq!(s.display, "foo/bar/skills/x@dev");

        let s = parse_source("foo/bar@v1.2.3").unwrap();
        assert_eq!(s.reference, "v1.2.3");

        assert!(parse_source("gitlab.com/foo/bar").is_err());
        assert!(parse_source("https://evil.com/foo/bar").is_err());
        assert!(parse_source("owner/repo/../x").is_err());
        assert!(parse_source("owner").is_err());
        assert!(parse_source("").is_err());
        assert!(parse_source("foo/bar@-bad").is_err());
    }

    #[test]
    fn reads_frontmatter_only_when_name_and_description_are_valid() {
        assert_eq!(
            frontmatter_name(GOOD.as_bytes()).as_deref(),
            Some("commit-helper")
        );
        assert!(frontmatter_name(b"---\nname: Bad_Name\ndescription: x\n---\n".as_slice()).is_none());
        assert!(frontmatter_name(b"---\nname: ok\n---\n".as_slice()).is_none());
        assert!(frontmatter_name(b"---\nname: ok\ndescription:\n---\n".as_slice()).is_none());
        assert_eq!(
            frontmatter_name("---\nname: ok\ndescription: |\n  多行\n---\n".as_bytes()).as_deref(),
            Some("ok")
        );
        // 折叠写法：值换行缩进，YAML 里合法
        assert_eq!(
            frontmatter_name("---\nname: ok\ndescription:\n  一句话说明\n---\n".as_bytes())
                .as_deref(),
            Some("ok")
        );
        // CRLF 的 SKILL.md 也认
        assert_eq!(
            frontmatter_name(b"---\r\nname: ok\r\ndescription: x\r\n---\r\n".as_slice()).as_deref(),
            Some("ok")
        );
        assert!(frontmatter_name("# 没有 frontmatter".as_bytes()).is_none());
    }

    #[test]
    fn unpack_drops_links_and_paths_outside_the_bundle() {
        let bytes = make_tar(
            &[("skills/demo/SKILL.md", GOOD), ("skills/demo/x.md", "hi")],
            "bar-HEAD",
        );
        let tree = unpack(&bytes, None).unwrap();
        assert_eq!(tree.len(), 2);
        assert!(tree.contains_key("skills/demo/SKILL.md"));
        assert!(!tree.keys().any(|k| k.contains("link")));
    }

    /// tar 的写入端自己就拒绝 `..`，所以越界只能在读取路径这一步断言
    #[test]
    fn traversal_never_reaches_the_filesystem() {
        assert_eq!(strip_root(Path::new("bar-HEAD/../escape.txt"), None), None);
        assert_eq!(strip_root(Path::new("/etc/hosts"), None), None);
        assert_eq!(strip_root(Path::new("bar-HEAD/SKILL.md"), None).as_deref(), Some("SKILL.md"));
        assert_eq!(
            strip_root(Path::new("bar-HEAD/skills/x/SKILL.md"), Some("skills")).as_deref(),
            Some("x/SKILL.md")
        );
        assert!(safe_rel("../out.md").is_err());
        assert!(safe_rel("/etc/passwd").is_err());
        assert!(safe_rel("refs/note.md").is_ok());
    }

    #[test]
    fn classifies_root_and_nested_skill_layouts() {
        // 仓库根本身就是一份技能，整棵树就是一个技能目录
        let bytes = make_tar(&[("SKILL.md", GOOD), ("extra.md", "x")], "bar-HEAD");
        let bundles = classify(&unpack(&bytes, None).unwrap()).unwrap();
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].name, "commit-helper");
        assert_eq!(bundles[0].files.len(), 2);

        // `<a>/SKILL.md` 与 `skills/<b>/SKILL.md` 混着放也能各认一个，身份一律取 frontmatter
        let other = "---\nname: other-skill\ndescription: 另一个\n---\n";
        let bytes = make_tar(
            &[
                ("a/SKILL.md", GOOD),
                ("skills/b/SKILL.md", other),
                ("README.md", "x"),
                (".github/SKILL.md", other),
            ],
            "bar-HEAD",
        );
        let bundles = classify(&unpack(&bytes, None).unwrap()).unwrap();
        let names: Vec<&str> = bundles.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["commit-helper", "other-skill"]);
    }

    /// 正经技能包动辄二十几个：`jnMetaCode/superpowers-zh` 实测 21 个，旧的 20 上限会把整包拒掉
    #[test]
    fn accepts_a_big_skill_pack_and_only_rejects_beyond_the_cap() {
        let build = |n: usize| -> (Vec<String>, Vec<String>) {
            let dirs: Vec<String> = (0..n).map(|i| format!("skills/s{i}/SKILL.md")).collect();
            let bodies: Vec<String> = (0..n)
                .map(|i| format!("---\nname: s{i}\ndescription: 第 {i} 个技能\n---\n"))
                .collect();
            (dirs, bodies)
        };
        let run = |n: usize| {
            let (dirs, bodies) = build(n);
            let entries: Vec<(&str, &str)> = dirs
                .iter()
                .zip(bodies.iter())
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect();
            classify(&unpack(&make_tar(&entries, "bar-HEAD"), None).unwrap())
        };

        assert_eq!(run(21).unwrap().len(), 21);
        assert_eq!(run(MAX_BUNDLES).unwrap().len(), MAX_BUNDLES);
        let err = run(MAX_BUNDLES + 1).unwrap_err().to_string();
        assert!(err.contains("64") && err.contains("skills/名称"), "{err}");
    }

    #[test]
    fn installs_updates_and_uninstalls() {
        let tmp = TempRoot::new();
        let scope = Scope { dot: tmp.0.join(".codeartsdoer") };
        let source = parse_source("foo/bar/skills/demo").unwrap();
        let bytes = make_tar(
            &[("skills/demo/SKILL.md", GOOD), ("skills/demo/ref/note.md", "x")],
            "bar-HEAD",
        );
        let bundles = classify(&unpack(&bytes, source.sub.as_deref()).unwrap()).unwrap();
        assert_eq!(bundles.len(), 1);
        assert_eq!(bundles[0].name, "commit-helper");

        let r = write_bundles(&scope, &source, bundles, Mode::Install).unwrap();
        assert_eq!(r.installed, vec!["commit-helper".to_string()]);
        let dest = scope.skills_dir().join("commit-helper");
        assert_eq!(std::fs::read_to_string(dest.join("SKILL.md")).unwrap(), GOOD);
        assert!(dest.join("ref/note.md").is_file());
        let m = load_manifest(&scope.manifest_file()).unwrap();
        assert_eq!(m.skills["commit-helper"].source, "foo/bar/skills/demo");

        // 同名再装：不覆盖，只报告冲突
        let bytes = make_tar(&[("demo/SKILL.md", GOOD)], "bar-HEAD");
        let bundles = classify(&unpack(&bytes, None).unwrap()).unwrap();
        let r = write_bundles(&scope, &source, bundles, Mode::Install).unwrap();
        assert!(r.installed.is_empty());
        assert_eq!(r.conflicts, vec!["commit-helper".to_string()]);
        assert!(dest.join("ref/note.md").is_file());

        // 更新：旧目录整体换新
        let fresh = "---\nname: commit-helper\ndescription: 换一版\n---\n";
        let bytes = make_tar(&[("demo/SKILL.md", fresh)], "bar-HEAD");
        let bundles = classify(&unpack(&bytes, None).unwrap()).unwrap();
        let r = write_bundles(&scope, &source, bundles, Mode::Update).unwrap();
        assert_eq!(r.installed, vec!["commit-helper".to_string()]);
        assert_eq!(std::fs::read_to_string(dest.join("SKILL.md")).unwrap(), fresh);
        assert!(!dest.join("ref/note.md").exists());

        let r = skill_uninstall_at(&scope, "commit-helper").unwrap();
        assert_eq!(r.removed, vec!["commit-helper".to_string()]);
        assert!(!dest.exists());
        assert!(load_manifest(&scope.manifest_file()).unwrap().skills.is_empty());
    }

    /// 命令本体要 AppHandle，测试里走同一套文件逻辑
    fn skill_uninstall_at(scope: &Scope, name: &str) -> Result<Report> {
        let mut manifest = load_manifest(&scope.manifest_file())?;
        if manifest.skills.remove(name).is_none() {
            return Err(Error::Msg("不在清单里".into()));
        }
        let root = scope.skills_dir();
        let dest = skill_dir(&root, name)?;
        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }
        save_manifest(&scope.manifest_file(), &manifest)?;
        Ok(Report {
            removed: vec![name.to_string()],
            ..Default::default()
        })
    }

    #[test]
    fn rejects_sources_without_skill_md() {
        let bytes = make_tar(&[("README.md", "# nope")], "bar-HEAD");
        let err = classify(&unpack(&bytes, None).unwrap()).unwrap_err();
        assert!(err.to_string().contains("SKILL.md"));
    }

    /// 真网络、真仓库：`cargo test --lib -- --ignored` 手动跑，CI 不放
    /// 排查某个具体仓库时用 `SKILL_PROBE_REPO=owner/repo cargo test --lib -- --ignored` 换掉目标
    #[tokio::test]
    #[ignore]
    async fn installs_from_a_real_github_repo() {
        let repo =
            std::env::var("SKILL_PROBE_REPO").unwrap_or_else(|_| "anthropics/skills".into());
        let source = parse_source(&repo).unwrap();
        let bytes = fetch(&source).await.unwrap();
        let bundles = classify(&unpack(&bytes, source.sub.as_deref()).unwrap()).unwrap();
        let names: Vec<&str> = bundles.iter().map(|b| b.name.as_str()).collect();
        println!("抓到 {} 个技能：{:?}", bundles.len(), names);
        assert!(!bundles.is_empty());

        let tmp = TempRoot::new();
        let scope = Scope { dot: tmp.0.join(".codeartsdoer") };
        let report = write_bundles(&scope, &source, bundles, Mode::Install).unwrap();
        println!("{} → {}", report.root, report.message);
        assert!(!report.installed.is_empty());
        let md = std::fs::read_to_string(scope.skills_dir().join(&report.installed[0]).join("SKILL.md"))
            .unwrap();
        assert!(md.starts_with("---"));
    }
}
