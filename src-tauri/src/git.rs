use std::path::Path;
use std::process::Output;
use std::time::Duration;

use serde::Serialize;

use crate::error::{Error, Result};
use crate::files::workspace_root;
use crate::settings::Settings;

/// 读类 git 调用的预算：列表/状态最多等 20 秒，超时按失败处理
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
/// checkout 要落一整棵树，大仓 20 秒不够；本地分支切换不发网络请求，给足两分钟就等于没有超时
const SWITCH_TIMEOUT: Duration = Duration::from_secs(120);
/// 报错只取开头一段：git 的冲突清单能刷几百行，界面上放不下
const MAX_ERR_CHARS: usize = 400;

/// 切分支是全局状态，两个请求同时跑会互相把 HEAD 改回去
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub upstream: Option<String>,
    pub current: bool,
    /// 远程分支对应的本地短名（`origin/feat` → `feat`）；本地分支为 None
    pub local: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    /// false = 这个工作区不在 git 仓库里，界面上就别给切分支的入口
    pub repo: bool,
    /// 当前分支名；detached HEAD 时为 None
    pub current: Option<String>,
    pub detached: bool,
    /// detached 时的短 sha，用来在顶栏显示「(abc1234)」
    pub head: Option<String>,
    /// 已跟踪文件里有多少处未提交改动（不算未跟踪文件，它们不挡 checkout）
    pub dirty: usize,
    pub branches: Vec<BranchInfo>,
    pub remotes: Vec<BranchInfo>,
}

impl BranchState {
    fn missing() -> Self {
        Self {
            repo: false,
            current: None,
            detached: false,
            head: None,
            dirty: 0,
            branches: Vec::new(),
            remotes: Vec::new(),
        }
    }
}

/// 顶栏分支下拉：工作区由 Settings 推导，前端传进来的目录必须已经登记过（同 files.rs 的规则）
#[tauri::command]
pub async fn git_branches(app: tauri::AppHandle, directory: Option<String>) -> Result<BranchState> {
    let settings = Settings::load(&app)?;
    let root = workspace_root(&settings, directory.as_deref())?;
    collect(&root).await
}

/// 切到已有分支，或 `create = true` 时从当前 HEAD 新建一个。
/// 只认列表里出现过的名字，避免把 WebView 传来的任意字符串当 ref 用。
#[tauri::command]
pub async fn git_switch(
    app: tauri::AppHandle,
    directory: Option<String>,
    name: String,
    create: bool,
) -> Result<BranchState> {
    let _gate = GATE.lock().await;
    let settings = Settings::load(&app)?;
    let root = workspace_root(&settings, directory.as_deref())?;
    let raw = name.trim().to_string();
    if raw.is_empty() {
        return Err(Error::Msg("分支名不能为空".into()));
    }
    // `-` 开头会被 git 当成参数；换行等控制字符用来拼假 ref
    if raw.len() > 200 || raw.starts_with('-') || raw.chars().any(char::is_control) {
        return Err(Error::Msg(format!("分支名不合法：{raw}")));
    }

    let before = collect(&root).await?;
    if !before.repo {
        return Err(Error::Msg("这个工作区不是 git 仓库".into()));
    }

    if create {
        let checked = git(&root, &["check-ref-format", "--branch", &raw]).await?;
        if !checked.status.success() {
            return Err(Error::Msg(format!("分支名不合法：{raw}")));
        }
        if before.branches.iter().any(|b| b.name == raw) {
            return Err(Error::Msg(format!("分支 {raw} 已经存在")));
        }
        let out = git_t(&root, &["switch", "-c", &raw], SWITCH_TIMEOUT).await?;
        if !out.status.success() {
            return Err(git_err("新建分支失败", &out));
        }
        return collect(&root).await;
    }

    if before.branches.iter().any(|b| b.name == raw) {
        if before.current.as_deref() == Some(raw.as_str()) {
            return Ok(before);
        }
        let out = git_t(&root, &["switch", &raw], SWITCH_TIMEOUT).await?;
        if !out.status.success() {
            return Err(git_err("切换分支失败", &out));
        }
        return collect(&root).await;
    }

    if let Some(remote) = before.remotes.iter().find(|r| r.name == raw) {
        let local = remote
            .local
            .clone()
            .filter(|l| !l.is_empty())
            .ok_or_else(|| Error::Msg(format!("无法从 {} 推导出本地分支名", remote.name)))?;
        let out = if before.branches.iter().any(|b| b.name == local) {
            git_t(&root, &["switch", &local], SWITCH_TIMEOUT).await?
        } else {
            git_t(
                &root,
                &["switch", "-c", &local, "--track", &remote.name],
                SWITCH_TIMEOUT,
            )
            .await?
        };
        if !out.status.success() {
            return Err(git_err("切换到远程分支失败", &out));
        }
        return collect(&root).await;
    }

    Err(Error::Msg(format!("找不到分支 {raw}，先刷新一下列表")))
}

/// 一处在 `git status` 里出现的改动。`status` 是给界面着色的归一化结果，
/// `index` / `worktree` 两个字符原样保留（` X`、`M ` 这种组合信息界面偶尔要看）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// 相对工作区根，始终用 `/` 分隔
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub staged: bool,
    pub untracked: bool,
    pub status: String,
}

/// 工作区的未提交状态。`repo = false` 时 `changes` 必为空——界面据此整段不画，
/// 而不是显示一个「没有改动」的空列表。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo: bool,
    pub changes: Vec<GitChange>,
}

/// 未提交清单：内核的 `/session/:id/diff` 只认"这条会话改过什么"，
/// 用户自己或别的工具留下的改动要另看一眼，所以直读 git。
#[tauri::command]
pub async fn git_status(
    app: tauri::AppHandle,
    directory: Option<String>,
) -> Result<GitStatus> {
    let settings = Settings::load(&app)?;
    let root = workspace_root(&settings, directory.as_deref())?;
    status_of(&root).await
}

async fn status_of(root: &Path) -> Result<GitStatus> {
    let probe = git(root, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !probe.status.success() || String::from_utf8_lossy(&probe.stdout).trim() != "true" {
        return Ok(GitStatus {
            repo: false,
            changes: Vec::new(),
        });
    }
    // -z：路径不进 shell 引号，中文名与带空格的名字都不会被转义成 "\346\226\207"
    let out = git(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    if !out.status.success() {
        return Err(git_err("读取 git 状态失败", &out));
    }
    Ok(GitStatus {
        repo: true,
        changes: parse_status(&String::from_utf8_lossy(&out.stdout)),
    })
}

/// 解析 `--porcelain=v1 -z`：记录之间用 NUL 分隔，重命名/复制会紧跟一条原路径记录。
fn parse_status(raw: &str) -> Vec<GitChange> {
    let mut out = Vec::new();
    let mut records = raw.split('\0');
    while let Some(rec) = records.next() {
        if rec.len() < 4 {
            continue;
        }
        let b = rec.as_bytes();
        let index = (b[0] as char).to_string();
        let worktree = (b[1] as char).to_string();
        // 用 get 而不是直接切片：万一内核之外的 git 版本吐出畸形记录，切片会 panic 在字符边界上
        let Some(path) = rec.get(3..) else { continue };
        let path = path.to_string();
        // R / C 会多带一条"原路径"，那一项不是独立改动
        if index == "R" || index == "C" || worktree == "R" || worktree == "C" {
            records.next();
        }
        if path.is_empty() {
            continue;
        }
        let untracked = index == "?" && worktree == "?";
        let status = if untracked {
            "untracked"
        } else if index == "A" || worktree == "A" {
            "added"
        } else if index == "D" || worktree == "D" {
            "deleted"
        } else if index == "R" || worktree == "R" {
            "renamed"
        } else {
            "modified"
        };
        out.push(GitChange {
            path,
            // 暂存区有变化（X 不是空格）就算 staged，"MM" 这种半暂存也算
            staged: index != " " && index != "?",
            index,
            worktree,
            untracked,
            status: status.to_string(),
        });
    }
    out
}

async fn collect(root: &Path) -> Result<BranchState> {
    let probe = git(root, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !probe.status.success() || String::from_utf8_lossy(&probe.stdout).trim() != "true" {
        return Ok(BranchState::missing());
    }

    let local_raw = git(
        root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)%09%(upstream:short)%09%(HEAD)",
            "refs/heads",
        ],
    )
    .await?;
    let remote_raw = git(
        root,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname:short)%09%(upstream:short)%09%(HEAD)",
            "refs/remotes",
        ],
    )
    .await?;

    let branches = parse_refs(&String::from_utf8_lossy(&local_raw.stdout), false);
    let remotes = parse_refs(&String::from_utf8_lossy(&remote_raw.stdout), true);
    let current = branches.iter().find(|b| b.current).map(|b| b.name.clone());
    let detached = current.is_none();

    // 已跟踪的改动才挡 checkout；未跟踪文件不影响，所以 -uno
    let status = git(root, &["status", "--porcelain", "-uno"]).await?;
    let dirty = if status.status.success() {
        String::from_utf8_lossy(&status.stdout)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count()
    } else {
        0
    };

    let head = if detached {
        let out = git(root, &["rev-parse", "--short", "HEAD"]).await?;
        if out.status.success() {
            let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (!sha.is_empty()).then_some(sha)
        } else {
            None
        }
    } else {
        None
    };

    Ok(BranchState {
        repo: true,
        current,
        detached,
        head,
        dirty,
        branches,
        remotes,
    })
}

/// 解析 `for-each-ref` 的三段输出。分支名里不可能有制表符，用它当分隔符是安全的。
fn parse_refs(raw: &str, remote: bool) -> Vec<BranchInfo> {
    raw.lines()
        .filter_map(|line| {
            let mut it = line.split('\t');
            let name = it.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let upstream = it
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let head = it.next().unwrap_or("").trim();
            if remote {
                // origin/HEAD 只是符号引用，切它没有意义
                if name.ends_with("/HEAD") {
                    return None;
                }
                let local = name.split_once('/').map(|(_, b)| b.to_string());
                Some(BranchInfo {
                    name: name.to_string(),
                    upstream,
                    current: false,
                    local,
                })
            } else {
                Some(BranchInfo {
                    name: name.to_string(),
                    upstream,
                    current: head == "*",
                    local: None,
                })
            }
        })
        .collect()
}

async fn git(root: &Path, args: &[&str]) -> Result<Output> {
    git_t(root, args, GIT_TIMEOUT).await
}

async fn git_t(root: &Path, args: &[&str], limit: Duration) -> Result<Output> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .args(args)
        // 没有终端就不该弹凭据提示；可选锁会让 status 在并发时卡住
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // 固定英文，报错匹配与提示都按英文来
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(limit, cmd.output()).await {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(Error::Msg("未找到 git 命令，请先安装 Git".into()))
        }
        Ok(Err(e)) => Err(Error::Msg(format!("执行 git 失败：{e}"))),
        Err(_) => Err(Error::Msg(format!(
            "git {} 超时（{}s）；如果是在切分支，工作区可能停在中途，刷新后确认一下",
            args.first().copied().unwrap_or(""),
            limit.as_secs()
        ))),
    }
}

fn git_err(ctx: &str, out: &Output) -> Error {
    let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if msg.is_empty() {
        msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
    }
    let overwritten = msg.contains("would be overwritten")
        || msg.contains("Please commit your changes or stash them");
    if overwritten {
        msg = format!("工作区有未提交改动，git 拒绝了这次切换。先提交或暂存再试（{msg}）");
    }
    if msg.chars().count() > MAX_ERR_CHARS {
        msg = msg.chars().take(MAX_ERR_CHARS).collect::<String>() + "…";
    }
    if msg.is_empty() {
        Error::Msg(ctx.to_string())
    } else {
        Error::Msg(format!("{ctx}：{msg}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_local_refs_and_head_marker() {
        let raw = "main\torigin/main\t*\nfeat\t\t \n";
        let list = parse_refs(raw, false);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "main");
        assert_eq!(list[0].upstream.as_deref(), Some("origin/main"));
        assert!(list[0].current);
        assert_eq!(list[1].name, "feat");
        assert_eq!(list[1].upstream, None);
        assert!(!list[1].current);
    }

    #[test]
    fn skips_remote_head_and_derives_local_name() {
        let raw = "origin/HEAD\t\t\norigin/main\t\t\norigin/feat/x\t\t\n";
        let list = parse_refs(raw, true);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "origin/main");
        assert_eq!(list[0].local.as_deref(), Some("main"));
        // 带斜杠的分支名只切掉第一段（远端名），剩下的原样保留
        assert_eq!(list[1].local.as_deref(), Some("feat/x"));
    }

    /// `--porcelain=v1 -z` 的真实形状：状态两个字符 + 空格 + 路径，记录间 NUL；
    /// 重命名后面紧跟一条原路径记录，不能当成独立改动。
    #[test]
    fn parses_nul_separated_status() {
        let raw = " M src/a.rs\0?? docs/新文件.md\0A  staged.txt\0D  gone.txt\0R  new.rs\0old.rs\0MM both.txt\0";
        let list = parse_status(raw);
        let by = |p: &str| list.iter().find(|c| c.path == p).unwrap();
        assert_eq!(list.len(), 6, "重命名的原路径不该单独出现：{list:?}");
        assert!(!list.iter().any(|c| c.path == "old.rs"), "old.rs 是重命名的原路径，不是独立条目");
        assert_eq!(by("src/a.rs").status, "modified");
        assert!(!by("src/a.rs").staged);
        assert_eq!(by("docs/新文件.md").status, "untracked");
        assert!(by("docs/新文件.md").untracked);
        assert_eq!(by("staged.txt").status, "added");
        assert!(by("staged.txt").staged);
        assert_eq!(by("gone.txt").status, "deleted");
        assert_eq!(by("new.rs").status, "renamed");
        // 半暂存的两侧都算改过，界面把它归到"已暂存"里也更接近 git 的真实状态
        assert_eq!(by("both.txt").index, "M");
        assert_eq!(by("both.txt").worktree, "M");
        assert!(by("both.txt").staged);
        assert!(parse_status("").is_empty());
    }

    /// 真起一个仓库跑一遍：列表、当前分支、未提交改动数都按界面要的形状给出来。
    /// 没装 git 的机器直接跳过——这个功能本来也要 git 才能用。
    #[tokio::test]
    async fn reads_and_switches_a_real_repo() {
        let ready = git(Path::new("."), &["--version"])
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ready {
            return;
        }

        let dir = std::env::temp_dir().join(format!(
            "codearts-git-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let init = git(&dir, &["init", "-b", "main"]).await.unwrap();
        if !init.status.success() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        for (k, v) in [("user.email", "t@example.com"), ("user.name", "t"), ("commit.gpgsign", "false")] {
            git(&dir, &["config", k, v]).await.unwrap();
        }
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "."]).await.unwrap();
        git(&dir, &["commit", "-m", "init"]).await.unwrap();
        git(&dir, &["branch", "feat"]).await.unwrap();

        let st = collect(&dir).await.unwrap();
        assert!(st.repo);
        assert_eq!(st.current.as_deref(), Some("main"));
        assert!(!st.detached);
        assert_eq!(st.dirty, 0);
        assert!(st.branches.iter().any(|b| b.name == "feat"));

        let switched = git(&dir, &["switch", "feat"]).await.unwrap();
        assert!(switched.status.success());
        let st = collect(&dir).await.unwrap();
        assert_eq!(st.current.as_deref(), Some("feat"));
        assert!(st.branches.iter().any(|b| b.name == "feat" && b.current));

        // 改一个已跟踪文件：脏计数要能反映出来（切分支前的提醒靠它）
        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        let st = collect(&dir).await.unwrap();
        assert_eq!(st.dirty, 1);

        // 未提交清单：改了 a.txt，再放一个未跟踪文件，两个都要出现
        std::fs::write(dir.join("新 文件.txt"), "hi\n").unwrap();
        let st = status_of(&dir).await.unwrap();
        assert!(st.repo);
        let changes = st.changes;
        assert!(changes
            .iter()
            .any(|c| c.path == "a.txt" && c.status == "modified" && !c.staged));
        assert!(changes
            .iter()
            .any(|c| c.path == "新 文件.txt" && c.status == "untracked"));

        // 非 git 目录返回 repo=false，界面据此整段不画（必须放在仓库外，仓库里的子目录也算 repo）
        let plain = std::env::temp_dir().join(format!(
            "codearts-nogit-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&plain).unwrap();
        let st = collect(&plain).await.unwrap();
        assert!(!st.repo);
        assert!(st.branches.is_empty());
        let st = status_of(&plain).await.unwrap();
        assert!(!st.repo);
        assert!(st.changes.is_empty());

        let _ = std::fs::remove_dir_all(&plain);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
