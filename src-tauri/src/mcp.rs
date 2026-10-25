//! MCP 服务器管理：只读写内核全局配置里的 `mcp` 段。
//!
//! 内核的 mcp 段结构没有公开的 schema，字段随传输方式（stdio / sse / http）而变，
//! 壳子不解释内容，原样存原始 JSON；界面只提供"名称 + 一段 JSON"的表单，
//! 这样写错字段是用户看到的错，而不是壳子把配置改坏。

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{Error, MsgExt, Result};
use crate::providers::{config_path, read_root, write_root};

/// 名字长度上限：内核按名字当键，太长只会让配置文件难读
const MAX_NAME: usize = 64;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEntry {
    pub name: String,
    pub config: Value,
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<McpEntry>> {
    let root = read_root(&config_path(app)?)?;
    let mut out: Vec<McpEntry> = servers_of(&root)
        .iter()
        .map(|(name, config)| McpEntry {
            name: name.clone(),
            config: config.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 新增或覆盖一个服务器。`raw` 是用户填的 JSON 原文，必须能解析成对象。
pub fn save(app: &tauri::AppHandle, name: &str, raw: &str) -> Result<Vec<McpEntry>> {
    let name = valid_name(name)?;
    let config = parse_config(raw)?;
    let path = config_path(app)?;
    let mut root = read_root(&path)?;
    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| Error::Msg("配置文件顶层不是对象".into()))?;
    root_obj
        .entry("mcp".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| Error::Msg("配置里的 mcp 不是对象，先手工修好再存".into()))?
        .insert(name, config);
    write_root(&path, &root)?;
    list(app)
}

pub fn remove(app: &tauri::AppHandle, name: &str) -> Result<Vec<McpEntry>> {
    let path = config_path(app)?;
    let mut root = read_root(&path)?;
    let removed = root
        .get_mut("mcp")
        .and_then(Value::as_object_mut)
        .and_then(|m| m.remove(name));
    if removed.is_none() {
        return Err(Error::Msg(format!("配置里没有名为「{name}」的 MCP 服务器")));
    }
    write_root(&path, &root)?;
    list(app)
}

fn servers_of(root: &Value) -> &Map<String, Value> {
    root.get("mcp")
        .and_then(Value::as_object)
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();

fn valid_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::Msg("MCP 服务器名不能为空".into()));
    }
    if name.len() > MAX_NAME {
        return Err(Error::Msg(format!("MCP 服务器名不能超过 {MAX_NAME} 个字符")));
    }
    // 名字是 JSON 的键，也是前端列表的主键；限制字符集省得出现不可见字符造成两份看起来一样的条目
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
    {
        return Err(Error::Msg(
            "MCP 服务器名只能用字母、数字、点、下划线、连字符和斜杠".into(),
        ));
    }
    Ok(name.to_string())
}

fn parse_config(raw: &str) -> Result<Value> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(Error::Msg("配置内容为空".into()));
    }
    let value: Value = serde_json::from_str(text).msg("配置不是合法 JSON")?;
    if !value.is_object() {
        return Err(Error::Msg("配置必须是一个 JSON 对象".into()));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_names_and_non_object_configs() {
        assert!(valid_name("").is_err());
        assert!(valid_name("has space").is_err());
        assert!(valid_name(&"x".repeat(MAX_NAME + 1)).is_err());
        assert_eq!(valid_name(" fs ").unwrap(), "fs");
        // 斜杠留着，方便按 provider/tool 起名
        assert!(valid_name("git/hub").is_ok());

        assert!(parse_config("").is_err());
        assert!(parse_config("[1,2]").is_err());
        assert!(parse_config("not json").is_err());
        assert!(parse_config(r#"{"type":"stdio","command":"npx"}"#).is_ok());
    }

    #[test]
    fn keeps_other_sections_untouched() {
        let mut root = serde_json::json!({
            "provider": { "keep": { "name": "别动我" } },
            "mcp": { "old": { "type": "stdio", "command": "a" } }
        });
        // 只演示合并规则：新增一个条目，provider 段原样保留
        root.as_object_mut()
            .unwrap()
            .entry("mcp".to_string())
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .unwrap()
            .insert("new".into(), parse_config(r#"{"type":"http","url":"https://x"}"#).unwrap());
        assert_eq!(root["provider"]["keep"]["name"], "别动我");
        assert_eq!(root["mcp"]["old"]["command"], "a");
        assert_eq!(root["mcp"]["new"]["url"], "https://x");
        assert_eq!(servers_of(&root).len(), 2);
    }
}
