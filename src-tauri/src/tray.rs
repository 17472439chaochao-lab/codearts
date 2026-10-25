//! 托盘常驻：关窗不等于退出，后端会话可以继续跑。
//!
//! macOS 上"关窗就 dispose 内核"会把后台正在跑的一轮直接打断，所以给一条
//! 「关闭最小化到托盘」的路；要不要走这条路由设置项 `closeToTray` 决定，默认仍按老行为退出。

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WindowEvent};

use crate::settings::Settings;

const TRAY_ID: &str = "codearts-tray";
const ITEM_SHOW: &str = "show";
const ITEM_QUIT: &str = "quit";

/// 装托盘图标。菜单只有两项：把窗口要回来，或者真正退出（退出才收内核）。
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, ITEM_SHOW, "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ITEM_QUIT, "退出 CodeArts Desktop", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("CodeArts Desktop")
        .menu(&menu)
        // 左键直接亮窗口，右键才出菜单：托盘常驻状态下这是最省事的分工
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            ITEM_SHOW => reveal(app),
            ITEM_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            // 左键点图标 = 把窗口要回来。macOS 会先发 Down 再发 Up，
            // 只认 Up：按 Down 处理会在一次点击里唤醒两次
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => reveal(tray.app_handle()),
            _ => {}
        });
    // 复用应用图标，不额外塞一张只给托盘用的 png
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 把主窗口要回来。菜单项和左键点击都走这里。
///
/// 刻意不在托盘回调里直接 show()+set_focus()：那段代码跑在状态栏图标的 mouseUp
/// 处理当中，此时发起的 activate 有可能随这一轮点击的收尾一起被撤销，表现出来
/// 就是"点了图标窗口不回来"。先让出当前 runloop，再由主线程执行显示，
/// 时序上等价于"点击已经处理完之后再去激活应用"。
fn reveal(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let inner = handle.clone();
        let _ = handle.run_on_main_thread(move || reveal_now(&inner));
    });
}

fn reveal_now(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    // 关窗只 orderOut 了窗口，应用本身没被藏；但用户可能按过 Cmd+H，
    // 那种情况下只 show() 窗口是出不来的，得先把应用解除隐藏
    #[cfg(target_os = "macos")]
    let _ = app.show();
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

/// 窗口的关闭行为：设置开着就改成隐藏。读配置走缓存，点红叉时不会因为 IO 卡一下。
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let app = window.app_handle();
    let to_tray = Settings::load(app)
        .map(|s| s.close_to_tray.unwrap_or(false))
        .unwrap_or(false);
    if !to_tray {
        return;
    }
    api.prevent_close();
    let _ = window.hide();
}
