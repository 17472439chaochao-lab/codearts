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
const PROBE_FRESH: Duration = Duration::from_secs(2);
/// watch 每 10 秒探测一次；进程还在但连续这么多次不应答（约 2 分钟）才算僵死
const STALL_MISSES: u32 = 12;

struct Begun {
    endpoint: Endpoint,
    ak: String,
    sk: String,
    project: String,
}

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
    /// serve 进程启动时的 cwd。切区不再重启，所以这个值会落后于界面当前工作区，
    /// 前端要知道当前区得自己拿 settings 里的 projectDir。
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
    /// 启动/停止必须串行且全程持锁：`start_locked` 的健康等待也不例外，
    /// 否则并发启动会互相把对方刚拉起的实例杀掉
    gate: tokio::sync::Mutex<()>,
    pub client: reqwest::Client,
    /// SSE 专用：总超时会在 120s 掐断长连接（实测断线周期 ~122s），这里只限单次读
    pub sse: reqwest::Client,
    /// 最近一次成功的健康探测，避免每个 API 请求都再打一轮
    probed: Mutex<Option<(Endpoint, std::time::Instant)>>,
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
        // /event 有心跳但间隔不定，65s 收不到任何字节视为链路已死，让 pump 重连
        let sse = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .read_timeout(Duration::from_secs(65))
            .build()
            .expect("reqwest sse client");
        Self {
            client,
            sse,
            gate: tokio::sync::Mutex::new(()),
            probed: Mutex::new(None),
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
    /// 排队进 gate 后要复查一次：等锁期间可能已有请求把内核带起来了。
    pub async fn ensure_running(&self, app: &tauri::AppHandle) -> Result<Endpoint> {
        if let Some(ep) = self.current_endpoint() {
            if self.probe_fresh(&ep) {
                return Ok(ep);
            }
            if self.probe_retry(&ep, 2).await.is_some() {
                self.remember_probe(&ep);
                return Ok(ep);
            }
            // 进程活着、只是这一下没回声：重启等于把正在跑的会话打断。
            // 先把端点交回去，让调用方的请求自己决定成败；真的僵死由 watch 在宽限期后处理。
            // 顺手记一次探测结果，免得紧接着的每个请求都再等两轮 4 秒超时。
            if self.child_alive_now() {
                self.remember_probe(&ep);
                return Ok(ep);
            }
        }
        let _gate = self.gate.lock().await;
        if let Some(ep) = self.current_endpoint() {
            if self.probe_retry(&ep, 2).await.is_some() {
                self.remember_probe(&ep);
                return Ok(ep);
            }
            if self.child_alive_now() {
                self.remember_probe(&ep);
                return Ok(ep);
            }
        }
        self.start_locked(app).await
    }

    /// App 启动时接管上一次异常退出遗留的实例，避免在同一数据目录上叠第二个 serve。
    pub async fn adopt(&self, app: &tauri::AppHandle) {
        let stored = secrets::get(secrets::ENDPOINT)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Endpoint>(&raw).ok());
        let Some(ep) = stored else { return };
        let version = self.probe(&ep).await;
        // 探测与写回之间可能有 start：持 gate，并确认 secrets / inner 仍是探测过的那份
        let _gate = self.gate.lock().await;
        let still = secrets::get(secrets::ENDPOINT)
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Endpoint>(&raw).ok());
        if still.as_ref() != Some(&ep) {
            return;
        }
        if let Some(live) = self.current_endpoint() {
            if live != ep {
                return;
            }
        }
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
            crate::api::spawn_pump(app.clone(), ep);
        } else {
            let _ = secrets::remove(secrets::ENDPOINT);
        }
    }

    /// App 启动时挂一次常驻自愈任务
    pub fn spawn_watch(app: tauri::AppHandle) {
        tauri::async_runtime::spawn(watch(app));
    }

    /// 强制重启一个实例（手动启动、升级、自愈都走这里；切工作区已经不用了）。
    /// 全程持 gate：并发方只能排队，不会在健康等待窗口里把刚拉起的实例杀掉。
    pub async fn start(&self, app: &tauri::AppHandle) -> Result<Endpoint> {
        let _gate = self.gate.lock().await;
        self.start_locked(app).await
    }

    /// 调用方必须持有 `gate`
    async fn start_locked(&self, app: &tauri::AppHandle) -> Result<Endpoint> {
        let begun = self.begin_start(app).await?;
        let version = self.await_healthy(&begun.endpoint).await;
        self.finish_start(app, begun, version).await
    }

    /// 调用方必须持有 `gate`。拉起进程后立刻返回，健康等待由 `start_locked` 完成。
    async fn begin_start(&self, app: &tauri::AppHandle) -> Result<Begun> {
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
        .current_dir(&project);
        kernel_env(&mut cmd, &home, &data_dir, &ak, &sk);
        scenario_env(&mut cmd, &home);
        cmd.env("CODEARTS_SERVER_PASSWORD", &endpoint.password)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .msg(format!("无法启动内核：{}", bin.display()))?;
        endpoint.pid = child.id();

        let tail = self.snapshot().2;
        if let Ok(mut buf) = tail.lock() {
            buf.clear();
        }
        if let (Some(out), Some(err)) = (child.stdout.take(), child.stderr.take()) {
            tauri::async_runtime::spawn(pump(out, tail.clone()));
            tauri::async_runtime::spawn(pump(err, tail));
        }

        {
            let mut inner = self.inner.lock().unwrap();
            inner.child = Some(child);
            inner.endpoint = None;
            inner.version = None;
            inner.project_dir = Some(project.display().to_string());
        }
        *self.probed.lock().unwrap() = None;
        Ok(Begun {
            endpoint,
            ak,
            sk,
            project: project.display().to_string(),
        })
    }

    /// 调用方必须持有 `gate`
    async fn finish_start(
        &self,
        app: &tauri::AppHandle,
        begun: Begun,
        version: Option<String>,
    ) -> Result<Endpoint> {
        let Some(version) = version else {
            let tail = self.snapshot().2.lock().unwrap().clone();
            self.shutdown_inner().await;
            return Err(Error::Msg(format!(
                "内核未能就绪：\n{}",
                mask_secrets(&tail_summary(&tail), &[begun.ak, begun.sk])
            )));
        };
        {
            let mut inner = self.inner.lock().unwrap();
            inner.endpoint = Some(begun.endpoint.clone());
            inner.project_dir = Some(begun.project.clone());
            inner.detail = None;
            inner.version = Some(version);
        }
        self.remember_probe(&begun.endpoint);
        persist_endpoint(&begun.endpoint)?;
        let _ = app.emit("kernel-status", self.status_obj());
        crate::api::spawn_pump(app.clone(), begun.endpoint.clone());
        Ok(begun.endpoint)
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
        let (bin, home, data_dir, project, ak, sk, restart) = {
            let _gate = self.gate.lock().await;
            let settings = Settings::load(app)?;
            let bin = settings.kernel_bin()?;
            let home = settings.kernel_home();
            let data_dir = settings.kernel_data_dir();
            // 从 Finder 启动时进程 cwd 是 /，upgrade 也会做文件夹信任检查；
            // 用当前工作区当 cwd，并确保它在白名单里
            let project = settings.project_dir()?;
            trust::trust_folder(&data_dir, &project)?;
            // upgrade 也要鉴权：先取凭据，缺了就直接报错，别把在跑的内核白白停掉
            let (ak, sk) = self.credentials(&home)?;
            let restart = self.status_obj().running;
            if restart {
                self.shutdown_inner().await;
                let _ = app.emit("kernel-status", self.status_obj());
            }
            (bin, home, data_dir, project, ak, sk, restart)
        };

        let mut cmd = Command::new(&bin);
        cmd.arg("upgrade").current_dir(&project);
        kernel_env(&mut cmd, &home, &data_dir, &ak, &sk);
        scenario_env(&mut cmd, &home);
        let out = cmd
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
            let mut msg = format!(
                "内核更新失败（退出码 {:?}）：\n{}",
                out.status.code(),
                tail_summary(&text)
            );
            if restart {
                if let Err(e) = self.start(app).await {
                    msg.push_str(&format!("\n重启内核失败：{e}"));
                }
            }
            return Err(Error::Msg(msg));
        }
        if restart {
            self.start(app).await?;
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
        *self.probed.lock().unwrap() = None;
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
            None => reap_stored_pid().await,
        }
        let _ = secrets::remove(secrets::ENDPOINT);
    }

    fn credentials(&self, home: &std::path::Path) -> Result<(String, String)> {
        // secrets::get 已把空文件当缺失；这里再 trim 一道，避免半截空白挡住 cli.env
        if let (Some(ak), Some(sk)) = (secrets::get(secrets::AK)?, secrets::get(secrets::SK)?) {
            let ak = ak.trim().to_string();
            let sk = sk.trim().to_string();
            if !ak.is_empty() && !sk.is_empty() {
                return Ok((ak, sk));
            }
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

    fn child_alive_now(&self) -> bool {
        self.inner
            .lock()
            .map(|mut g| Kernel::child_alive(&mut g.child))
            .unwrap_or(false)
    }

    async fn await_healthy(&self, ep: &Endpoint) -> Option<String> {
        for _ in 0..180 {
            if let Some(v) = self.probe(ep).await {
                return Some(v);
            }
            let exited = {
                let mut inner = self.inner.lock().unwrap();
                inner
                    .child
                    .as_mut()
                    .map(|c| matches!(c.try_wait(), Ok(Some(_))))
                    .unwrap_or(true)
            };
            if exited {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        None
    }

    /// 探测失败后再试一次：内核忙的时候单次超时不代表它已经死了
    async fn probe_retry(&self, ep: &Endpoint, tries: u32) -> Option<String> {
        for i in 0..tries.max(1) {
            if let Some(v) = self.probe(ep).await {
                return Some(v);
            }
            if i + 1 < tries {
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
        }
        None
    }

    fn probe_fresh(&self, ep: &Endpoint) -> bool {
        self.probed
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(cached, at)| cached == ep && at.elapsed() < PROBE_FRESH)
    }

    fn remember_probe(&self, ep: &Endpoint) {
        *self.probed.lock().unwrap() = Some((ep.clone(), std::time::Instant::now()));
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
        let alive = kernel.child_alive_now();
        // 进程退出：连续 3 次（约 30 秒）判定崩溃；进程活着但一声不吭：给它两分钟宽限，
        // 免得一次长任务把健康接口堵住就被判死刑
        let needed = if alive { STALL_MISSES } else { 3 };
        if misses < needed {
            continue;
        }
        // 复核端点仍在线才接管重启；真正重启走 start()，与手动启动在 gate 上排队
        let restart = {
            let _gate = kernel.gate.lock().await;
            if kernel.current_endpoint().as_ref() != Some(&ep) {
                false
            } else {
                kernel.inner.lock().unwrap().detail =
                    Some(format!("内核在端口 {} 失联，正在重启", ep.port));
                true
            }
        };
        if !restart {
            tracked = kernel.current_endpoint();
            misses = 0;
            continue;
        }
        let _ = app.emit("kernel-status", kernel.status_obj());
        match kernel.start(&app).await {
            Ok(new) => {
                tracked = Some(new);
                misses = 0;
            }
            Err(e) => {
                kernel.inner.lock().unwrap().detail = Some(format!("自动重启失败：{e}"));
                let _ = app.emit("kernel-status", kernel.status_obj());
                tracked = None;
                misses = 0;
            }
        }
    }
}

/// serve 与 upgrade 共用的内核环境；官方包装脚本会导出
/// NODE_TLS_REJECT_UNAUTHORIZED=0，这里刻意不继承
fn kernel_env(cmd: &mut Command, home: &std::path::Path, data_dir: &std::path::Path, ak: &str, sk: &str) {
    cmd.env("HOME", home)
        .env("KERNEL_DATA_DIR", data_dir.display().to_string())
        .env("KERNEL_CONFIG_DIR", home.join(".codeartsdoer").display().to_string())
        .env("CODEARTS_CLI_AK", ak)
        .env("CODEARTS_CLI_SK", sk)
        .env_remove("NODE_TLS_REJECT_UNAUTHORIZED");
}

/// serve 与 upgrade 共用的产品场景变量；少了 SCENARIO，upgrade 会按匿名产品的路径和通道走
fn scenario_env(cmd: &mut Command, home: &std::path::Path) {
    cmd.env(
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
    .env("OPENCODE_ALWAYS_NOTIFY_UPDATE", "false");
}

/// 全程走 tokio 的进程与计时器：以前用阻塞版 `ps` / `kill` + `thread::sleep`，
/// 最长会把一个 async worker 占住 6 秒，启动和停止路径都要经过这里。
async fn reap_stored_pid() {
    let Ok(Some(raw)) = secrets::get(secrets::ENDPOINT) else {
        return;
    };
    let Ok(stored) = serde_json::from_str::<Endpoint>(&raw) else {
        return;
    };
    let Some(pid) = stored.pid else { return };
    // pid 会被系统复用：要求命令行里既有名为 codearts 的可执行文件，又有 serve 参数
    let cmdline = tokio::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let Some(cmdline) = cmdline else { return };
    if !is_codearts_serve(&cmdline) {
        return;
    }
    eprintln!("[kernel] 回收上次遗留的内核 pid={pid}");
    let _ = tokio::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .await;
    // 等进程退出，避免立刻再起一个 serve 叠在同一数据目录上
    for _ in 0..50 {
        if !pid_alive(pid).await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = tokio::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .await;
    for _ in 0..20 {
        if !pid_alive(pid).await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 命令行是否像 `…/codearts serve …`（按可执行文件 basename，不做子串误伤）
fn is_codearts_serve(cmdline: &str) -> bool {
    let parts: Vec<&str> = cmdline.split_whitespace().collect();
    let has_bin = parts.iter().any(|p| {
        std::path::Path::new(p)
            .file_name()
            .and_then(|n| n.to_str())
            == Some("codearts")
    });
    let has_serve = parts.iter().any(|p| *p == "serve");
    has_bin && has_serve
}

async fn pid_alive(pid: u32) -> bool {
    tokio::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
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
            // drain 必须落在 char 边界，否则多字节日志（中文）会 panic abort
            let mut cut = overflow.min(buf.len());
            while cut > 0 && !buf.is_char_boundary(cut) {
                cut -= 1;
            }
            if cut > 0 {
                buf.drain(..cut);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codearts_serve_matches_basename_and_serve() {
        assert!(is_codearts_serve("/Users/me/.codeartsdoer/installers/bin/codearts serve --port 1"));
        assert!(!is_codearts_serve("vim /tmp/codearts-notes.txt"));
        assert!(!is_codearts_serve("/usr/bin/codearts upgrade"));
        assert!(!is_codearts_serve(""));
    }

    #[test]
    fn drain_cut_stays_on_char_boundary() {
        let mut buf = String::from("abc你好def");
        let overflow = 4; // 落在「你」的中间字节附近
        let mut cut = overflow.min(buf.len());
        while cut > 0 && !buf.is_char_boundary(cut) {
            cut -= 1;
        }
        buf.drain(..cut);
        assert!(buf.is_char_boundary(0));
        assert!(!buf.is_empty() || cut == buf.len());
    }
}
