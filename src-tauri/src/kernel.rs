use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::error::{Error, MsgExt, Result};
use crate::settings::Settings;
use crate::{secrets, trust};

const HEALTH_PATH: &str = "/global/health";
const LOG_TAIL: usize = 4000;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub password: String,
    /// 壳被强杀后按这个 pid 回收孤儿内核
    #[serde(default)]
    pub pid: Option<u32>,
}

impl Endpoint {
    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.port, path)
    }

    pub fn basic(&self) -> String {
        let raw = format!("codearts:{}", self.password);
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(raw.as_bytes())
        )
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub healthy: bool,
    pub port: Option<u16>,
    pub project_dir: Option<String>,
    pub version: Option<String>,
    pub detail: Option<String>,
}

struct Inner {
    child: Option<Child>,
    endpoint: Option<Endpoint>,
    project_dir: Option<String>,
    log_tail: Arc<Mutex<String>>,
    detail: Option<String>,
    version: Option<String>,
}

pub struct Kernel {
    inner: Mutex<Inner>,
    /// 启动/停止必须串行：并发 `start()` 会让后一个的 shutdown 杀掉前一个刚交出去的实例
    gate: tokio::sync::Mutex<()>,
    pub client: reqwest::Client,
}

impl Default for Kernel {
    fn default() -> Self {
        Self::new()
    }
}

impl Kernel {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(120))
            .build()
            .expect("reqwest client");
        Self {
            client,
            gate: tokio::sync::Mutex::new(()),
            inner: Mutex::new(Inner {
                child: None,
                endpoint: None,
                project_dir: None,
                log_tail: Arc::new(Mutex::new(String::new())),
                detail: None,
                version: None,
            }),
        }
    }

    fn snapshot(&self) -> (Option<Endpoint>, Option<String>, Arc<Mutex<String>>) {
        let inner = self.inner.lock().unwrap();
        (
            inner.endpoint.clone(),
            inner.project_dir.clone(),
            inner.log_tail.clone(),
        )
    }

    pub fn current_endpoint(&self) -> Option<Endpoint> {
        self.inner.lock().unwrap().endpoint.clone()
    }

    /// 只探测当前实例，不会顺手拉起内核
    pub async fn health(&self) -> Option<String> {
        let (endpoint, _, _) = self.snapshot();
        match endpoint {
            Some(ep) => self.probe(&ep).await,
            None => None,
        }
    }

    fn child_alive(child: &mut Option<Child>) -> bool {
        child
            .as_mut()
            .map(|c| matches!(c.try_wait(), Ok(None)))
            .unwrap_or(false)
    }

    pub fn status_obj(&self) -> Status {
        let inner = self.inner.lock().unwrap();
        Status {
            running: inner.child.is_some() || inner.endpoint.is_some(),
            healthy: inner.endpoint.is_some(),
            port: inner.endpoint.as_ref().map(|e| e.port),
            project_dir: inner.project_dir.clone(),
            version: inner.version.clone(),
            detail: inner.detail.clone(),
        }
    }

    /// 前端所有请求的入口：确保内核在线并拿到可寻址端点。
    pub async fn ensure_running(&self, app: &tauri::AppHandle) -> Result<Endpoint> {
        let (endpoint, _, _) = self.snapshot();
        if let Some(ep) = endpoint {
            if self.probe(&ep).await.is_some() {
                return Ok(ep);
            }
        }
        // 等锁期间别的请求可能已经拉起来了，拿到锁后复查再决定要不要真启动
        let _gate = self.gate.lock().await;
        let (endpoint, _, _) = self.snapshot();
        match endpoint {
            Some(ep) if self.probe(&ep).await.is_some() => Ok(ep),
            _ => self.start_locked(app).await,
        }
    }

    /// App 启动时接管上一次异常退出遗留的实例，避免在同一数据目录上叠第二个 serve。
    pub async fn adopt(&self, app: &tauri::AppHandle) {
        let stored = secrets::get(secrets::ENDPOINT)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Endpoint>(&raw).ok());
        let Some(ep) = stored else { return };
        let version = self.probe(&ep).await;
        if version.is_some() {
            let project = Settings::load(app)
                .ok()
                .and_then(|s| s.project_dir)
                .filter(|p| std::path::Path::new(p).is_dir());
            {
                let mut inner = self.inner.lock().unwrap();
                inner.endpoint = Some(ep.clone());
                inner.project_dir = project.clone();
                inner.version = version;
            }
            let _ = app.emit("kernel-status", self.status_obj());
            crate::api::spawn_pump(app.clone(), ep, project);
        } else {
            let _ = secrets::remove(secrets::ENDPOINT);
        }
    }

    /// App 启动时挂一次常驻自愈任务
    pub fn spawn_watch(app: tauri::AppHandle) {
        tauri::async_runtime::spawn(watch(app));
    }

    pub async fn start(&self, app: &tauri::AppHandle) -> Result<Endpoint> {
        let _gate = self.gate.lock().await;
        self.start_locked(app).await
    }

    /// 调用方必须持有 `gate`
    async fn start_locked(&self, app: &tauri::AppHandle) -> Result<Endpoint> {
        let settings = Settings::load(app)?;
        let project = settings.project_dir()?;
        let bin = settings.kernel_bin()?;
        let home = settings.kernel_home();
        let data_dir = settings.kernel_data_dir();
        let (ak, sk) = self.credentials(&home)?;
        trust::trust_folder(&data_dir, &project)?;
        self.shutdown_inner().await;

        let mut endpoint = Endpoint {
            port: free_port()?,
            password: random_password(),
            pid: None,
        };
        let mut cmd = Command::new(&bin);
        cmd.args([
            "serve",
            "--port",
            &endpoint.port.to_string(),
            "--hostname",
            "127.0.0.1",
        ])
        .current_dir(&project)
        .env("HOME", &home)
        .env("KERNEL_DATA_DIR", data_dir.display().to_string())
        .env("KERNEL_CONFIG_DIR", home.join(".codeartsdoer").display().to_string())
        .env(
            "OPENCODE_CONFIG",
            home.join(".codeartsdoer/codearts_cli.json").display().to_string(),
        )
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
        .env("CODEARTS_CLI_AK", ak)
        .env("CODEARTS_CLI_SK", sk)
        .env("CODEARTS_SERVER_PASSWORD", &endpoint.password)
        // 官方包装脚本会导出 NODE_TLS_REJECT_UNAUTHORIZED=0，这里刻意不继承
        .env_remove("NODE_TLS_REJECT_UNAUTHORIZED")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .msg(format!("无法启动内核：{}", bin.display()))?;
        endpoint.pid = child.id();

        let tail = self.snapshot().2;
        if let (Some(out), Some(err)) = (child.stdout.take(), child.stderr.take()) {
            tauri::async_runtime::spawn(pump(out, tail.clone()));
            tauri::async_runtime::spawn(pump(err, tail.clone()));
        }

        let ready = self.await_healthy(&endpoint, &mut child).await;
        let version = ready.ok_or_else(|| {
            Error::Msg(format!(
                "内核未能就绪：\n{}",
                tail_summary(&tail.lock().unwrap())
            ))
        })?;

        {
            let mut inner = self.inner.lock().unwrap();
            inner.child = Some(child);
            inner.endpoint = Some(endpoint.clone());
            inner.project_dir = Some(project.display().to_string());
            inner.detail = None;
            inner.version = Some(version);
        }
        persist_endpoint(&endpoint)?;
        let _ = app.emit("kernel-status", self.status_obj());
        crate::api::spawn_pump(app.clone(), endpoint.clone(), Some(project.display().to_string()));
        Ok(endpoint)
    }

    pub async fn stop(&self, app: &tauri::AppHandle) -> Result<()> {
        let _gate = self.gate.lock().await;
        self.shutdown_inner().await;
        let _ = app.emit("kernel-status", self.status_obj());
        Ok(())
    }

    /// `codearts upgrade` 是内核唯一的自更新入口（serve 里 autoupdate 被我们关了）。
    /// 它会覆盖 installers/bin/codearts，所以先停掉在跑的实例，跑完再按原样拉回来。
    pub async fn upgrade(&self, app: &tauri::AppHandle) -> Result<String> {
        let _gate = self.gate.lock().await;
        let settings = Settings::load(app)?;
        let bin = settings.kernel_bin()?;
        let home = settings.kernel_home();
        // upgrade 也要鉴权：先取凭据，缺了就直接报错，别把在跑的内核白白停掉
        let (ak, sk) = self.credentials(&home)?;
        let restart = self.status_obj().running;
        if restart {
            self.shutdown_inner().await;
            let _ = app.emit("kernel-status", self.status_obj());
        }

        let out = Command::new(&bin)
            .arg("upgrade")
            .env("HOME", &home)
            .env(
                "KERNEL_DATA_DIR",
                settings.kernel_data_dir().display().to_string(),
            )
            .env(
                "KERNEL_CONFIG_DIR",
                home.join(".codeartsdoer").display().to_string(),
            )
            .env("CODEARTS_CLI_AK", &ak)
            .env("CODEARTS_CLI_SK", &sk)
            .env_remove("NODE_TLS_REJECT_UNAUTHORIZED")
            .output()
            .await
            .msg(format!("无法执行 {} upgrade", bin.display()))?;

        let text = mask_secrets(
            &format!(
                "{}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ),
            &[ak, sk],
        );

        if !out.status.success() {
            if restart {
                let _ = self.start_locked(app).await;
            }
            return Err(Error::Msg(format!(
                "内核更新失败（退出码 {:?}）：\n{}",
                out.status.code(),
                tail_summary(&text)
            )));
        }
        if restart {
            self.start_locked(app).await?;
        }
        Ok(text)
    }

    /// dispose + 杀进程；App 退出与切换项目都走这里，避免留孤儿内核
    pub async fn shutdown(&self) {
        let _gate = self.gate.lock().await;
        self.shutdown_inner().await;
    }

    /// 调用方必须持有 `gate`
    async fn shutdown_inner(&self) {
        let (endpoint, _, _) = self.snapshot();
        if let Some(ep) = endpoint {
            let _ = self
                .client
                .post(ep.url("/global/dispose"))
                .header("authorization", ep.basic())
                .timeout(Duration::from_secs(5))
                .send()
                .await;
        }
        let child = {
            let mut inner = self.inner.lock().unwrap();
            inner.endpoint = None;
            inner.project_dir = None;
            inner.version = None;
            inner.child.take()
        };
        match child {
            Some(mut child) => {
                if tokio::time::timeout(Duration::from_secs(5), child.wait())
                    .await
                    .is_err()
                {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
            }
            // 壳被强杀过，句柄早丢了；按上次持久化的 pid 收掉遗留进程
            None => reap_stored_pid(),
        }
        let _ = secrets::remove(secrets::ENDPOINT);
    }

    fn credentials(&self, home: &std::path::Path) -> Result<(String, String)> {
        if let (Some(ak), Some(sk)) = (secrets::get(secrets::AK)?, secrets::get(secrets::SK)?) {
            return Ok((ak, sk));
        }
        trust::read_cli_env(home).ok_or_else(|| {
            Error::Msg("缺少华为云凭据：在设置里填写 AK/SK，或写入 ~/.codeartsdoer/cli.env".into())
        })
    }

    async fn probe(&self, ep: &Endpoint) -> Option<String> {
        let r = self
            .client
            .get(ep.url(HEALTH_PATH))
            .header("authorization", ep.basic())
            .timeout(Duration::from_secs(4))
            .send()
            .await
            .ok()?;
        if !r.status().is_success() {
            return None;
        }
        let v: serde_json::Value = r.json().await.ok()?;
        v.get("version")
            .and_then(|x| x.as_str())
            .map(str::to_string)
    }

    async fn await_healthy(&self, ep: &Endpoint, child: &mut Child) -> Option<String> {
        for _ in 0..180 {
            if let Some(v) = self.probe(ep).await {
                return Some(v);
            }
            if matches!(child.try_wait(), Ok(Some(_))) {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        None
    }
}

/// 崩溃自愈：连续探测失败且进程已退出才重启，会话记录在 cli-data 里不会丢。
/// 全程只有一个常驻任务、跟随当前端点，不与 `start()` 互相嵌套 future。
async fn watch(app: tauri::AppHandle) {
    let kernel: Arc<Kernel> = app.state::<Arc<Kernel>>().inner().clone();
    let mut tracked: Option<Endpoint> = None;
    let mut misses = 0u32;
    loop {
        tokio::time::sleep(Duration::from_secs(10)).await;
        let current = kernel.current_endpoint();
        if current != tracked {
            tracked = current;
            misses = 0;
        }
        let Some(ep) = tracked.clone() else { continue };
        if kernel.probe(&ep).await.is_some() {
            misses = 0;
            continue;
        }
        misses += 1;
        let alive = kernel
            .inner
            .lock()
            .map(|mut g| Kernel::child_alive(&mut g.child))
            .unwrap_or(false);
        if alive || misses < 3 {
            continue;
        }
        {
            let mut inner = kernel.inner.lock().unwrap();
            inner.child = None;
            inner.endpoint = None;
            inner.version = None;
            inner.detail = Some(format!("内核在端口 {} 失联，正在重启", ep.port));
        }
        let _ = app.emit("kernel-status", kernel.status_obj());
        tracked = None;
        match kernel.start(&app).await {
            Ok(new) => tracked = Some(new),
            Err(e) => {
                kernel.inner.lock().unwrap().detail = Some(format!("自动重启失败：{e}"));
                let _ = app.emit("kernel-status", kernel.status_obj());
            }
        }
    }
}

fn reap_stored_pid() {
    let Ok(Some(raw)) = secrets::get(secrets::ENDPOINT) else {
        return;
    };
    let Ok(stored) = serde_json::from_str::<Endpoint>(&raw) else {
        return;
    };
    let Some(pid) = stored.pid else { return };
    eprintln!("[kernel] 回收上次遗留的内核 pid={pid}");
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
}

async fn pump<R>(reader: R, tail: Arc<Mutex<String>>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut buf = tail.lock().unwrap();
        buf.push_str(&line);
        buf.push('\n');
        let overflow = buf.len().saturating_sub(LOG_TAIL);
        if overflow > 0 {
            buf.drain(..overflow);
        }
    }
}

fn tail_summary(log: &str) -> String {
    let lines: Vec<&str> = log.lines().rev().take(12).collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

/// CLI 的输出要原样回显给用户，但不能把凭据一起带进 WebView
fn mask_secrets(raw: &str, secrets: &[String]) -> String {
    let mut out = raw.to_string();
    for s in secrets {
        if !s.is_empty() {
            out = out.replace(s.as_str(), "****");
        }
    }
    out.trim().to_string()
}

fn free_port() -> Result<u16> {
    let l = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(l.local_addr().msg("无法分配端口")?.port())
}

fn random_password() -> String {
    use rand::distributions::Alphanumeric;
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn persist_endpoint(ep: &Endpoint) -> Result<()> {
    secrets::set(
        secrets::ENDPOINT,
        &serde_json::to_string(ep).msg("端点序列化失败")?,
    )
}
