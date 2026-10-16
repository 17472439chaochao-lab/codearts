use std::path::Path;

use serde_json::{json, Value};

use crate::error::{MsgExt, Result};

/// 内核启动前必须把 cwd 写进信任白名单，否则 serve 直接 fatal 退出。
/// 这里只增不删，保留用户手工配置的其他 security 字段。
pub fn trust_folder(data_dir: &Path, dir: &Path) -> Result<()> {
    let path = data_dir.join("settings.json");
    let mut root: Value = if path.exists() {
        let text = std::fs::read_to_string(&path)?;
        serde_json::from_str(&text).msg(format!("{} 不是合法 JSON", path.display()))?
    } else {
        json!({})
    };

    if !root.get("security").is_some_and(Value::is_object) {
        root["security"] = json!({});
    }
    let security = root.as_object_mut().unwrap().get_mut("security").unwrap();
    if !security.get("folderTrust").is_some_and(Value::is_object) {
        security["folderTrust"] = json!({});
    }
    security["folderTrust"]["enabled"] = json!(true);
    if !security.get("trustedFolders").is_some_and(Value::is_array) {
        security["trustedFolders"] = json!([]);
    }

    let folders = security["trustedFolders"].as_array_mut().unwrap();
    let target = dir.display().to_string();
    if !folders.iter().any(|f| f.as_str() == Some(target.as_str())) {
        folders.push(json!(target));
    }

    std::fs::create_dir_all(data_dir)?;
    std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap())
        .msg(format!("写入信任白名单失败：{}", path.display()))
}

pub fn is_trusted(data_dir: &Path, dir: &Path) -> Result<bool> {
    let path = data_dir.join("settings.json");
    if !path.exists() {
        return Ok(false);
    }
    let text = std::fs::read_to_string(&path)?;
    let root: Value = serde_json::from_str(&text).msg("settings.json 损坏")?;
    let target = dir.display().to_string();
    Ok(root
        .pointer("/security/trustedFolders")
        .and_then(Value::as_array)
        .map(|a| a.iter().any(|f| f.as_str() == Some(target.as_str())))
        .unwrap_or(false))
}

/// Keychain 里没有凭据时，回落到 CLI 自己的 `~/.codeartsdoer/cli.env`。
pub fn read_cli_env(home: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(home.join(".codeartsdoer").join("cli.env")).ok()?;
    let ak = env_value(&text, "CODEARTS_CLI_AK")?;
    let sk = env_value(&text, "CODEARTS_CLI_SK")?;
    Some((ak, sk))
}

fn env_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let (k, v) = l.split_once('=')?;
        let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
        (k.trim() == key && !v.is_empty()).then_some(v)
    })
}
