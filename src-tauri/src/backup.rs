//! 设置备份：把壳的配置、界面偏好、第三方模型、MCP 和已装技能汇总成一份 JSON。
//!
//! 不加密的备份里不放任何凭据：名字像密钥的字段在导出时统一换成 null，导入时本地已有的值会保留。
//! 口令加密的备份会带上 AK/SK 和模型密钥（模型密钥走壳自己留的明文副本，内核配置里的是
//! 本机加密的 enc:v3:，换机解不开），导入时必须输对同一口令才能解开。
//! 技能（用户级）按文件带进备份，导入时本地已有同名技能不覆盖。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params as ArgonParams, Version as ArgonVersion};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{Error, MsgExt, Result};
use crate::mcp;
use crate::providers;
use crate::secrets;
use crate::settings::Settings;
use crate::skills;

const APP: &str = "codearts-desktop";
const KIND: &str = "settings";
/// 口令加密后的外层格式；里面裹着的仍是 KIND 那份明文结构
const KIND_ENC: &str = "settings.encrypted";
const VERSION: u64 = 1;
const CIPHER: &str = "aes-256-gcm";
const KDF: &str = "argon2id";
/// OWASP 给 Argon2id 的常用档位；参数固定，导入时不接受文件里自报的大小（防内存撑爆）
const KDF_M_KIB: u32 = 19456;
const KDF_T: u32 = 2;
const KDF_P: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// 备份只装配置和技能，正常几十 KB；技能带文件后放宽上限，防的是误选了大文件
const MAX_BYTES: u64 = 48 * 1024 * 1024;
/// 技能文件直接进备份：单文件与安装时同一上限，单个技能 8 MiB，全体 24 MiB
const SKILL_FILE_BYTES: usize = 2 * 1024 * 1024;
const SKILL_FILES: usize = 200;
const SKILL_BYTES: usize = 8 * 1024 * 1024;
const SKILL_TOTAL_BYTES: usize = 24 * 1024 * 1024;
const MAX_SKILLS: usize = 64;
/// 字段名里带这些词的都当凭据处理；不加密导出置 null，导入时不覆盖本机已有的值
const SECRET_WORDS: [&str; 8] = [
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "authorization",
    "cookie",
    "credential",
];

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// 开机自启类开关或工作区列表有改动
    pub settings: bool,
    pub workspaces_added: usize,
    pub workspaces_skipped: usize,
    pub providers: usize,
    pub providers_skipped: usize,
    /// 导入后仍没有密钥的提供商数量，需要用户重填
    pub keys_missing: usize,
    pub mcp: usize,
    pub mcp_skipped: usize,
    /// 技能是整目录带走的，恢复时本地已有同名技能不覆盖
    pub skills: usize,
    pub skills_skipped: usize,
    /// 加密备份里的 AK/SK 已写回本机
    pub credentials: bool,
    /// 界面偏好原样交给前端写 localStorage
    pub prefs: Value,
}

pub fn export(
    app: &tauri::AppHandle,
    path: &str,
    prefs: Value,
    passphrase: Option<&str>,
) -> Result<String> {
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty() {
        return Err(Error::Msg("导出路径为空".into()));
    }
    if !path.is_absolute() {
        return Err(Error::Msg("导出路径必须是绝对路径".into()));
    }
    if path.is_dir() {
        return Err(Error::Msg(format!("{} 是个目录，换个文件名", path.display())));
    }

    let settings = Settings::load(app)?;
    let root = providers::read_root(&providers::config_path(app)?)?;
    let skills = collect_skills(&settings)?;
    let pass = passphrase.map(str::trim).filter(|p| !p.is_empty());
    let bundle = match pass {
        Some(pass) => {
            let vault = &providers::vault_key as &dyn Fn(&str) -> Option<String>;
            let mut bundle = build_bundle(&settings, &root, prefs, skills, Some(vault));
            // AK/SK 只有加密备份才带；SK 在这里才第一次离开凭据目录
            if let Some(creds) = credentials()? {
                bundle["credentials"] = creds;
            }
            seal(&bundle, pass)?
        }
        None => build_bundle(&settings, &root, prefs, skills, None),
    };
    write_bundle(&path, &bundle)?;
    Ok(path.display().to_string())
}

fn build_bundle(
    settings: &Settings,
    root: &Value,
    prefs: Value,
    skills: Value,
    vault: Option<&dyn Fn(&str) -> Option<String>>,
) -> Value {
    let mut workspaces = settings.projects.clone().unwrap_or_default();
    if let Some(cur) = settings.project_dir.as_ref() {
        // 老配置只有 projectDir，导出时跟界面一样把它并进列表
        if !cur.trim().is_empty() && !workspaces.iter().any(|w| w == cur) {
            workspaces.insert(0, cur.clone());
        }
    }
    workspaces.retain(|w| !w.trim().is_empty());

    let keep_secrets = vault.is_some();
    let mut provider_map = collect_entries(
        root.get("provider"),
        |id| providers::valid_id(id).is_ok(),
        keep_secrets,
    );
    if let Some(vault) = vault {
        apply_vault_keys(&mut provider_map, root, vault);
    }

    serde_json::json!({
        "app": APP,
        "kind": KIND,
        "version": VERSION,
        "exportedAt": now(),
        "settings": {
            "keepAwake": settings.keep_awake.unwrap_or(false),
            "closeToTray": settings.close_to_tray.unwrap_or(false),
            "workspaces": workspaces,
        },
        "prefs": prefs,
        "providers": provider_map,
        "mcp": collect_entries(
            root.get("mcp"),
            |name| mcp::valid_name(name).is_ok(),
            keep_secrets,
        ),
        "skills": skills,
    })
}

pub fn import(
    app: &tauri::AppHandle,
    path: &str,
    passphrase: Option<&str>,
) -> Result<ImportReport> {
    let path = PathBuf::from(path.trim());
    let text = read_bundle(&path)?;
    let doc: Value = serde_json::from_str(&text).msg("备份文件不是合法 JSON")?;
    let (doc, encrypted) = unwrap_bundle(doc, passphrase)?;
    validate(&doc)?;

    let mut settings = Settings::load(app)?;
    let (settings_changed, workspaces_added, workspaces_skipped) = apply_settings(&mut settings, &doc);
    if settings_changed {
        settings.save(app)?;
    }

    let cfg_path = providers::config_path(app)?;
    let mut root = providers::read_root(&cfg_path)?;
    let mut report = ImportReport {
        settings: settings_changed,
        workspaces_added,
        workspaces_skipped,
        providers: 0,
        providers_skipped: 0,
        keys_missing: 0,
        mcp: 0,
        mcp_skipped: 0,
        skills: 0,
        skills_skipped: 0,
        credentials: false,
        prefs: doc.get("prefs").cloned().unwrap_or(Value::Null),
    };
    if apply_config(&mut root, &doc, &mut report)? {
        providers::write_root(&cfg_path, &root)?;
    }
    restore_skills(&settings, &doc, &mut report);
    if encrypted {
        restore_credentials(&doc, &mut report)?;
        // 内核下次启动会把配置里的明文密钥重新加密回写，这里同时补上壳自己的副本，
        // 否则下一份加密备份又会缺密钥
        vault_imported_keys(&root);
    }
    Ok(report)
}

/// 只判断文件是不是口令加密的，导入前用来决定要不要弹口令框
pub fn is_encrypted(path: &str) -> Result<bool> {
    let text = read_bundle(&PathBuf::from(path.trim()))?;
    let doc: Value = serde_json::from_str(&text).msg("备份文件不是合法 JSON")?;
    Ok(doc.get("kind").and_then(Value::as_str) == Some(KIND_ENC))
}

fn validate(doc: &Value) -> Result<()> {
    if doc.get("app").and_then(Value::as_str) != Some(APP)
        || doc.get("kind").and_then(Value::as_str) != Some(KIND)
    {
        return Err(Error::Msg("这不是本应用的设置备份".into()));
    }
    let version = doc.get("version").and_then(Value::as_u64).unwrap_or(0);
    if version != VERSION {
        return Err(Error::Msg(format!(
            "备份版本 {version} 不受支持，当前只认 {VERSION}"
        )));
    }
    Ok(())
}

/// 明文直接返回；加密的先解开再交给后面的统一校验
fn unwrap_bundle(doc: Value, passphrase: Option<&str>) -> Result<(Value, bool)> {
    match doc.get("kind").and_then(Value::as_str) {
        Some(KIND) => Ok((doc, false)),
        Some(KIND_ENC) => {
            if doc.get("app").and_then(Value::as_str) != Some(APP) {
                return Err(Error::Msg("这不是本应用的设置备份".into()));
            }
            let version = doc.get("version").and_then(Value::as_u64).unwrap_or(0);
            if version != VERSION {
                return Err(Error::Msg(format!(
                    "备份版本 {version} 不受支持，当前只认 {VERSION}"
                )));
            }
            let pass = passphrase
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| Error::Msg("备份已加密，需要口令".into()))?;
            Ok((open(&doc, pass)?, true))
        }
        _ => Err(Error::Msg("这不是本应用的设置备份".into())),
    }
}

fn credentials() -> Result<Option<Value>> {
    let ak = secrets::get(secrets::AK)?;
    let sk = secrets::get(secrets::SK)?;
    match (ak, sk) {
        (Some(ak), Some(sk)) if !ak.trim().is_empty() && !sk.trim().is_empty() => {
            Ok(Some(serde_json::json!({ "ak": ak.trim(), "sk": sk.trim() })))
        }
        _ => Ok(None),
    }
}

fn credentials_of(doc: &Value) -> Option<(&str, &str)> {
    let c = doc.get("credentials")?.as_object()?;
    let ak = c.get("ak")?.as_str().map(str::trim).filter(|s| !s.is_empty())?;
    let sk = c.get("sk")?.as_str().map(str::trim).filter(|s| !s.is_empty())?;
    Some((ak, sk))
}

fn restore_credentials(doc: &Value, report: &mut ImportReport) -> Result<()> {
    let Some((ak, sk)) = credentials_of(doc) else {
        return Ok(());
    };
    secrets::set(secrets::AK, ak)?;
    secrets::set(secrets::SK, sk)?;
    report.credentials = true;
    Ok(())
}

fn vault_imported_keys(root: &Value) {
    let Some(map) = root.get("provider").and_then(Value::as_object) else {
        return;
    };
    for (id, entry) in map {
        if providers::valid_id(id).is_err() {
            continue;
        }
        let key = entry
            .get("options")
            .and_then(|o| o.get("apiKey"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !usable_key(key) {
            continue;
        }
        if let Err(e) = providers::vault_store(id, key) {
            eprintln!("[backup] 保存模型密钥副本失败：{e}");
        }
    }
}

/// 加密备份里的密钥优先取壳的明文副本；盘上已经是 enc: 的换机解不开，留空让用户重填
fn apply_vault_keys(
    providers: &mut Map<String, Value>,
    root: &Value,
    vault: &dyn Fn(&str) -> Option<String>,
) {
    for (id, entry) in providers.iter_mut() {
        let disk = root
            .get("provider")
            .and_then(|p| p.get(id))
            .and_then(|e| e.get("options"))
            .and_then(|o| o.get("apiKey"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let key = vault(id).or_else(|| disk.filter(|k| usable_key(k)));
        if let Some(options) = entry.get_mut("options").and_then(Value::as_object_mut) {
            options.insert("apiKey".into(), key.map(Value::String).unwrap_or(Value::Null));
        }
    }
}

fn usable_key(key: &str) -> bool {
    let k = key.trim();
    !k.is_empty() && !k.starts_with("enc:")
}

/// 用户级技能目录：<内核 HOME>/.codeartsdoer/skills；壳只往这里装
fn skill_dot(settings: &Settings) -> PathBuf {
    settings.kernel_home().join(".codeartsdoer")
}

/// 把清单里记着、目录还在的用户级技能连文件一起收进备份
fn collect_skills(settings: &Settings) -> Result<Value> {
    let dot = skill_dot(settings);
    let manifest = match std::fs::read_to_string(dot.join("skill-manager.json")) {
        Ok(text) => serde_json::from_str::<Value>(&text).unwrap_or(Value::Null),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Array(Vec::new())),
        Err(e) => return Err(Error::Msg(format!("读取技能清单失败：{e}"))),
    };
    let Some(entries) = manifest.get("skills").and_then(Value::as_object) else {
        return Ok(Value::Array(Vec::new()));
    };
    let root = dot.join("skills");
    let mut out = Vec::new();
    let mut total = 0usize;
    for (name, meta) in entries {
        if out.len() >= MAX_SKILLS {
            break;
        }
        if !skills::is_kebab(name) {
            continue;
        }
        let dir = root.join(name);
        if !dir.is_dir() {
            continue;
        }
        let mut files = Map::new();
        let mut used = 0usize;
        collect_skill_files(&dir, &dir, &mut files, &mut used, &mut total)?;
        // 没有 SKILL.md 的目录内核本来就不认，别把残渣打进备份
        if !files.contains_key("SKILL.md") {
            continue;
        }
        out.push(serde_json::json!({
            "name": name,
            "source": meta.get("source").cloned().unwrap_or(Value::Null),
            "repo": meta.get("repo").cloned().unwrap_or(Value::Null),
            "sub": meta.get("sub").cloned().unwrap_or(Value::Null),
            "reference": meta.get("reference").cloned().unwrap_or(Value::Null),
            "installedAt": meta.get("installedAt").cloned().unwrap_or(Value::Null),
            "updatedAt": meta.get("updatedAt").cloned().unwrap_or(Value::Null),
            "files": files,
        }));
    }
    Ok(Value::Array(out))
}

fn collect_skill_files(
    dir: &Path,
    base: &Path,
    files: &mut Map<String, Value>,
    used: &mut usize,
    total: &mut usize,
) -> Result<()> {
    let entries = std::fs::read_dir(dir).msg(format!("读取技能目录 {} 失败", dir.display()))?;
    for entry in entries {
        let entry = entry.msg("读取技能目录失败")?;
        let kind = entry.file_type().msg("读取技能文件类型失败")?;
        // 符号链接可能指向技能目录外，不跟也不备份
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            collect_skill_files(&path, base, files, used, total)?;
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        if files.len() >= SKILL_FILES {
            return Err(Error::Msg(format!(
                "技能 {} 文件数超过 {SKILL_FILES}，先清理后再备份",
                base.display()
            )));
        }
        let rel = path
            .strip_prefix(base)
            .msg("技能文件路径异常")?
            .to_string_lossy()
            .replace('\\', "/");
        skills::safe_rel(&rel)?;
        let bytes = std::fs::read(&path).msg(format!("读取技能文件 {rel} 失败"))?;
        if bytes.len() > SKILL_FILE_BYTES {
            return Err(Error::Msg(format!(
                "技能文件 {rel} 超过 {} MiB，备份放不下",
                SKILL_FILE_BYTES / 1024 / 1024
            )));
        }
        *used += bytes.len();
        *total += bytes.len();
        if *used > SKILL_BYTES || *total > SKILL_TOTAL_BYTES {
            return Err(Error::Msg(format!(
                "技能内容合计超过 {} MiB，先卸载不用的技能再备份",
                SKILL_TOTAL_BYTES / 1024 / 1024
            )));
        }
        files.insert(rel, Value::String(B64.encode(bytes)));
    }
    Ok(())
}

/// 恢复用户级技能：本地已有同名目录就跳过，不覆盖用户后来改过的版本
fn restore_skills(settings: &Settings, doc: &Value, report: &mut ImportReport) {
    let Some(items) = doc.get("skills").and_then(Value::as_array) else {
        return;
    };
    let dot = skill_dot(settings);
    let root = dot.join("skills");
    let manifest_path = dot.join("skill-manager.json");

    let mut total = 0usize;
    let mut restored: Vec<(String, Value)> = Vec::new();
    for item in items {
        match restore_skill(&root, item, &mut total) {
            Ok(Some(meta)) => {
                let name = meta
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                restored.push((name, meta));
            }
            Ok(None) => report.skills_skipped += 1,
            Err(e) => {
                eprintln!("[backup] 恢复技能失败：{e}");
                report.skills_skipped += 1;
            }
        }
    }
    if restored.is_empty() {
        return;
    }
    let mut manifest = match std::fs::read_to_string(&manifest_path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value) => value,
            Err(_) => {
                // 清单坏了就别覆盖它：技能目录已经恢复，丢掉其它技能的记录更糟
                eprintln!("[backup] 技能清单损坏，跳过 {}", manifest_path.display());
                report.skills = restored.len();
                return;
            }
        },
        Err(_) => serde_json::json!({ "version": 1, "skills": {} }),
    };
    if let Some(obj) = manifest.as_object_mut() {
        obj.insert("version".into(), serde_json::json!(1));
        let skills = obj
            .entry("skills".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(map) = skills.as_object_mut() {
            for (name, meta) in &restored {
                map.insert(name.clone(), meta.clone());
            }
        }
    }
    // 清单写不进去也不影响内核扫描目录，最多是壳这边不认它
    let result = (|| -> Result<()> {
        if let Some(dir) = manifest_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = manifest_path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&manifest).unwrap())
            .msg("写入技能清单失败")?;
        std::fs::rename(&tmp, &manifest_path).msg("写入技能清单失败")
    })();
    if let Err(e) = result {
        eprintln!("[backup] 技能清单写入失败：{e}");
    }
    report.skills = restored.len();
}

fn restore_skill(root: &Path, item: &Value, total: &mut usize) -> Result<Option<Value>> {
    let Some(name) = item
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| skills::is_kebab(n))
    else {
        return Ok(None);
    };
    let Some(files) = item.get("files").and_then(Value::as_object) else {
        return Ok(None);
    };
    if files.len() > SKILL_FILES || !files.get("SKILL.md").is_some_and(Value::is_string) {
        return Ok(None);
    }
    let dest = root.join(name);
    // 本地已有同名技能：用户的版本比备份新，不覆盖
    if dest.exists() {
        return Ok(None);
    }
    std::fs::create_dir_all(root).msg("创建技能目录失败")?;
    let staging = root.join(format!(".{name}.restore-{}", now()));
    let _ = std::fs::remove_dir_all(&staging);
    let mut used = 0usize;
    let written = (|| -> Result<()> {
        std::fs::create_dir_all(&staging)?;
        for (rel, value) in files {
            skills::safe_rel(rel)?;
            let text = value
                .as_str()
                .ok_or_else(|| Error::Msg(format!("技能 {name} 的文件内容不是 base64")))?;
            let bytes = B64
                .decode(text)
                .map_err(|_| Error::Msg(format!("技能 {name} 的文件内容不是合法 base64")))?;
            if bytes.len() > SKILL_FILE_BYTES {
                return Err(Error::Msg(format!("技能 {name} 的文件超过单文件上限")));
            }
            used += bytes.len();
            if used > SKILL_BYTES || *total + used > SKILL_TOTAL_BYTES {
                return Err(Error::Msg("导入的技能内容超过上限".into()));
            }
            let target = staging.join(rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&target, bytes)
                .map_err(|e| Error::Msg(format!("写入技能 {name}/{rel} 失败：{e}")))?;
        }
        Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    if let Err(e) = std::fs::rename(&staging, &dest) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(Error::Msg(format!("落盘技能 {name} 失败：{e}")));
    }
    *total += used;
    // 只写内核和壳都认的字段；备份是文本，类型不对的 metadata 会弄坏技能清单
    let text = |key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let at = |key: &str| {
        item.get(key)
            .and_then(Value::as_u64)
            .unwrap_or_else(|| now().saturating_mul(1000))
    };
    let mut meta = Map::new();
    meta.insert("name".into(), Value::String(name.to_string()));
    for key in ["source", "repo", "sub", "reference"] {
        if let Some(value) = text(key) {
            meta.insert(key.to_string(), Value::String(value));
        }
    }
    meta.insert("installedAt".into(), serde_json::json!(at("installedAt")));
    meta.insert("updatedAt".into(), serde_json::json!(at("updatedAt")));
    Ok(Some(Value::Object(meta)))
}

fn seal(bundle: &Value, passphrase: &str) -> Result<Value> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let key = derive(passphrase, &salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|_| Error::Msg("加密初始化失败".into()))?;
    let plain = serde_json::to_vec(bundle)?;
    let aad = aad();
    let data = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: &plain, aad: aad.as_bytes() },
        )
        .map_err(|_| Error::Msg("加密备份失败".into()))?;
    Ok(serde_json::json!({
        "app": APP,
        "kind": KIND_ENC,
        "version": VERSION,
        "exportedAt": now(),
        "crypto": {
            "cipher": CIPHER,
            "kdf": KDF,
            "mKiB": KDF_M_KIB,
            "iterations": KDF_T,
            "parallelism": KDF_P,
            "salt": B64.encode(salt),
            "nonce": B64.encode(nonce),
            "data": B64.encode(data),
        },
    }))
}

fn open(bundle: &Value, passphrase: &str) -> Result<Value> {
    let c = bundle
        .get("crypto")
        .and_then(Value::as_object)
        .ok_or_else(|| Error::Msg("加密备份缺少参数，文件已损坏".into()))?;
    let bad = || Error::Msg("加密备份参数不受支持，文件已损坏或来自更新版本".into());
    for (key, want) in [("cipher", CIPHER), ("kdf", KDF)] {
        if c.get(key).and_then(Value::as_str) != Some(want) {
            return Err(bad());
        }
    }
    if c.get("mKiB").and_then(Value::as_u64) != Some(KDF_M_KIB as u64)
        || c.get("iterations").and_then(Value::as_u64) != Some(KDF_T as u64)
        || c.get("parallelism").and_then(Value::as_u64) != Some(KDF_P as u64)
    {
        return Err(bad());
    }
    let salt = decode(c, "salt")?;
    let nonce = decode(c, "nonce")?;
    let data = decode(c, "data")?;
    if salt.len() != SALT_LEN || nonce.len() != NONCE_LEN {
        return Err(bad());
    }
    let key = derive(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| bad())?;
    let aad = aad();
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: &data, aad: aad.as_bytes() },
        )
        .map_err(|_| Error::Msg("口令不对，或备份已损坏".into()))?;
    serde_json::from_slice(&plain)
        .map_err(|_| Error::Msg("备份内容不是合法 JSON，文件已损坏".into()))
}

fn decode(c: &Map<String, Value>, key: &str) -> Result<Vec<u8>> {
    let text = c
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Msg("加密备份缺少参数，文件已损坏".into()))?;
    B64.decode(text)
        .map_err(|_| Error::Msg("加密备份参数不是合法 base64".into()))
}

fn derive(passphrase: &str, salt: &[u8]) -> Result<[u8; KEY_LEN]> {
    let params = ArgonParams::new(KDF_M_KIB, KDF_T, KDF_P, Some(KEY_LEN))
        .map_err(|_| Error::Msg("口令派生参数无效".into()))?;
    let argon = Argon2::new(Algorithm::Argon2id, ArgonVersion::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| Error::Msg("口令派生失败".into()))?;
    Ok(key)
}

fn aad() -> String {
    format!("{APP}|{KIND_ENC}|v{VERSION}")
}

fn apply_config(root: &mut Value, doc: &Value, report: &mut ImportReport) -> Result<bool> {
    let mut changed = false;
    if let Some(section) = doc.get("providers").and_then(Value::as_object) {
        let target = section_mut(root, "provider")?;
        for (id, entry) in section {
            let Some(entry) = entry.as_object() else {
                report.providers_skipped += 1;
                continue;
            };
            // models / options 形状不对会让内核把整家提供商读坏，宁可跳过
            if providers::valid_id(id).is_err()
                || !entry.get("models").map_or(true, Value::is_object)
                || !entry.get("options").map_or(true, Value::is_object)
            {
                report.providers_skipped += 1;
                continue;
            }
            let mut clean = Value::Object(entry.clone());
            scrub_imported(&mut clean);
            let slot = target.entry(id.clone()).or_insert_with(|| Value::Object(Map::new()));
            merge_into(slot, &clean);
            report.providers += 1;
            let key = slot
                .get("options")
                .and_then(|o| o.get("apiKey"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if key.trim().is_empty() {
                report.keys_missing += 1;
            }
        }
        changed |= report.providers > 0;
    }

    if let Some(section) = doc.get("mcp").and_then(Value::as_object) {
        let target = section_mut(root, "mcp")?;
        for (name, config) in section {
            if mcp::valid_name(name).is_err() || !config.is_object() {
                report.mcp_skipped += 1;
                continue;
            }
            let mut clean = config.clone();
            scrub_imported(&mut clean);
            let slot = target.entry(name.clone()).or_insert_with(|| Value::Object(Map::new()));
            merge_into(slot, &clean);
            report.mcp += 1;
        }
        changed |= report.mcp > 0;
    }
    Ok(changed)
}

fn apply_settings(settings: &mut Settings, doc: &Value) -> (bool, usize, usize) {
    let mut changed = false;
    let mut added = 0;
    let mut skipped = 0;

    if let Some(s) = doc.get("settings").and_then(Value::as_object) {
        if let Some(v) = s.get("keepAwake").and_then(Value::as_bool) {
            changed |= settings.keep_awake != Some(v);
            settings.keep_awake = Some(v);
        }
        if let Some(v) = s.get("closeToTray").and_then(Value::as_bool) {
            changed |= settings.close_to_tray != Some(v);
            settings.close_to_tray = Some(v);
        }
        let mut list = settings.projects.clone().unwrap_or_default();
        for ws in s.get("workspaces").and_then(Value::as_array).into_iter().flatten() {
            let Some(ws) = ws.as_str().map(str::trim).filter(|w| !w.is_empty()) else {
                continue;
            };
            // 别的机器上的路径到这里多半不存在；留着只会换来一个打不开的工作区
            if !Path::new(ws).is_dir() {
                skipped += 1;
                continue;
            }
            if list.iter().any(|x| x == ws) {
                continue;
            }
            list.push(ws.to_string());
            added += 1;
        }
        if added > 0 {
            settings.projects = Some(list);
            changed = true;
        }
    }

    (changed, added, skipped)
}

/// 只取合法的顶层条目；不加密导出时再把凭据字段抹成 null
fn collect_entries(
    section: Option<&Value>,
    valid: impl Fn(&str) -> bool,
    keep_secrets: bool,
) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(map) = section.and_then(Value::as_object) else {
        return out;
    };
    for (key, value) in map {
        if !value.is_object() || !valid(key) {
            continue;
        }
        let mut clean = value.clone();
        if !keep_secrets {
            redact(&mut clean);
        }
        out.insert(key.clone(), clean);
    }
    out
}

fn redact(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if secret_key(key) {
                    *child = Value::Null;
                } else {
                    redact(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact),
        _ => {}
    }
}

/// 导入方向把「没用的凭据」也抹成 null：空串会覆盖本机旧值，enc: 是内核在本机加密的，换机解不开
fn scrub_imported(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if secret_key(key) {
                    let dead = match child {
                        Value::String(s) => s.trim().is_empty() || s.starts_with("enc:"),
                        Value::Null => true,
                        _ => false,
                    };
                    if dead {
                        *child = Value::Null;
                    }
                }
                scrub_imported(child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub_imported),
        _ => {}
    }
}

fn secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|w| lower.contains(w))
}

/// 导入合并：备份里有值的键覆盖本地，null 是脱敏占位（本地有值就保留）；对象逐层合并。
fn merge_into(dst: &mut Value, src: &Value) {
    match (dst, src) {
        (Value::Object(d), Value::Object(s)) => {
            for (key, value) in s {
                if value.is_null() {
                    if d.get(key).map_or(true, Value::is_null) {
                        d.remove(key);
                    }
                    continue;
                }
                match d.get_mut(key) {
                    Some(child) => merge_into(child, value),
                    None => {
                        // 本地没有这个键也要走一遍合并：子对象里的脱敏 null 不能原样带进来
                        let mut empty = Value::Object(Map::new());
                        merge_into(&mut empty, value);
                        d.insert(key.clone(), empty);
                    }
                }
            }
        }
        (dst, src) => *dst = src.clone(),
    }
}

fn section_mut<'a>(
    root: &'a mut Value,
    name: &str,
) -> Result<&'a mut Map<String, Value>> {
    let obj = root
        .as_object_mut()
        .ok_or_else(|| Error::Msg("配置文件顶层不是对象".into()))?;
    let section = obj
        .entry(name.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    section
        .as_object_mut()
        .ok_or_else(|| Error::Msg(format!("配置里的 {name} 不是对象，先手工修好再导入")))
}

fn write_bundle(path: &Path, bundle: &Value) -> Result<()> {
    if path.is_dir() {
        return Err(Error::Msg(format!("{} 是个目录，换个文件名", path.display())));
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| Error::Msg("导出路径缺少所在目录".into()))?;
    std::fs::create_dir_all(dir).msg(format!("无法创建目录 {}", dir.display()))?;
    let body = serde_json::to_string_pretty(bundle).unwrap() + "\n";
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).msg(format!("写入 {} 失败", tmp.display()))?;
    // 备份里有工作区路径和供应商配置，即使抹掉了密钥也别留成同组可读
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .msg("无法收紧备份文件权限")?;
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).msg(format!("保存 {} 失败", path.display()));
    }
    Ok(())
}

fn read_bundle(path: &Path) -> Result<String> {
    let meta = std::fs::metadata(path).msg(format!("读取 {} 失败", path.display()))?;
    if !meta.is_file() {
        return Err(Error::Msg(format!("{} 不是文件", path.display())));
    }
    if meta.len() > MAX_BYTES {
        return Err(Error::Msg(format!(
            "备份文件 {} MB，超过 {} MB 上限",
            meta.len() / 1024 / 1024,
            MAX_BYTES / 1024 / 1024
        )));
    }
    std::fs::read_to_string(path).msg(format!("读取 {} 失败", path.display()))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provider_fixture() -> Value {
        serde_json::json!({
            "name": "中转",
            "npm": "@ai-sdk/openai-compatible",
            "options": {
                "baseURL": "https://api.example/v1",
                "apiKey": "sk-secret-value",
                "headers": { "Authorization": "Bearer abc", "x-trace": "1" }
            },
            "models": { "m1": { "id": "m1", "limit": { "context": 1, "output": 1 } } }
        })
    }

    /// 导出的备份里不能出现任何密钥字符，但结构要完整到能导回去
    #[test]
    fn export_redacts_secrets_and_keeps_shape() {
        let mut clean = provider_fixture();
        redact(&mut clean);
        let text = clean.to_string();
        assert!(!text.contains("sk-secret-value"));
        assert!(!text.contains("Bearer abc"));
        assert_eq!(clean["options"]["apiKey"], Value::Null);
        assert_eq!(clean["options"]["headers"]["Authorization"], Value::Null);
        assert_eq!(clean["options"]["headers"]["x-trace"], "1");
        assert_eq!(clean["options"]["baseURL"], "https://api.example/v1");
        assert_eq!(clean["models"]["m1"]["limit"]["context"], 1);
    }

    /// 换机恢复：本地没密钥时不会留下 null；本机恢复：原有密钥和界面不认识的键都保留
    #[test]
    fn import_merges_and_keeps_local_keys() {
        let mut clean = provider_fixture();
        redact(&mut clean);

        let mut fresh = Value::Object(Map::new());
        merge_into(&mut fresh, &clean);
        assert!(fresh.get("options").unwrap().get("apiKey").is_none());
        assert_eq!(fresh["options"]["baseURL"], "https://api.example/v1");

        let mut local = serde_json::json!({
            "unknownTop": { "keep": true },
            "options": {
                "baseURL": "https://old.example/v1",
                "apiKey": "enc:v3:local",
                "timeout": 120000
            },
            "models": { "m1": { "cost": { "input": 1 } } }
        });
        merge_into(&mut local, &clean);
        assert_eq!(local["options"]["apiKey"], "enc:v3:local", "本地密钥不能被脱敏占位清掉");
        assert_eq!(local["options"]["timeout"], 120000);
        assert_eq!(local["unknownTop"]["keep"], true);
        assert_eq!(local["models"]["m1"]["cost"]["input"], 1);
        assert_eq!(local["options"]["baseURL"], "https://api.example/v1", "备份里的地址要覆盖旧值");
    }

    /// enc: 是内核在本机加密的，换机导入等于没有；空串也不该把本地值冲掉
    #[test]
    fn imported_encrypted_or_empty_keys_become_placeholders() {
        let mut v = serde_json::json!({
            "options": { "apiKey": "enc:v3:fff", "timeout": 120000 },
            "headers": { "X-Api-Key": "" }
        });
        scrub_imported(&mut v);
        let mut local = serde_json::json!({
            "options": { "apiKey": "sk-local" },
            "headers": { "X-Api-Key": "real" }
        });
        merge_into(&mut local, &v);
        assert_eq!(local["options"]["apiKey"], "sk-local");
        assert_eq!(local["headers"]["X-Api-Key"], "real");
        assert_eq!(local["options"]["timeout"], 120000);
    }

    /// 导出 → 导入整条链：模型和 MCP 能还原形状，密钥不跟着走，本机已有密钥不被覆盖
    #[test]
    fn bundle_round_trip_restores_config_without_secrets() {
        let ws = std::env::temp_dir().join(format!(
            "codearts-backup-ws-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(&ws).unwrap();
        let ws = ws.display().to_string();

        let settings = Settings {
            projects: Some(vec![ws.clone()]),
            keep_awake: Some(true),
            close_to_tray: Some(false),
            ..Default::default()
        };
        let root = serde_json::json!({
            "provider": {
                "relay": provider_fixture(),
                "huaweicloud-maas": { "options": { "apiKey": "enc:keep" } }
            },
            "mcp": {
                "gh": {
                    "type": "stdio",
                    "command": "npx",
                    "environment": { "GITHUB_TOKEN": "ghp_x", "PLAIN": "1" }
                },
                "bad name": { "type": "stdio" }
            }
        });
        let bundle = build_bundle(
            &settings,
            &root,
            serde_json::json!({ "theme": "dark" }),
            Value::Array(Vec::new()),
            None,
        );
        let text = bundle.to_string();
        assert!(!text.contains("sk-secret-value"));
        assert!(!text.contains("ghp_x"));
        assert!(!text.contains("enc:keep"));
        // 内核自带的提供商不归壳管，不出现在备份里
        assert!(bundle["providers"].get("huaweicloud-maas").is_none());

        let mut target = Settings::default();
        let (changed, added, skipped) = apply_settings(&mut target, &bundle);
        assert!(changed);
        assert_eq!((added, skipped), (1, 0));
        assert_eq!(target.projects.unwrap(), vec![ws.clone()]);
        assert_eq!(target.keep_awake, Some(true));
        assert_eq!(target.close_to_tray, Some(false));

        // 手工改过的备份里可能有壳不认的条目，导入时要跳过而不是报错整份失败
        let mut hand = bundle.clone();
        hand["providers"]["huaweicloud-maas"] = serde_json::json!({});
        hand["providers"]["weird"] = serde_json::json!({ "models": [] });
        hand["mcp"]["bad name"] = serde_json::json!({});
        let mut fresh = serde_json::json!({});
        let mut report = ImportReport::default();
        assert!(apply_config(&mut fresh, &hand, &mut report).unwrap());
        assert_eq!((report.providers, report.providers_skipped), (1, 2));
        assert_eq!(report.keys_missing, 1);
        assert_eq!((report.mcp, report.mcp_skipped), (1, 1));
        assert_eq!(fresh["provider"]["relay"]["options"]["baseURL"], "https://api.example/v1");
        assert!(fresh["provider"]["relay"]["options"].get("apiKey").is_none());
        assert_eq!(fresh["provider"]["relay"]["options"]["headers"]["x-trace"], "1");
        assert_eq!(fresh["provider"]["relay"]["models"]["m1"]["limit"]["output"], 1);
        assert!(fresh["mcp"]["gh"]["environment"].get("GITHUB_TOKEN").is_none());
        assert_eq!(fresh["mcp"]["gh"]["environment"]["PLAIN"], "1");
        assert_eq!(fresh["mcp"]["gh"]["command"], "npx");

        // 本机已有密钥：再导一次保留原值，也不再计入 keys_missing
        let mut again = fresh.clone();
        again["provider"]["relay"]["options"]["apiKey"] = serde_json::json!("sk-local");
        let mut report = ImportReport::default();
        apply_config(&mut again, &bundle, &mut report).unwrap();
        assert_eq!(again["provider"]["relay"]["options"]["apiKey"], "sk-local");
        assert_eq!(report.keys_missing, 0);

        let _ = std::fs::remove_dir_all(&ws);
    }

    /// 备份文件只给本人读；父目录不存在时连同目录一起建出来
    #[test]
    fn writes_backup_with_owner_only_permissions() {
        let dir = std::env::temp_dir().join(format!(
            "codearts-backup-file-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        let path = dir.join("nested").join("settings.json");
        write_bundle(&path, &serde_json::json!({ "app": APP })).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "备份里可能还有路径信息，不该同组可读");
        }
        // 落盘 → 读回 → 解析，形状和内存里的备份一致
        let settings = Settings {
            keep_awake: Some(true),
            ..Default::default()
        };
        let root = serde_json::json!({ "provider": { "relay": provider_fixture() } });
        write_bundle(
            &path,
            &build_bundle(&settings, &root, Value::Null, Value::Array(Vec::new()), None),
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&read_bundle(&path).unwrap()).unwrap();
        assert_eq!(doc["settings"]["keepAwake"], true);
        assert_eq!(doc["providers"]["relay"]["options"]["baseURL"], "https://api.example/v1");
        assert!(doc["providers"]["relay"]["options"]["apiKey"].is_null());
        // 目标是个目录时明确报错，别把临时文件留在旁边
        assert!(write_bundle(&dir, &serde_json::json!({})).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn secret_key_matches_common_spellings() {
        for k in ["apiKey", "api_key", "X-Api-Key", "GITHUB_TOKEN", "password", "Authorization", "client_secret"] {
            assert!(secret_key(k), "{k} 应视为凭据");
        }
        for k in ["baseURL", "timeout", "reasoning", "context", "model"] {
            assert!(!secret_key(k), "{k} 不该被视为凭据");
        }
    }

    /// 口令加密：原文不出现在文件里，口令对了能原样解开，错口令和改过的密文都要拒绝
    #[test]
    fn passphrase_sealed_backup_round_trips() {
        let bundle = serde_json::json!({
            "app": APP,
            "kind": KIND,
            "version": VERSION,
            "providers": { "relay": { "options": { "apiKey": "sk-secret-value" } } }
        });
        let sealed = seal(&bundle, "correct horse").unwrap();
        assert_eq!(sealed["kind"], KIND_ENC);
        assert!(!sealed.to_string().contains("sk-secret-value"));

        assert_eq!(open(&sealed, "correct horse").unwrap(), bundle);
        assert!(open(&sealed, "wrong").is_err());
        assert!(open(&sealed, "").is_err());

        // 改一个字节就解不开，不会悄悄返回半份配置
        let mut tampered = sealed.clone();
        let mut raw = B64.decode(tampered["crypto"]["data"].as_str().unwrap()).unwrap();
        raw[0] ^= 1;
        tampered["crypto"]["data"] = B64.encode(raw).into();
        assert!(open(&tampered, "correct horse").is_err());

        // 外层缺口令时明确拒绝，别当成明文备份继续走
        assert!(unwrap_bundle(sealed.clone(), None).is_err());
        assert!(unwrap_bundle(sealed, Some("correct horse")).unwrap().1);
    }

    /// 加密导出：模型密钥优先用壳留的明文副本；盘上 enc: 的换机解不开，留空
    #[test]
    fn encrypted_export_prefers_plaintext_vault_keys() {
        let root = serde_json::json!({
            "provider": {
                "relay": { "options": {
                    "baseURL": "https://api.example/v1",
                    "apiKey": "enc:v3:disk",
                    "headers": { "Authorization": "Bearer abc" }
                } },
                "other": { "options": { "apiKey": "enc:v3:other" } },
                "plain": { "options": { "apiKey": "sk-disk-plain" } }
            }
        });
        let settings = Settings::default();
        let vault = |id: &str| (id == "relay").then(|| "sk-vault".to_string());
        let full = build_bundle(
            &settings,
            &root,
            Value::Null,
            Value::Array(Vec::new()),
            Some(&vault as &dyn Fn(&str) -> Option<String>),
        );
        assert_eq!(full["providers"]["relay"]["options"]["apiKey"], "sk-vault");
        assert_eq!(
            full["providers"]["relay"]["options"]["headers"]["Authorization"],
            "Bearer abc",
            "加密备份连 headers 里的凭据一起带走"
        );
        assert!(full["providers"]["other"]["options"]["apiKey"].is_null());
        assert_eq!(full["providers"]["plain"]["options"]["apiKey"], "sk-disk-plain");

        // 不加密时不带上任何密钥
        let plain = build_bundle(
            &settings,
            &root,
            Value::Null,
            Value::Array(Vec::new()),
            None,
        );
        assert!(plain["providers"]["relay"]["options"]["apiKey"].is_null());
        assert!(plain["providers"]["plain"]["options"]["apiKey"].is_null());
        assert!(plain["providers"]["relay"]["options"]["headers"]["Authorization"].is_null());
    }

    #[test]
    fn credentials_only_come_from_full_backups() {
        let doc = serde_json::json!({ "credentials": { "ak": "AK1", "sk": " SK1 " } });
        assert_eq!(credentials_of(&doc), Some(("AK1", "SK1")));
        assert_eq!(
            credentials_of(&serde_json::json!({ "credentials": { "ak": "", "sk": "x" } })),
            None
        );
        assert_eq!(credentials_of(&serde_json::json!({ "settings": {} })), None);
    }

    /// 技能连文件一起备份；导入到另一个 HOME 后目录和清单都成立，同名不覆盖
    #[test]
    fn skills_round_trip_through_backup() {
        let base = std::env::temp_dir().join(format!(
            "codearts-backup-skills-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        let home_a = base.join("a");
        let dot = home_a.join(".codeartsdoer");
        let skill = dot.join("skills").join("demo");
        std::fs::create_dir_all(skill.join("ref")).unwrap();
        std::fs::write(skill.join("SKILL.md"), "---\nname: demo\ndescription: 演示\n---\n").unwrap();
        std::fs::write(skill.join("ref").join("note.md"), "用法").unwrap();
        // 链接指向技能目录外，不该被打进备份
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", skill.join("escape")).unwrap();
        std::fs::write(
            dot.join("skill-manager.json"),
            serde_json::json!({
                "version": 1,
                "skills": {
                    "demo": {
                        "name": "demo",
                        "source": "foo/bar/skills/demo@v1",
                        "repo": "foo/bar",
                        "sub": "skills/demo",
                        "reference": "v1",
                        "installedAt": 1,
                        "updatedAt": 2
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

        let settings_a = Settings {
            kernel_home: Some(home_a.display().to_string()),
            ..Default::default()
        };
        let skills_value = collect_skills(&settings_a).unwrap();
        let items = skills_value.as_array().unwrap();
        assert_eq!(items.len(), 1);
        let files = items[0]["files"].as_object().unwrap();
        assert!(files.contains_key("SKILL.md"));
        assert!(files.contains_key("ref/note.md"));
        assert!(!files.contains_key("escape"));

        let home_b = base.join("b");
        let settings_b = Settings {
            kernel_home: Some(home_b.display().to_string()),
            ..Default::default()
        };
        let doc = serde_json::json!({ "skills": skills_value });
        let mut report = ImportReport::default();
        restore_skills(&settings_b, &doc, &mut report);
        assert_eq!((report.skills, report.skills_skipped), (1, 0));
        let restored = home_b.join(".codeartsdoer").join("skills").join("demo");
        assert!(restored.join("SKILL.md").is_file());
        assert_eq!(std::fs::read_to_string(restored.join("ref/note.md")).unwrap(), "用法");
        let manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(
                home_b.join(".codeartsdoer").join("skill-manager.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["skills"]["demo"]["source"], "foo/bar/skills/demo@v1");
        assert_eq!(manifest["skills"]["demo"]["updatedAt"], 2);

        // 再导一次：本地已有同名技能，跳过而不是覆盖
        let mut report = ImportReport::default();
        restore_skills(&settings_b, &doc, &mut report);
        assert_eq!((report.skills, report.skills_skipped), (0, 1));

        // 备份里的路径不可信：越界条目整条跳过，不落盘
        let bad = serde_json::json!({
            "skills": [{ "name": "evil", "files": { "SKILL.md": "aGk=", "../escape.md": "aGk=" } }]
        });
        let mut report = ImportReport::default();
        restore_skills(&settings_b, &bad, &mut report);
        assert_eq!((report.skills, report.skills_skipped), (0, 1));
        assert!(!base.join("escape.md").exists());

        // 清单损坏：技能目录照常恢复，但不能把坏清单覆盖掉
        let manifest_path = home_b.join(".codeartsdoer").join("skill-manager.json");
        std::fs::write(&manifest_path, "not json").unwrap();
        let extra = serde_json::json!({
            "skills": [{ "name": "extra", "files": { "SKILL.md": "aGk=" } }]
        });
        let mut report = ImportReport::default();
        restore_skills(&settings_b, &extra, &mut report);
        assert_eq!(report.skills, 1);
        assert_eq!(std::fs::read_to_string(&manifest_path).unwrap(), "not json");
        assert!(home_b
            .join(".codeartsdoer")
            .join("skills")
            .join("extra")
            .join("SKILL.md")
            .is_file());

        let _ = std::fs::remove_dir_all(&base);
    }
}
