use std::path::PathBuf;
use std::process::Command;
use serde::{Deserialize, Serialize};

use crate::error::{Error, MsgExt, Result};
use crate::secrets;
use crate::settings::Settings;
use crate::trust;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OverviewStats {
    pub sessions: u64,
    pub messages: u64,
    pub days: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CostTokensStats {
    pub total_cost: String,
    pub avg_cost_per_day: String,
    pub avg_tokens_per_session: String,
    pub median_tokens_per_session: String,
    pub input_tokens: String,
    pub output_tokens: String,
    pub cache_read: String,
    pub cache_write: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ToolUsageItem {
    pub tool: String,
    pub count: u64,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModelUsageItem {
    pub model: String,
    pub messages: u64,
    pub input_tokens: String,
    pub output_tokens: String,
    pub cache_read: String,
    pub cache_write: String,
    pub cost: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StatsReport {
    pub overview: OverviewStats,
    pub cost_tokens: CostTokensStats,
    pub tool_usage: Vec<ToolUsageItem>,
    pub model_usage: Vec<ModelUsageItem>,
    pub raw: String,
    pub cached_at: Option<u64>,
    pub from_db: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedStatsItem {
    pub report: StatsReport,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StatsDatabase {
    pub entries: std::collections::HashMap<String, CachedStatsItem>,
}

fn get_stats_db_path(home: &std::path::Path) -> PathBuf {
    home.join(".codeartsdoer/stats_db.json")
}

fn load_stats_db(home: &std::path::Path) -> StatsDatabase {
    let p = get_stats_db_path(home);
    if let Ok(text) = std::fs::read_to_string(&p) {
        if let Ok(db) = serde_json::from_str::<StatsDatabase>(&text) {
            return db;
        }
    }
    StatsDatabase::default()
}

fn save_stats_db(home: &std::path::Path, db: &StatsDatabase) {
    let p = get_stats_db_path(home);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(db) {
        let _ = std::fs::write(&p, text);
    }
}

fn prepare_cmd(app: &tauri::AppHandle) -> Result<(Command, PathBuf, String, String)> {
    let settings = Settings::load(app)?;
    let bin = settings.kernel_bin()?;
    let home = settings.kernel_home();
    let data_dir = settings.kernel_data_dir();
    let project = settings.project_dir().unwrap_or_else(|_| home.clone());
    let _ = trust::trust_folder(&data_dir, &project);

    let ak = secrets::get(secrets::AK)?.unwrap_or_default();
    let sk = secrets::get(secrets::SK)?.unwrap_or_default();
    let (ak, sk) = if !ak.is_empty() && !sk.is_empty() {
        (ak, sk)
    } else {
        trust::read_cli_env(&home).unwrap_or_default()
    };

    let mut cmd = Command::new(&bin);
    cmd.current_dir(&project)
        .env("HOME", &home)
        .env("KERNEL_DATA_DIR", data_dir.display().to_string())
        .env("KERNEL_CONFIG_DIR", home.join(".codeartsdoer").display().to_string())
        .env("CODEARTS_CLI_AK", &ak)
        .env("CODEARTS_CLI_SK", &sk)
        .env("OPENCODE_CONFIG", home.join(".codeartsdoer/codearts_cli.json").display().to_string())
        .env("OPENCODE_CONFIG_FILE", "codearts_cli.json,codearts_cli.jsonc")
        .env("OPENCODE_CHANNEL", "latest")
        .env("OPENCODE_MODE", "tui")
        .env("SCENARIO", "codeartsdoer")
        .env("PLUGIN_ENV", "hc")
        .env("CODEAGENT_USE_MESSAGE_FEEDBACK", "false")
        .env("OMO_SEND_ANONYMOUS_TELEMETRY", "0")
        .env("OPENCODE_DISABLE_MODELS_FETCH", "1")
        .env("OPENCODE_DISABLE_AUTOUPDATE", "true")
        .env("OPENCODE_ALWAYS_NOTIFY_UPDATE", "false")
        .env_remove("NODE_TLS_REJECT_UNAUTHORIZED");

    #[cfg(windows)]
    cmd.env("USERPROFILE", &home);

    Ok((cmd, bin, ak, sk))
}

fn get_config_lsp_status(home: &std::path::Path) -> Option<bool> {
    let p = home.join(".codeartsdoer/codearts_cli.json");
    if let Ok(text) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(lsp) = v.get("lsp") {
                if lsp.is_boolean() {
                    return lsp.as_bool();
                } else if lsp.is_object() {
                    return Some(true);
                }
            }
        }
    }
    None
}

fn set_config_lsp_status(home: &std::path::Path, enable: bool) -> Result<()> {
    let configs = [
        home.join(".codeartsdoer/codearts_cli.json"),
        home.join(".codeartsdoer/codeagent.jsonc"),
        home.join(".codeartsdoer/codeagent.json"),
    ];
    for p in configs {
        if p.is_file() {
            if let Ok(text) = std::fs::read_to_string(&p) {
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(obj) = v.as_object_mut() {
                        if enable {
                            obj.insert("lsp".to_string(), serde_json::json!({}));
                        } else {
                            obj.insert("lsp".to_string(), serde_json::Value::Bool(false));
                        }
                        if let Ok(new_text) = serde_json::to_string_pretty(&v) {
                            let _ = std::fs::write(&p, new_text);
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn parse_u64_field(s: &str) -> u64 {
    s.replace(',', "")
        .trim()
        .parse::<u64>()
        .unwrap_or(0)
}

pub fn parse_stats_output(raw: &str) -> StatsReport {
    let mut report = StatsReport {
        raw: raw.to_string(),
        ..Default::default()
    };

    let mut section = "";
    let mut current_model: Option<ModelUsageItem> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.contains("OVERVIEW") {
            section = "OVERVIEW";
            continue;
        } else if trimmed.contains("COST & TOKENS") {
            section = "COST & TOKENS";
            continue;
        } else if trimmed.contains("MODEL USAGE") {
            section = "MODEL USAGE";
            continue;
        } else if trimmed.contains("TOOL USAGE") {
            if let Some(m) = current_model.take() {
                report.model_usage.push(m);
            }
            section = "TOOL USAGE";
            continue;
        }

        // 过滤表格边框
        if trimmed.starts_with('┌') || trimmed.starts_with('└') || trimmed.starts_with('├') || trimmed.is_empty() {
            if section == "MODEL USAGE" && (trimmed.starts_with('├') || trimmed.starts_with('└')) {
                if let Some(m) = current_model.take() {
                    report.model_usage.push(m);
                }
            }
            continue;
        }

        // 清理行内边框竖线
        let cleaned = trimmed.trim_matches('│').trim();
        if cleaned.is_empty() {
            continue;
        }

        match section {
            "OVERVIEW" => {
                if let Some(rest) = cleaned.strip_prefix("Sessions") {
                    report.overview.sessions = parse_u64_field(rest);
                } else if let Some(rest) = cleaned.strip_prefix("Messages") {
                    report.overview.messages = parse_u64_field(rest);
                } else if let Some(rest) = cleaned.strip_prefix("Days") {
                    report.overview.days = parse_u64_field(rest);
                }
            }
            "COST & TOKENS" => {
                if let Some(rest) = cleaned.strip_prefix("Total Cost") {
                    report.cost_tokens.total_cost = rest.trim().to_string();
                } else if let Some(rest) = cleaned.strip_prefix("Avg Cost/Day") {
                    report.cost_tokens.avg_cost_per_day = rest.trim().to_string();
                } else if let Some(rest) = cleaned.strip_prefix("Avg Tokens/Session") {
                    report.cost_tokens.avg_tokens_per_session = rest.trim().to_string();
                } else if let Some(rest) = cleaned.strip_prefix("Median Tokens/Session") {
                    report.cost_tokens.median_tokens_per_session = rest.trim().to_string();
                } else if let Some(rest) = cleaned.strip_prefix("Input") {
                    report.cost_tokens.input_tokens = rest.trim().to_string();
                } else if let Some(rest) = cleaned.strip_prefix("Output") {
                    report.cost_tokens.output_tokens = rest.trim().to_string();
                } else if let Some(rest) = cleaned.strip_prefix("Cache Read") {
                    report.cost_tokens.cache_read = rest.trim().to_string();
                } else if let Some(rest) = cleaned.strip_prefix("Cache Write") {
                    report.cost_tokens.cache_write = rest.trim().to_string();
                }
            }
            "MODEL USAGE" => {
                // 如果包含 provider/model，通常是一行模型名
                if cleaned.contains('/') && !cleaned.contains("Tokens") {
                    if let Some(m) = current_model.take() {
                        report.model_usage.push(m);
                    }
                    current_model = Some(ModelUsageItem {
                        model: cleaned.to_string(),
                        ..Default::default()
                    });
                } else if let Some(ref mut m) = current_model {
                    if let Some(rest) = cleaned.strip_prefix("Messages") {
                        m.messages = parse_u64_field(rest);
                    } else if let Some(rest) = cleaned.strip_prefix("Input Tokens") {
                        m.input_tokens = rest.trim().to_string();
                    } else if let Some(rest) = cleaned.strip_prefix("Output Tokens") {
                        m.output_tokens = rest.trim().to_string();
                    } else if let Some(rest) = cleaned.strip_prefix("Cache Read") {
                        m.cache_read = rest.trim().to_string();
                    } else if let Some(rest) = cleaned.strip_prefix("Cache Write") {
                        m.cache_write = rest.trim().to_string();
                    } else if let Some(rest) = cleaned.strip_prefix("Cost") {
                        m.cost = rest.trim().to_string();
                    }
                }
            }
            "TOOL USAGE" => {
                // 格式形如: "bash               ████████████████████ 6546 (51.7%)"
                let parts: Vec<&str> = cleaned.split_whitespace().collect();
                if parts.len() >= 3 {
                    let tool = parts[0].to_string();
                    let count_str = parts[parts.len() - 2];
                    let pct_str = parts[parts.len() - 1].trim_matches('(').trim_matches(')').trim_matches('%');
                    let count = parse_u64_field(count_str);
                    let percent = pct_str.parse::<f64>().unwrap_or(0.0);
                    report.tool_usage.push(ToolUsageItem {
                        tool,
                        count,
                        percent,
                    });
                }
            }
            _ => {}
        }
    }

    if let Some(m) = current_model {
        report.model_usage.push(m);
    }

    report
}

#[tauri::command]
pub async fn stats_report(
    app: tauri::AppHandle,
    days: Option<u32>,
    project: Option<String>,
    force: Option<bool>,
) -> Result<StatsReport> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let force_refresh = force.unwrap_or(false);

    let key = format!(
        "{}_{}",
        days.unwrap_or(0),
        project.as_deref().unwrap_or("all")
    );

    let mut db = load_stats_db(&home);

    // 如果未要求强制刷新，且本地数据库中存在缓存，直接从数据库秒级返回
    if !force_refresh {
        if let Some(item) = db.entries.get(&key) {
            let mut rep = item.report.clone();
            rep.cached_at = Some(item.timestamp);
            rep.from_db = true;
            return Ok(rep);
        }
    }

    let (mut cmd, bin, _, _) = prepare_cmd(&app)?;
    cmd.arg("stats").arg("--models");

    if let Some(d) = days {
        if d > 0 {
            cmd.arg("--days").arg(d.to_string());
        }
    }
    if let Some(p) = project.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--project").arg(p);
    }

    let out = tokio::process::Command::from(cmd)
        .output()
        .await
        .msg(format!("无法执行 {} stats", bin.display()))?;

    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(Error::Msg(format!("获取统计失败：{err}")));
    }

    let mut report = parse_stats_output(&text);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    report.cached_at = Some(now);
    report.from_db = false;

    // 持久化存储到本地数据库中
    db.entries.insert(
        key,
        CachedStatsItem {
            report: report.clone(),
            timestamp: now,
        },
    );
    save_stats_db(&home, &db);

    Ok(report)
}

#[tauri::command]
pub async fn lsp_status(app: tauri::AppHandle) -> Result<bool> {
    let home = Settings::load(&app)?.kernel_home();
    if let Some(st) = get_config_lsp_status(&home) {
        return Ok(st);
    }

    let (mut cmd, bin, _, _) = prepare_cmd(&app)?;
    cmd.arg("lsp-toggle").arg("status");

    let out = tokio::process::Command::from(cmd)
        .output()
        .await
        .msg(format!("无法执行 {} lsp-toggle status", bin.display()))?;

    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let enabled = text.contains("开启") || text.to_lowercase().contains("enable");
    Ok(enabled)
}

#[tauri::command]
pub async fn lsp_toggle(app: tauri::AppHandle, enable: bool) -> Result<bool> {
    let home = Settings::load(&app)?.kernel_home();
    let _ = set_config_lsp_status(&home, enable);

    let (mut cmd, _, _, _) = prepare_cmd(&app)?;
    cmd.arg("lsp-toggle").arg(if enable { "enable" } else { "disable" });

    // 触发 CLI 内部可能需要的额外生命周期或环境同步
    let _ = tokio::process::Command::from(cmd).output().await;

    lsp_status(app).await
}

#[tauri::command]
pub async fn session_native_export(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
) -> Result<String> {
    let (mut cmd, bin, _, _) = prepare_cmd(&app)?;
    cmd.arg("export").arg(&session_id);

    let out = tokio::process::Command::from(cmd)
        .output()
        .await
        .msg(format!("无法执行 {} export", bin.display()))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(Error::Msg(format!("导出原生会话失败：{err}")));
    }

    let json_text = String::from_utf8_lossy(&out.stdout).to_string();
    std::fs::write(&path, &json_text).msg(format!("写入文件失败：{path}"))?;
    Ok(path)
}

#[tauri::command]
pub async fn session_native_import(
    app: tauri::AppHandle,
    path: String,
) -> Result<String> {
    let (mut cmd, bin, _, _) = prepare_cmd(&app)?;
    cmd.arg("import").arg(&path);

    let out = tokio::process::Command::from(cmd)
        .output()
        .await
        .msg(format!("无法执行 {} import", bin.display()))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(Error::Msg(format!("导入原生会话失败：{err}")));
    }

    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(text)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CodebaseStatus {
    pub indexed: bool,
    pub message: String,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryConfig {
    pub status: bool,
    pub enable_dream: bool,
    pub dream_min_hours: Option<u64>,
    pub dream_min_sessions: Option<u64>,
}

pub fn strip_ansi(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            if let Some(&next) = chars.peek() {
                if next == '[' {
                    chars.next();
                    // CSI 序列: 吞掉参数字节 (0x30-0x3F) 与中间字节，直到终结字符 (0x40-0x7E)
                    while let Some(&ch) = chars.peek() {
                        chars.next();
                        if ('\x40'..='\x7e').contains(&ch) {
                            break;
                        }
                    }
                } else if next == ']' {
                    chars.next();
                    // OSC 序列: 吞掉直到 BEL (0x07) 或 ST
                    while let Some(ch) = chars.next() {
                        if ch == '\x07' || ch == '\x1b' {
                            break;
                        }
                    }
                } else if next == '(' || next == ')' {
                    chars.next();
                    chars.next();
                }
            }
        } else if c != '\r' {
            result.push(c);
        }
    }
    result
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryFileItem {
    pub name: String,
    pub path: String,
    pub size: u64,
}

#[tauri::command]
pub async fn codebase_status(
    app: tauri::AppHandle,
    project: Option<String>,
) -> Result<CodebaseStatus> {
    let proj_dir = project.as_ref().filter(|s| !s.is_empty()).map(PathBuf::from);
    let mut local_info = String::new();
    let mut has_local_index = false;

    // 1. 优先探测当前项目工作区本地的 .codeartsdoer/.codebase 实体快照
    if let Some(p) = &proj_dir {
        let codebase_dir = p.join(".codeartsdoer/.codebase");
        let state_file = codebase_dir.join("upload_state.json");
        let db_file = codebase_dir.join("file-index.db");
        if state_file.is_file() {
            if let Ok(content) = std::fs::read_to_string(&state_file) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(id) = v.get("codebaseId").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
                        has_local_index = true;
                        let branch = v.get("branch").and_then(|x| x.as_str()).unwrap_or("main");
                        let task_id = v.get("taskId").and_then(|x| x.as_str()).unwrap_or("-");
                        local_info = format!("代码库ID: {id}\n分支: {branch}\n任务ID: {task_id}");
                    }
                }
            }
        } else if db_file.is_file() {
            has_local_index = true;
            local_info = "本地已生成 file-index.db 代码语义索引快照".to_string();
        }
    }

    // 2. 调用内核 CLI 查询详细报告 (过滤终端 ANSI 颜色转义码)
    let (mut cmd, bin, _, _) = prepare_cmd(&app)?;
    if let Some(p) = project.as_ref().filter(|s| !s.is_empty()) {
        cmd.current_dir(p);
    }
    cmd.arg("codebase").arg("--detail");

    let out = tokio::process::Command::from(cmd)
        .output()
        .await
        .msg(format!("无法执行 {} codebase --detail", bin.display()))?;

    let stdout = strip_ansi(&String::from_utf8_lossy(&out.stdout)).trim().to_string();
    let stderr = strip_ansi(&String::from_utf8_lossy(&out.stderr)).trim().to_string();
    let cli_text = if !stdout.is_empty() {
        stdout
    } else {
        stderr
    };

    let cli_says_unindexed = cli_text.contains("未创建索引") || cli_text.contains("未索引");
    let indexed = if cli_says_unindexed {
        false
    } else if has_local_index {
        true
    } else if !cli_text.is_empty() && out.status.success() {
        true
    } else {
        false
    };

    let raw = if !cli_text.is_empty() && !local_info.is_empty() {
        format!("{cli_text}\n\n[本地快照索引]\n{local_info}")
    } else if !cli_text.is_empty() {
        cli_text
    } else if !local_info.is_empty() {
        format!("代码库索引已就绪 (本地快照已同步)\n\n[本地快照索引]\n{local_info}")
    } else {
        "当前工作区尚未建立代码库索引".to_string()
    };

    Ok(CodebaseStatus {
        indexed,
        message: if indexed {
            "代码库索引已就绪".to_string()
        } else {
            "当前工作区尚未建立代码库索引".to_string()
        },
        raw,
    })
}

#[tauri::command]
pub async fn codebase_action(
    app: tauri::AppHandle,
    action: String,
    project: Option<String>,
) -> Result<String> {
    let (mut cmd, bin, _, _) = prepare_cmd(&app)?;
    if let Some(p) = project.as_ref().filter(|s| !s.is_empty()) {
        cmd.current_dir(p);
    }

    let flag = match action.as_str() {
        "init" => "--init",
        "update" => "--update",
        "delete" => "--delete",
        other => return Err(Error::Msg(format!("不支持的 codebase 操作：{other}"))),
    };

    cmd.arg("codebase").arg(flag);

    let out = tokio::process::Command::from(cmd)
        .output()
        .await
        .msg(format!("无法执行 {} codebase {flag}", bin.display()))?;

    let stdout = strip_ansi(&String::from_utf8_lossy(&out.stdout)).trim().to_string();
    let stderr = strip_ansi(&String::from_utf8_lossy(&out.stderr)).trim().to_string();
    if !out.status.success() && !stderr.is_empty() {
        return Err(Error::Msg(format!("操作失败：{stderr}")));
    }

    // 若执行的是删除索引，同步清理本地工作区的 .codebase 缓存目录以确保状态立即归零
    if action == "delete" {
        if let Some(p) = project.as_ref().filter(|s| !s.is_empty()) {
            let cb_dir = PathBuf::from(p).join(".codeartsdoer/.codebase");
            let _ = std::fs::remove_dir_all(&cb_dir);
        }
    }

    let res = if !stdout.is_empty() && !stderr.is_empty() {
        format!("{stdout} {stderr}")
    } else if !stdout.is_empty() {
        stdout
    } else if !stderr.is_empty() {
        stderr
    } else {
        "操作已执行完成".to_string()
    };
    Ok(res)
}

#[tauri::command]
pub async fn memory_status(app: tauri::AppHandle) -> Result<MemoryConfig> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let path = home.join(".codeartsdoer/memory/status.json");

    if path.is_file() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<MemoryConfig>(&text) {
                return Ok(cfg);
            }
        }
    }

    Ok(MemoryConfig {
        status: true,
        enable_dream: true,
        ..Default::default()
    })
}

#[tauri::command]
pub async fn memory_toggle(app: tauri::AppHandle, enable: bool) -> Result<bool> {
    let (mut cmd, _bin, _, _) = prepare_cmd(&app)?;
    cmd.arg("memory").arg(if enable { "--enable" } else { "--disable" });

    let _ = tokio::process::Command::from(cmd).output().await;

    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let path = home.join(".codeartsdoer/memory/status.json");

    if path.is_file() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("status".to_string(), serde_json::Value::Bool(enable));
                    let _ = std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
                }
            }
        }
    }

    Ok(enable)
}

fn get_project_memory_dir(home: &std::path::Path, project_dir: &str) -> PathBuf {
    let sanitized = project_dir.replace(['/', '\\', ':'], "-");
    home.join(".codeartsdoer").join("memory").join(sanitized)
}

#[tauri::command]
pub async fn memory_list_files(
    app: tauri::AppHandle,
    project: Option<String>,
) -> Result<Vec<MemoryFileItem>> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let cur_project = project
        .or_else(|| settings.project_dir().ok().map(|p| p.display().to_string()))
        .unwrap_or_default();

    if cur_project.is_empty() {
        return Ok(vec![]);
    }

    let dir = get_project_memory_dir(&home, &cur_project);
    if !dir.is_dir() {
        return Ok(vec![]);
    }

    let mut files = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() && p.extension().is_some_and(|ext| ext == "md") {
                let name = entry.file_name().to_string_lossy().to_string();
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                files.push(MemoryFileItem {
                    name,
                    path: p.display().to_string(),
                    size,
                });
            }
        }
    }

    files.sort_by(|a, b| {
        if a.name == "MEMORY.md" {
            std::cmp::Ordering::Less
        } else if b.name == "MEMORY.md" {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });

    Ok(files)
}

#[tauri::command]
pub async fn memory_read_file(
    app: tauri::AppHandle,
    project: Option<String>,
    filename: String,
) -> Result<String> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let cur_project = project
        .or_else(|| settings.project_dir().ok().map(|p| p.display().to_string()))
        .unwrap_or_default();

    let dir = get_project_memory_dir(&home, &cur_project);
    let target = dir.join(&filename);

    if !target.starts_with(&dir) {
        return Err(Error::Msg("非法文件路径".into()));
    }

    let text = std::fs::read_to_string(&target)
        .msg(format!("无法读取记忆文件：{}", target.display()))?;
    Ok(text)
}

#[tauri::command]
pub async fn memory_save_file(
    app: tauri::AppHandle,
    project: Option<String>,
    filename: String,
    content: String,
) -> Result<()> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let cur_project = project
        .or_else(|| settings.project_dir().ok().map(|p| p.display().to_string()))
        .unwrap_or_default();

    let dir = get_project_memory_dir(&home, &cur_project);
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(&filename);

    if !target.starts_with(&dir) {
        return Err(Error::Msg("非法文件路径".into()));
    }

    std::fs::write(&target, content)
        .msg(format!("无法保存记忆文件：{}", target.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_stats() {
        let sample = r#"
┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                            105 │
│Messages                                          9,580 │
│Days                                                 37 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                        $0.00 │
│Avg Cost/Day                                      $0.00 │
│Avg Tokens/Session                                 8.8M │
│Median Tokens/Session                              2.2M │
│Input                                             79.2M │
│Output                                             3.0M │
│Cache Read                                       840.4M │
│Cache Write                                           0 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                      MODEL USAGE                       │
├────────────────────────────────────────────────────────┤
│ huaweicloud-maas/deepseek-v4.1-flash-1017              │
│  Messages                                        2,743 │
│  Input Tokens                                    26.0M │
│  Output Tokens                                    2.0M │
│  Cache Read                                     407.4M │
│  Cache Write                                         0 │
│  Cost                                          $0.0000 │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                      TOOL USAGE                        │
├────────────────────────────────────────────────────────┤
│ bash               ████████████████████ 6546 (51.7%)   │
│ read               ███████              2534 (20.0%)   │
└────────────────────────────────────────────────────────┘
"#;
        let rep = parse_stats_output(sample);
        assert_eq!(rep.overview.sessions, 105);
        assert_eq!(rep.overview.messages, 9580);
        assert_eq!(rep.overview.days, 37);
        assert_eq!(rep.cost_tokens.input_tokens, "79.2M");
        assert_eq!(rep.cost_tokens.cache_read, "840.4M");
        assert_eq!(rep.model_usage.len(), 1);
        assert_eq!(rep.model_usage[0].model, "huaweicloud-maas/deepseek-v4.1-flash-1017");
        assert_eq!(rep.model_usage[0].messages, 2743);
        assert_eq!(rep.tool_usage.len(), 2);
        assert_eq!(rep.tool_usage[0].tool, "bash");
        assert_eq!(rep.tool_usage[0].count, 6546);
        assert_eq!(rep.tool_usage[0].percent, 51.7);
    }

    #[test]
    fn test_strip_ansi() {
        let input = "\x1b[94m代码库索引开始创建\x1b[0m \x1b[92m代码库索引创建完成\x1b[0m";
        assert_eq!(strip_ansi(input), "代码库索引开始创建 代码库索引创建完成");
    }

    #[test]
    fn test_stats_database() {
        let mut db = StatsDatabase::default();
        let rep = StatsReport::default();
        db.entries.insert("0_all".to_string(), CachedStatsItem {
            report: rep,
            timestamp: 12345678,
        });

        let serialized = serde_json::to_string(&db).unwrap();
        let deserialized: StatsDatabase = serde_json::from_str(&serialized).unwrap();
        assert!(deserialized.entries.contains_key("0_all"));
        assert_eq!(deserialized.entries.get("0_all").unwrap().timestamp, 12345678);
    }
}
