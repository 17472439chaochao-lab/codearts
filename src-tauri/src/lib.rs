mod api;
mod error;
mod files;
mod kernel;
mod secrets;
mod settings;
mod trust;

use error::Error;
use kernel::{Kernel, Status};
use std::sync::Arc;
use serde::Serialize;
use serde_json::Value;
use settings::Settings;
use tauri::{Manager, State};

#[tauri::command]
fn settings_save(app: tauri::AppHandle, mut next: Settings) -> Result<Settings, Error> {
    let current = Settings::load(&app)?;
    // 内核路径不接受 WebView 传入：注入脚本不能把 AK/SK 指到任意可执行文件
    next.kernel_home = current.kernel_home;
    next.kernel_bin = current.kernel_bin;
    next.project_dir = next.project_dir.or(current.project_dir);
    next.projects = next.projects.or(current.projects);
    next.save(&app)?;
    Ok(next)
}

#[tauri::command]
fn credentials_save(ak: String, sk: String) -> Result<(), Error> {
    let ak = ak.trim();
    let sk = sk.trim();
    if ak.is_empty() || sk.is_empty() {
        return Err(Error::Msg("AK / SK 都不能为空".into()));
    }
    let r = (|| -> Result<(), Error> {
        secrets::set(secrets::AK, ak)?;
        secrets::set(secrets::SK, sk)
    })();
    if let Err(e) = &r {
        eprintln!("[credentials] 保存失败：{e}");
    }
    r
}

/// 首屏向导要判断的三件事：内核装没装、凭据有没有、项目目录选没选
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvCheck {
    kernel_installed: bool,
    kernel_bin: Option<String>,
    has_credentials: bool,
    project_dir: Option<String>,
    projects: Vec<String>,
    kernel_home: String,
}

#[tauri::command]
fn env_check(app: tauri::AppHandle) -> Result<EnvCheck, Error> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let bin = settings.kernel_bin().ok().map(|p| p.display().to_string());
    let has_credentials = (secrets::get(secrets::AK)?.is_some()
        && secrets::get(secrets::SK)?.is_some())
        || trust::read_cli_env(&home).is_some();
    let project_dir = settings.project_dir.filter(|p| !p.is_empty());
    // 老配置只有单个 projectDir，这里并进工作区列表首位
    let mut projects: Vec<String> = settings
        .projects
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect();
    if let Some(cur) = project_dir.as_ref() {
        if !projects.contains(cur) {
            projects.insert(0, cur.clone());
        }
    }
    Ok(EnvCheck {
        kernel_installed: bin.is_some(),
        kernel_bin: bin,
        has_credentials,
        project_dir,
        projects,
        kernel_home: home.display().to_string(),
    })
}

/// 凭据只回传"有没有 + AK 尾号"，SK 一个真实字符都不出 Rust 侧
#[tauri::command]
fn credentials_status(app: tauri::AppHandle) -> Result<Value, Error> {
    // 与 kernel.rs 注入子进程时的取值顺序一致：壳内保存的优先，cli.env 兜底
    let has_sk = secrets::get(secrets::SK)?.is_some();
    let stored = secrets::get(secrets::AK)?.filter(|_| has_sk);
    let home = Settings::load(&app)?.kernel_home();
    let cli = trust::read_cli_env(&home).map(|(ak, _)| ak);
    let ak = stored.clone().or_else(|| cli.clone());
    Ok(serde_json::json!({
        "saved": stored.is_some(),
        "inCliEnv": cli.is_some(),
        "akMask": ak.as_deref().map(mask_ak),
    }))
}

/// 尾号用来分清配的是哪把钥匙，不足以反推整串 AK
fn mask_ak(ak: &str) -> String {
    let chars: Vec<char> = ak.chars().collect();
    if chars.len() <= 4 {
        return "****".to_string();
    }
    format!("****{}", chars[chars.len() - 4..].iter().collect::<String>())
}

#[tauri::command]
async fn kernel_start(app: tauri::AppHandle, kernel: State<'_, Arc<Kernel>>) -> Result<Status, Error> {
    let r = kernel.start(&app).await;
    if let Err(e) = &r {
        eprintln!("[kernel] 启动失败：{e}");
    }
    r?;
    Ok(kernel.status_obj())
}

#[tauri::command]
async fn kernel_stop(app: tauri::AppHandle, kernel: State<'_, Arc<Kernel>>) -> Result<Status, Error> {
    kernel.stop(&app).await?;
    Ok(kernel.status_obj())
}

#[tauri::command]
async fn kernel_status(kernel: State<'_, Arc<Kernel>>) -> Result<Status, Error> {
    let mut status = kernel.status_obj();
    if let Some(version) = kernel.health().await {
        status.version = Some(version);
        status.healthy = true;
    } else {
        status.healthy = false;
    }
    Ok(status)
}

/// 跑 `codearts upgrade`：内核自己覆盖二进制，Rust 侧只负责停-更-起，并把 CLI 输出回显给界面
#[tauri::command]
async fn kernel_upgrade(app: tauri::AppHandle, kernel: State<'_, Arc<Kernel>>) -> Result<String, Error> {
    kernel.upgrade(&app).await
}

#[tauri::command]
async fn api_request(
    app: tauri::AppHandle,
    kernel: State<'_, Arc<Kernel>>,
    method: String,
    path: String,
    body: Option<Value>,
    directory: Option<String>,
) -> Result<Value, Error> {
    api::request(&kernel, &app, &method, &path, body, directory).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Kernel::new()))
        .invoke_handler(tauri::generate_handler![
            settings_save,
            env_check,
            credentials_save,
            credentials_status,
            kernel_start,
            kernel_stop,
            kernel_status,
            kernel_upgrade,
            api_request,
            files::files_list,
            files::file_read,
            files::plans_list,
            files::plan_read
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            Kernel::spawn_watch(handle.clone());
            tauri::async_runtime::spawn(async move {
                let kernel: Arc<Kernel> = handle.state::<Arc<Kernel>>().inner().clone();
                kernel.adopt(&handle).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建应用失败")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // 退出前 dispose + 杀进程，不留孤儿内核
                let (tx, rx) = std::sync::mpsc::channel();
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let kernel: Arc<Kernel> = handle.state::<Arc<Kernel>>().inner().clone();
                    kernel.shutdown().await;
                    let _ = tx.send(());
                });
                let _ = rx.recv_timeout(std::time::Duration::from_secs(6));
            }
        });
}
