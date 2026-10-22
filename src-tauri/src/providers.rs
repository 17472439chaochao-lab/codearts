use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{Error, MsgExt, Result};
use crate::settings::Settings;

/// 内核 `custom-model-loader` 读取的全局配置文件名，按顺序取第一个存在的。
/// 与壳注入给 serve 的 `OPENCODE_CONFIG_FILE` 保持一致。
const CONFIG_NAMES: [&str; 2] = ["codearts_cli.json", "codearts_cli.jsonc"];
/// 这两个 provider 归内核自己装配，接第三方时不能占用
const RESERVED: [&str; 2] = ["huaweicloud-maas", "benefit-model"];
/// 内核 boot 时会把明文 apiKey 就地加密成这个前缀再写回文件
const ENCRYPTED_PREFIX: &str = "enc:";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    id: String,
    name: String,
    context: u64,
    output: u64,
    reasoning: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    id: String,
    name: String,
    npm: String,
    base_url: String,
    /// 密钥只回显形态，真实字符不出 Rust
    key_mask: Option<String>,
    models: Vec<ModelView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledModel {
    id: String,
    context: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDraft {
    id: String,
    #[serde(default)]
    name: Option<String>,
    context: u64,
    output: u64,
    #[serde(default)]
    reasoning: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDraft {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    npm: Option<String>,
    base_url: String,
    /// 留空表示沿用盘上已有的密钥，改名称或加模型时不必重填
    #[serde(default)]
    api_key: Option<String>,
    models: Vec<ModelDraft>,
}

/// 内核全局配置里 provider 段落所在文件；不存在时按首选名字新建
fn config_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = Settings::load(app)?.kernel_home().join(".codeartsdoer");
    for name in CONFIG_NAMES {
        let p = dir.join(name);
        if p.is_file() {
            return Ok(p);
        }
    }
    Ok(dir.join(CONFIG_NAMES[0]))
}

fn read_root(path: &Path) -> Result<Value> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Value::Object(Map::new())),
        Ok(text) => serde_json::from_str(&text).msg(format!("配置文件不是合法 JSON：{}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(e) => Err(e).msg(format!("读取 {}", path.display())),
    }
}

/// 只改 provider 下对应的那一项，其余键原样保留；先落临时文件再原子替换
fn write_root(path: &Path, root: &Value) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).msg(format!("无法创建 {}", dir.display()))?;
    }
    let body = serde_json::to_string_pretty(root).unwrap() + "\n";
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body).msg(format!("写入 {}", path.display()))?;
    // 这里存着第三方服务的密钥，别留成同组可读
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
        .msg("无法收紧配置文件权限")?;
    std::fs::rename(&tmp, path).msg("保存配置失败")
}

fn providers_of<'a>(root: &'a Value) -> &'a Map<String, Value> {
    root.get("provider")
        .and_then(Value::as_object)
        .unwrap_or_else(|| EMPTY_PROVIDERS.get_or_init(Map::new))
}

static EMPTY_PROVIDERS: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn key_mask(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with(ENCRYPTED_PREFIX) {
        return Some("已加密".into());
    }
    let chars: Vec<char> = raw.chars().collect();
    Some(if chars.len() <= 4 {
        "****".into()
    } else {
        format!("****{}", chars.iter().skip(chars.len() - 4).collect::<String>())
    })
}

fn to_view(id: &str, entry: &Value) -> ProviderView {
    let models = entry
        .get("models")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(mid, mv)| ModelView {
                    id: mid.clone(),
                    name: {
                        let n = str_field(mv, "id");
                        if n.is_empty() { mid.clone() } else { n }
                    },
                    context: mv.get("limit").and_then(|l| l.get("context")).and_then(Value::as_u64).unwrap_or(0),
                    output: mv.get("limit").and_then(|l| l.get("output")).and_then(Value::as_u64).unwrap_or(0),
                    reasoning: mv.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default();
    let name = {
        let n = str_field(entry, "name");
        if n.is_empty() { id.to_string() } else { n }
    };
    ProviderView {
        id: id.to_string(),
        name,
        npm: {
            let n = str_field(entry, "npm");
            if n.is_empty() { DEFAULT_NPM.to_string() } else { n }
        },
        base_url: entry
            .get("options")
            .and_then(|o| o.get("baseURL"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        key_mask: entry
            .get("options")
            .and_then(|o| o.get("apiKey"))
            .and_then(Value::as_str)
            .and_then(|s| key_mask(s)),
        models,
    }
}

pub const DEFAULT_NPM: &str = "@ai-sdk/openai-compatible";

fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 64 {
        return Err(Error::Msg("提供商标识不能为空且不超过 64 个字符".into()));
    }
    if RESERVED.contains(&id) {
        return Err(Error::Msg(format!("「{id}」是内核自带的提供商，换一个标识")));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(Error::Msg("提供商标识只能用字母、数字、点、下划线和连字符".into()));
    }
    Ok(())
}

fn valid_base_url(url: &str) -> Result<()> {
    let u = reqwest::Url::parse(url).msg("服务地址无法解析");
    match u {
        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => Ok(()),
        Ok(u) => Err(Error::Msg(format!("服务地址只支持 http/https，收到 {}", u.scheme()))),
        Err(e) => Err(e),
    }
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<ProviderView>> {
    let root = read_root(&config_path(app)?)?;
    let mut out: Vec<ProviderView> = providers_of(&root)
        .iter()
        .filter(|(id, _)| !RESERVED.contains(&id.as_str()))
        .map(|(id, entry)| to_view(id, entry))
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub fn save(app: &tauri::AppHandle, draft: ProviderDraft) -> Result<Vec<ProviderView>> {
    valid_id(&draft.id)?;
    valid_base_url(draft.base_url.trim())?;
    if draft.models.is_empty() {
        return Err(Error::Msg("至少填一个模型".into()));
    }
    let path = config_path(app)?;
    let mut root = read_root(&path)?;
    merge_draft(&mut root, &draft)?;
    write_root(&path, &root)?;
    list(app)
}

/// 把草稿并进全局配置的 provider 段。与盘上已有条目逐键合并：
/// 界面不认识的键（`options.headers`、模型上的 `cost` 等）原样保留。
fn merge_draft(root: &mut Value, draft: &ProviderDraft) -> Result<()> {
    // 密钥留空 = 沿用盘上原值（内核会把明文加密回写，所以原值可能是 enc:v3:）
    let existing = providers_of(root).get(&draft.id).cloned();
    let kept_key = existing
        .as_ref()
        .and_then(|e| e.get("options"))
        .and_then(|o| o.get("apiKey"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let api_key = match draft.api_key.as_deref().map(str::trim) {
        Some(new) if !new.is_empty() => new.to_string(),
        _ => kept_key,
    };

    // 盘上条目里可能有界面上没有的键（options.headers / timeout、模型上的 cost / attachment），
    // 逐键覆盖而不是整块重建，否则保存一次就悄悄丢掉一片配置
    let prev_entry = existing.as_ref().and_then(Value::as_object).cloned();
    let prev_options = prev_entry
        .as_ref()
        .and_then(|e| e.get("options"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let prev_models = prev_entry
        .as_ref()
        .and_then(|e| e.get("models"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut models = Map::new();
    for m in &draft.models {
        let id = m.id.trim().to_string();
        if id.is_empty() {
            return Err(Error::Msg("模型 ID 不能为空".into()));
        }
        if m.context == 0 || m.output == 0 {
            return Err(Error::Msg(format!(
                "模型「{id}」的上下文和最大输出都要填大于 0 的 token 数"
            )));
        }
        let mut entry = prev_models
            .get(&id)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let name = m.name.as_deref().map(str::trim).filter(|n| !n.is_empty());
        entry.insert(
            "id".into(),
            Value::String(name.unwrap_or(id.as_str()).to_string()),
        );
        if m.reasoning.unwrap_or(false) {
            entry.insert("reasoning".into(), Value::Bool(true));
        } else {
            entry.remove("reasoning");
        }
        entry.insert(
            "limit".into(),
            serde_json::json!({ "context": m.context, "output": m.output }),
        );
        models.insert(id, Value::Object(entry));
    }

    let mut options = prev_options;
    options.insert("baseURL".into(), Value::String(draft.base_url.trim().to_string()));
    if !api_key.is_empty() {
        options.insert("apiKey".into(), Value::String(api_key));
    }
    let mut entry = prev_entry.unwrap_or_default();
    match draft.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => {
            entry.insert("name".into(), Value::String(name.to_string()));
        }
        None => {
            entry.remove("name");
        }
    }
    entry.insert(
        "npm".into(),
        Value::String(
            draft
                .npm
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(DEFAULT_NPM)
                .to_string(),
        ),
    );
    entry.insert("options".into(), Value::Object(options));
    entry.insert("models".into(), Value::Object(models));

    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| Error::Msg("配置文件顶层不是对象".into()))?;
    let providers = root_obj
        .entry("provider".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    providers
        .as_object_mut()
        .ok_or_else(|| Error::Msg("配置里的 provider 不是对象".into()))?
        .insert(draft.id.clone(), Value::Object(entry));
    Ok(())
}

pub fn remove(app: &tauri::AppHandle, id: &str) -> Result<Vec<ProviderView>> {
    let path = config_path(app)?;
    let mut root = read_root(&path)?;
    let removed = root
        .get_mut("provider")
        .and_then(Value::as_object_mut)
        .and_then(|p| p.remove(id));
    if removed.is_none() {
        return Err(Error::Msg(format!("配置里没有名为「{id}」的第三方提供商")));
    }
    write_root(&path, &root)?;
    list(app)
}

/// 走 OpenAI 兼容的 `GET {baseURL}/models` 探一把，顺便当连通性检查
pub async fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<PulledModel>> {
    valid_base_url(base_url)?;
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .msg("无法创建请求客户端")?;
    let resp = client
        .get(&url)
        .bearer_auth(api_key.trim())
        .send()
        .await
        .msg("连接服务地址失败")?;
    let status = resp.status();
    let body: Value = if status.is_success() {
        resp.json().await.msg("返回的内容不是合法 JSON")?
    } else {
        let text = resp.text().await.unwrap_or_default();
        let brief: String = text.chars().take(200).collect();
        return Err(Error::Msg(format!("HTTP {status} · {brief}")));
    };
    let mut out: Vec<PulledModel> = body
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?;
                    Some(PulledModel {
                        id: id.to_string(),
                        // 只有 OpenRouter 这类网关会在 /models 里带窗口大小，多数厂不给
                        context: m
                            .get("context_length")
                            .or_else(|| m.get("max_context_length"))
                            .and_then(Value::as_u64),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_reserved_and_bad_ids() {
        assert!(valid_id("huaweicloud-maas").is_err());
        assert!(valid_id("").is_err());
        assert!(valid_id("open ai").is_err());
        assert!(valid_id("openai-cn").is_ok());
    }

    #[test]
    fn only_http_base_urls_allowed() {
        assert!(valid_base_url("https://api.openai.com/v1").is_ok());
        assert!(valid_base_url("file:///etc/passwd").is_err());
        assert!(valid_base_url("not a url").is_err());
    }

    #[test]
    fn masks_keys_without_leaking_them() {
        assert_eq!(key_mask(""), None);
        assert_eq!(key_mask("enc:v3:abcdef").as_deref(), Some("已加密"));
        assert_eq!(key_mask("sk-proj-abcdefghij").as_deref(), Some("****ghij"));
    }

    #[test]
    fn save_keeps_fields_the_ui_does_not_know() {
        let mut root = serde_json::json!({
            "provider": {
                "myproxy": {
                    "name": "旧名字",
                    "npm": "@ai-sdk/openai-compatible",
                    "unknownTop": { "keep": true },
                    "options": {
                        "baseURL": "https://old.example/v1",
                        "apiKey": "enc:v3:kept",
                        "headers": { "x-trace": "1" },
                        "timeout": 120000
                    },
                    "models": {
                        "m1": {
                            "id": "m1",
                            "cost": { "input": 1, "output": 2 },
                            "attachment": true,
                            "limit": { "context": 1, "output": 1 }
                        }
                    }
                }
            }
        });
        let draft: ProviderDraft = serde_json::from_value(serde_json::json!({
            "id": "myproxy",
            "baseUrl": "https://new.example/v1",
            "models": [{ "id": "m1", "context": 128000, "output": 8192 }]
        }))
        .unwrap();
        merge_draft(&mut root, &draft).unwrap();

        let e = &root["provider"]["myproxy"];
        // 界面上没有的键必须还在
        assert_eq!(e["unknownTop"]["keep"], true);
        assert_eq!(e["options"]["headers"]["x-trace"], "1");
        assert_eq!(e["options"]["timeout"], 120000);
        assert_eq!(e["models"]["m1"]["cost"]["input"], 1);
        assert_eq!(e["models"]["m1"]["attachment"], true);
        // 界面上有的键按草稿覆盖
        assert_eq!(e["options"]["baseURL"], "https://new.example/v1");
        assert_eq!(e["models"]["m1"]["limit"]["context"], 128000);
        // 密钥留空 = 沿用原值
        assert_eq!(e["options"]["apiKey"], "enc:v3:kept");
        // 名称留空 = 清掉旧的，而不是继续挂着上次的名字
        assert!(e.get("name").is_none());
    }
}
