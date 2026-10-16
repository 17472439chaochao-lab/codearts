use std::time::Duration;

use futures_util::StreamExt;
use serde_json::Value;
use tauri::{Emitter, Manager};

use crate::error::{Error, Result};
use crate::kernel::{Endpoint, Kernel};

/// 代理只放行这些前缀，避免 WebView 被注入后拿它打任意路径。
const ALLOW_PREFIXES: &[&str] = &[
    "/global/health", "/global/dispose", "/session", "/permission", "/question", "/provider", "/config",
    "/agent", "/command", "/skill", "/mcp", "/path", "/project", "/file", "/find", "/v1/", "/cag/",
    "/sandbox", "/whitelist", "/doc",
];

pub fn check_path(path: &str) -> Result<()> {
    if path.starts_with('/') && ALLOW_PREFIXES.iter().any(|p| path.starts_with(p)) {
        Ok(())
    } else {
        Err(Error::Msg(format!("路径不在代理白名单内：{path}")))
    }
}

/// 内核未注册的路由不会 404，而是回 TUI 的 SPA 兜底页（200 + text/html），
/// 所以必须按 content-type 判定，否则前端会把 HTML 当 JSON 用。
async fn decode(resp: reqwest::Response) -> Result<Value> {
    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().await?;
    if bytes.is_empty() {
        return Ok(Value::Null); // 204：prompt_async / abort 这类只回状态码的端点
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
pub fn spawn_pump(app: tauri::AppHandle, ep: Endpoint, directory: Option<String>) {
    tauri::async_runtime::spawn(async move {
        let kernel: std::sync::Arc<Kernel> = app.state::<std::sync::Arc<Kernel>>().inner().clone();
        let client = kernel.client.clone();
        loop {
            if kernel.current_endpoint() != Some(ep.clone()) {
                return;
            }
            if let Err(e) = stream(&app, &kernel, &client, &ep, directory.as_deref()).await {
                let _ = app.emit("kernel-bridge", Value::String(format!("事件流中断：{e}")));
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

async fn stream(
    app: &tauri::AppHandle,
    kernel: &Kernel,
    client: &reqwest::Client,
    ep: &Endpoint,
    directory: Option<&str>,
) -> Result<()> {
    // 实测：/event 按 x-opencode-directory 分实例广播，不带头的连接收不到该目录的任何事件
    let mut req = client
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
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        if kernel.current_endpoint() != Some(ep.clone()) {
            return Ok(());
        }
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        while let Some(pos) = buf.find("\n\n") {
            let frame = buf[..pos].to_string();
            buf.drain(..pos + 2);
            for line in frame.lines().filter(|l| l.starts_with("data:")) {
                if let Ok(v) = serde_json::from_str::<Value>(line[5..].trim()) {
                    let _ = app.emit("kernel-event", v);
                }
            }
        }
    }
    Ok(())
}
