use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::error::{Error, MsgExt, Result};
use crate::kernel::{Endpoint, Kernel};
use crate::settings::Settings;

/// 代理只放行这些前缀。`/global/dispose` 不给 WebView，只由壳自己在停内核时调用。
const ALLOW_PREFIXES: &[&str] = &[
    "/global/health", "/session", "/permission", "/question", "/provider", "/config",
    "/agent", "/command", "/skill", "/mcp", "/path", "/project", "/file", "/find", "/v1/", "/cag/",
    "/sandbox", "/whitelist", "/doc",
];

pub fn check_path(path: &str) -> Result<()> {
    let path_only = path.split(['?', '#']).next().unwrap_or(path);
    let decoded = decode_path(path_only).map_err(|_| {
        Error::Msg(format!("路径不在代理白名单内：{path}"))
    })?;
    if decoded.starts_with('/')
        && !decoded.split('/').any(|seg| seg == "..")
        && !decoded.contains('\0')
        && ALLOW_PREFIXES.iter().any(|p| segment_prefix(&decoded, p))
    {
        Ok(())
    } else {
        Err(Error::Msg(format!("路径不在代理白名单内：{path}")))
    }
}

/// 反复百分号解码（含 `%252e`），坏转义直接拒绝。稳定后才做 `..` 与前缀检查。
fn decode_path(path: &str) -> std::result::Result<String, ()> {
    let mut cur = path.replace('\\', "/");
    for _ in 0..4 {
        let next = percent_decode(&cur)?;
        if next == cur {
            return Ok(cur);
        }
        cur = next;
    }
    Err(())
}

fn percent_decode(input: &str) -> std::result::Result<String, ()> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let Some(h) = from_hex(bytes[i + 1]) else {
                return Err(());
            };
            let Some(l) = from_hex(bytes[i + 2]) else {
                return Err(());
            };
            out.push((h << 4) | l);
            i += 3;
        } else if bytes[i] == b'%' {
            return Err(());
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ())
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `/session` 匹配自身和 `/session/...`，不匹配 `/session-extra`。
fn segment_prefix(path: &str, prefix: &str) -> bool {
    if prefix.ends_with('/') {
        return path.starts_with(prefix);
    }
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

/// 内核未注册的路由不会 404，而是回 TUI 的 SPA 兜底页（200 + text/html），
/// 所以必须按 content-type 判定，否则前端会把 HTML 当 JSON 用。
/// 非 2xx 一律当 IPC 错误，避免前端把 JSON 错误体当成成功。
async fn decode(resp: reqwest::Response) -> Result<Value> {
    let status = resp.status();
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().await?;
    if !status.is_success() {
        let body = String::from_utf8_lossy(&bytes);
        let snippet: String = body.chars().take(500).collect();
        let detail = if snippet.trim().is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}：{snippet}")
        };
        return Err(Error::Msg(detail));
    }
    if bytes.is_empty() {
        // 仅成功且无正文（如 204 prompt_async / abort）映射为 null
        return Ok(Value::Null);
    }
    if !ctype.contains("json") {
        return Err(Error::NonJson(ctype));
    }
    Ok(serde_json::from_slice(&bytes)?)
}

pub async fn request(
    kernel: &Kernel,
    app: &tauri::AppHandle,
    method: &str,
    path: &str,
    body: Option<Value>,
    directory: Option<String>,
) -> Result<Value> {
    check_path(path)?;
    if let Some(dir) = directory.as_deref().filter(|d| !d.is_empty()) {
        ensure_known_directory(app, dir)?;
    }
    let ep = kernel.ensure_running(app).await?;
    let mut req = match method.to_ascii_uppercase().as_str() {
        "GET" => kernel.client.get(ep.url(&path)),
        "POST" => kernel.client.post(ep.url(&path)),
        "PATCH" => kernel.client.patch(ep.url(&path)),
        "PUT" => kernel.client.put(ep.url(&path)),
        "DELETE" => kernel.client.delete(ep.url(&path)),
        other => return Err(Error::Msg(format!("不支持的方法：{other}"))),
    };
    req = req.header("authorization", ep.basic());
    if let Some(dir) = directory.filter(|d| !d.is_empty()) {
        req = req.header("x-opencode-directory", dir);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    decode(req.send().await?).await
}

/// SSE 桥：订阅内核 /event，把每帧原样转成 Tauri event 推给 WebView。
/// 服务密码只留在 Rust 侧，前端拿不到端口和凭据。
/// `kernel-bridge` 事件告知前端链路状态：{state: "down"|"open", message?}，
/// 前端据此提示断线并在恢复后补拉数据。
pub fn spawn_pump(app: tauri::AppHandle, ep: Endpoint, directory: Option<String>) {
    tauri::async_runtime::spawn(async move {
        let kernel: std::sync::Arc<Kernel> = app.state::<std::sync::Arc<Kernel>>().inner().clone();
        loop {
            if kernel.current_endpoint() != Some(ep.clone()) {
                return;
            }
            if let Err(e) = stream(&app, &kernel, &ep, directory.as_deref()).await {
                let _ = app.emit(
                    "kernel-bridge",
                    serde_json::json!({ "state": "down", "message": e.to_string() }),
                );
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

async fn stream(
    app: &tauri::AppHandle,
    kernel: &Kernel,
    ep: &Endpoint,
    directory: Option<&str>,
) -> Result<()> {
    // 实测：/event 按 x-opencode-directory 分实例广播，不带头的连接收不到该目录的任何事件
    let mut req = kernel
        .sse
        .get(ep.url("/event"))
        .header("authorization", ep.basic())
        .header("accept", "text/event-stream");
    if let Some(dir) = directory.filter(|d| !d.is_empty()) {
        req = req.header("x-opencode-directory", dir);
    }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        return Err(Error::Msg(format!("事件流状态码 {}", resp.status())));
    }
    let _ = app.emit("kernel-bridge", serde_json::json!({ "state": "open" }));
    let mut stream = resp.bytes_stream();
    // 按字节攒帧：中文可能被切在两个 chunk 之间，decode 必须等一帧凑齐再做
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        if kernel.current_endpoint() != Some(ep.clone()) {
            return Ok(());
        }
        buf.extend_from_slice(&chunk?);
        while let Some((end, sep)) = frame_end(&buf) {
            let frame = String::from_utf8_lossy(&buf[..end]).into_owned();
            buf.drain(..end + sep);
            for line in frame.lines().filter(|l| l.starts_with("data:")) {
                if let Ok(v) = serde_json::from_str::<Value>(line[5..].trim()) {
                    let _ = app.emit("kernel-event", v);
                }
            }
        }
    }
    Ok(())
}

/// `x-opencode-directory` 只能是已保存工作区（canonical 后比较），不能让 WebView 把内核指到任意目录。
fn ensure_known_directory(app: &tauri::AppHandle, dir: &str) -> Result<()> {
    let want = std::path::Path::new(dir).canonicalize().msg("工作区目录不存在")?;
    let settings = Settings::load(app)?;
    let mut allowed = Vec::new();
    if let Some(p) = settings.project_dir.as_deref() {
        if let Ok(c) = std::path::Path::new(p).canonicalize() {
            allowed.push(c);
        }
    }
    if let Some(list) = &settings.projects {
        for p in list {
            if let Ok(c) = std::path::Path::new(p).canonicalize() {
                allowed.push(c);
            }
        }
    }
    if allowed.iter().any(|p| p == &want) {
        Ok(())
    } else {
        Err(Error::Msg("目录不在已保存的工作区列表中".into()))
    }
}

/// 返回第一帧的结束位置与分隔符长度；SSE 规定 \n\n 与 \r\n\r\n 两可
fn frame_end(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n").map(|p| (p, 2));
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| (p, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_requires_segment_and_rejects_encoding() {
        assert!(check_path("/session").is_ok());
        assert!(check_path("/session/abc").is_ok());
        assert!(check_path("/session?q=..").is_ok());
        assert!(check_path("/v1/chat").is_ok());
        assert!(check_path("/session-extra").is_err());
        assert!(check_path("/global/dispose").is_err());
        assert!(check_path("/global/disposeXXX").is_err());
        assert!(check_path("/session/../../pty").is_err());
        assert!(check_path("/file%2f..%2f..").is_err());
        assert!(check_path("/file%252f..%252f..").is_err());
        assert!(check_path("/%2e%2e/etc").is_err());
        assert!(check_path("/session/%zz").is_err());
    }
}
