use crate::error::{Error, Result};
use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::Manager;

#[tauri::command]
pub async fn checkin_open_login_window(app: tauri::AppHandle, target: Option<String>) -> Result<()> {
    let dest = target.unwrap_or_else(|| "https://grow.developer.huaweicloud.com/".to_string());

    if let Some(w) = app.get_webview_window("huawei_login") {
        let _ = w.show();
        let _ = w.set_focus();
        if let Ok(u) = dest.parse::<tauri::Url>() {
            let _ = w.navigate(u);
        }
        return Ok(());
    }

    let url: tauri::Url = dest
        .parse()
        .map_err(|e| Error::Msg(format!("解析目标 URL 失败: {e}")))?;

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "huawei_login",
        tauri::WebviewUrl::External(url),
    )
    .title("华为云 AI 开发者空间与激励中心")
    .inner_size(1080.0, 760.0)
    .center();

    builder
        .build()
        .map_err(|e| Error::Msg(format!("创建登录窗口失败: {e}")))?;

    Ok(())
}

#[tauri::command]
pub async fn checkin_fetch_webview_cookies(app: tauri::AppHandle) -> Result<String> {
    let w = app
        .get_webview_window("huawei_login")
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| Error::Msg("未找到华为云登录窗口，请先点击【打开内置登录窗口】".to_string()))?;

    // 检查窗口当前 URL，如果是 auth.huaweicloud.com 则提示用户稍候
    if let Ok(curr_url) = w.url() {
        let url_str = curr_url.to_string();
        if url_str.contains("auth.huaweicloud.com") || url_str.contains("authui/login") {
            return Err(Error::Msg("登录尚未完成：检测到窗口仍在登录认证中，请在窗口内完成登录并等待页面跳转回成长中心主页后再点击同步".to_string()));
        }
    }

    let cookies = w
        .cookies()
        .map_err(|e| Error::Msg(format!("读取 Webview Cookie 失败: {e}")))?;

    let mut parts = Vec::new();
    let mut has_auth_marker = false;

    for c in cookies {
        let name = c.name().to_string();
        let value = c.value().to_string();
        if name == "cbc-sid" || name == "hlp_token" || name == "SessionID" || name == "user_tag" || name == "SSOTGC" || name == "SSOJTC" {
            has_auth_marker = true;
        }
        parts.push(format!("{name}={value}"));
    }

    if parts.is_empty() {
        return Err(Error::Msg("未在登录窗口中检测到 Cookie，请先在窗口中完成登录".to_string()));
    }

    if !has_auth_marker {
        return Err(Error::Msg("未检测到登录成功的有效凭证 (如 cbc-sid / SSOTGC)，请确认是否已在窗口中登录成功".to_string()));
    }

    let raw_cookie_str = parts.join("; ");

    // 尝试在 webview 窗口内直接触发一次签到按钮点击（保持与官方页面 UI 状态同步）
    let _ = w.eval(r#"
        (function() {
            try {
                const btns = Array.from(document.querySelectorAll('button, div, span, a'));
                const btn = btns.find(b => b.textContent && b.textContent.trim() === '签到');
                if (btn) btn.click();
            } catch(e) {}
        })();
    "#);

    // 自动通过 devdata 刷新出最新的 ECO_CN_ID 会话
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| Error::Msg(format!("创建 HTTP 客户端失败: {e}")))?;

    let (cookie_str, _) = refresh_eco_session(&client, &raw_cookie_str).await;

    // 自动更新并保存到 checkin 配置中
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let mut config = load_checkin_config(&home);
    config.cookie = cookie_str.clone();
    save_checkin_config(&home, &config)?;

    // 保留独立登录窗口不强制关闭，方便用户查看个人主页及积分状态
    // let _ = w.close();

    Ok(cookie_str)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckinHistoryItem {
    pub date: String,
    pub time: String,
    pub success: bool,
    pub channel: String,
    pub message: String,
    pub points: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckinConfig {
    pub cookie: String,
    pub auto_checkin: bool,
    pub channel: String, // "codearts" | "growth" | "all"
    pub custom_url: Option<String>,
    pub last_checkin_date: Option<String>,
    pub last_checkin_message: Option<String>,
    pub streak_days: u32,
    pub total_points: i64,
    pub history: Vec<CheckinHistoryItem>,
}

impl Default for CheckinConfig {
    fn default() -> Self {
        Self {
            cookie: String::new(),
            auto_checkin: true,
            channel: "all".to_string(),
            custom_url: None,
            last_checkin_date: None,
            last_checkin_message: None,
            streak_days: 0,
            total_points: 0,
            history: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckinResult {
    pub success: bool,
    pub date: String,
    pub message: String,
    pub points: Option<i64>,
    pub streak_days: u32,
    pub total_points: i64,
}

fn get_config_path(home: &Path) -> PathBuf {
    home.join(".codeartsdoer/checkin_config.json")
}

fn load_checkin_config(home: &Path) -> CheckinConfig {
    let p = get_config_path(home);
    if let Ok(text) = std::fs::read_to_string(&p) {
        if let Ok(cfg) = serde_json::from_str::<CheckinConfig>(&text) {
            return cfg;
        }
    }
    CheckinConfig::default()
}

fn save_checkin_config(home: &Path, cfg: &CheckinConfig) -> Result<()> {
    let p = get_config_path(home);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(cfg)
        .map_err(|e| Error::Msg(format!("序列化签到配置失败: {e}")))?;
    std::fs::write(&p, text).map_err(|e| Error::Msg(format!("写入签到配置文件失败: {e}")))?;
    Ok(())
}

/// 计算当前东八区 (Asia/Shanghai) 日期与时间
pub fn current_cst_datetime() -> (String, String) {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let local = now + 28800; // UTC+8
    let day_seconds = (local % 86400) as u32;
    let hour = day_seconds / 3600;
    let minute = (day_seconds % 3600) / 60;
    let second = day_seconds % 60;

    let z = (local / 86400) as i64 + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1024 + doe / 1461 - doe / 142401) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    let date_str = format!("{y:04}-{m:02}-{d:02}");
    let time_str = format!("{hour:02}:{minute:02}:{second:02}");
    (date_str, time_str)
}

/// 计算两个日期字符串相差天数 (YYYY-MM-DD)
fn days_between(d1: &str, d2: &str) -> Option<i64> {
    fn parse_day(s: &str) -> Option<i64> {
        let parts: Vec<&str> = s.split('-').collect();
        if parts.len() != 3 {
            return None;
        }
        let y: i64 = parts[0].parse().ok()?;
        let m: i64 = parts[1].parse().ok()?;
        let d: i64 = parts[2].parse().ok()?;
        let mut y = y;
        let mut m = m;
        if m <= 2 {
            y -= 1;
            m += 12;
        }
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = (y - era * 400) as u32;
        let doy = (153 * (m - 3) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy as u32;
        Some(era * 146097 + doe as i64 - 719468)
    }

    let day1 = parse_day(d1)?;
    let day2 = parse_day(d2)?;
    Some(day2 - day1)
}

/// 过滤非法 HTTP Header 控制字符（如换行符）与非 ASCII 字符
fn clean_header_val(s: &str) -> String {
    s.chars()
        .filter(|c| *c != '\r' && *c != '\n' && c.is_ascii())
        .collect::<String>()
        .trim()
        .to_string()
}

/// 从可能包含 cURL 或前缀的文本中智能清洗并提取纯 Cookie 字符串
pub fn sanitize_cookie(raw: &str) -> String {
    let val = raw.trim();
    // 1. 匹配 -b '...' 或 -b "..."
    if let Some(idx) = val.find("-b ") {
        let sub = val[idx + 3..].trim_start();
        if let Some(quote) = sub.chars().next() {
            if quote == '\'' || quote == '"' {
                if let Some(end_idx) = sub[1..].find(quote) {
                    return clean_header_val(&sub[1..1 + end_idx]);
                }
            }
        }
    }
    // 2. 匹配 --cookie '...' 或 --cookie "..."
    if let Some(idx) = val.find("--cookie ") {
        let sub = val[idx + 9..].trim_start();
        if let Some(quote) = sub.chars().next() {
            if quote == '\'' || quote == '"' {
                if let Some(end_idx) = sub[1..].find(quote) {
                    return clean_header_val(&sub[1..1 + end_idx]);
                }
            }
        }
    }
    // 3. 匹配 -H 'cookie: ...' 或 -H "cookie: ..."
    let val_lower = val.to_lowercase();
    for pattern in &["-h 'cookie:", "-h \"cookie:"] {
        if let Some(idx) = val_lower.find(pattern) {
            let sub = &val[idx + pattern.len()..];
            let quote = if pattern.contains('\'') { '\'' } else { '"' };
            if let Some(end_idx) = sub.find(quote) {
                return clean_header_val(&sub[..end_idx]);
            }
        }
    }

    // 4. 过滤行首多余的 cookie:
    let s = if val_lower.starts_with("cookie:") {
        val[7..].trim()
    } else {
        val
    };
    clean_header_val(s)
}

/// 从 Cookie 键值对中提取 CSRF 防御 Token (如 csrf-eco)
pub fn extract_csrf_token(cookie: &str) -> Option<String> {
    for part in cookie.split(';') {
        let part = part.trim();
        if let Some(val) = part.strip_prefix("csrf-eco=") {
            let v = clean_header_val(val);
            if !v.is_empty() {
                return Some(v);
            }
        }
        if let Some(val) = part.strip_prefix("csrf=") {
            let v = clean_header_val(val);
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn checkin_get_config(app: tauri::AppHandle) -> Result<CheckinConfig> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let mut config = load_checkin_config(&home);
    let clean = sanitize_cookie(&config.cookie);
    if clean != config.cookie {
        config.cookie = clean;
        let _ = save_checkin_config(&home, &config);
    }
    Ok(config)
}

#[tauri::command]
pub async fn checkin_save_config(app: tauri::AppHandle, mut config: CheckinConfig) -> Result<()> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    config.cookie = sanitize_cookie(&config.cookie);
    save_checkin_config(&home, &config)?;
    Ok(())
}

/// 自动向 devdata.huaweicloud.com 刷新 ECO_CN_ID 会话凭据，并返回更新后的 Cookie 字符串
pub async fn refresh_eco_session(client: &reqwest::Client, cookie: &str) -> (String, bool) {
    let url = "https://devdata.huaweicloud.com/index/islogin";
    let resp = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Cookie", cookie)
        .header("Origin", "https://developer.huaweicloud.com")
        .header("Referer", "https://developer.huaweicloud.com/")
        .send()
        .await;

    if let Ok(r) = resp {
        let mut new_eco = None;
        for (k, v) in r.headers().iter() {
            if k == reqwest::header::SET_COOKIE {
                if let Ok(v_str) = v.to_str() {
                    for part in v_str.split(';') {
                        let part = part.trim();
                        if part.starts_with("ECO_CN_ID=") {
                            new_eco = Some(part.to_string());
                            break;
                        }
                    }
                }
            }
        }
        if let Some(eco_str) = new_eco {
            let mut parts: Vec<String> = cookie
                .split(';')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && !s.starts_with("ECO_CN_ID="))
                .collect();
            parts.push(eco_str);
            return (parts.join("; "), true);
        }
    }
    (cookie.to_string(), false)
}

/// 执行华为云成长中心每日签到（已切换至 11月23日 上线的新平台 API）
async fn checkin_growth_center(
    client: &reqwest::Client,
    cookie: &str,
) -> (bool, String, Option<i64>, Option<i64>, Option<String>) {
    // 华为云开发者成长中心新平台于 11月23日 正式上线，采用全新 API 体系
    let new_url = "https://grow-dataset.developer.huaweicloud.com/api/v1/hdgrowservice/user/sign-in";

    // 1. 先自动通过 devdata 刷新 ECO_CN_ID 保持最新会话
    let (mut active_cookie, mut refreshed) = refresh_eco_session(client, cookie).await;
    let csrf_opt = extract_csrf_token(&active_cookie);

    let mut req = client
        .post(new_url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Cookie", &active_cookie)
        .header("Origin", "https://grow.developer.huaweicloud.com")
        .header("Referer", "https://grow.developer.huaweicloud.com/")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/plain, */*");

    if let Some(ref csrf) = csrf_opt {
        req = req.header("csrf", csrf).header("x-csrf-token", csrf);
    }

    let mut resp = req.json(&serde_json::json!({})).send().await;

    // 2. 如果返回 401 且之前未刷新过，重新尝试刷新一次并重试请求
    if let Ok(ref r) = resp {
        if r.status().as_u16() == 401 && !refreshed {
            let (retry_cookie, did_refresh) = refresh_eco_session(client, cookie).await;
            if did_refresh {
                active_cookie = retry_cookie;
                refreshed = true;
                let mut retry_req = client
                    .post(new_url)
                    .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                    .header("Cookie", &active_cookie)
                    .header("Origin", "https://grow.developer.huaweicloud.com")
                    .header("Referer", "https://grow.developer.huaweicloud.com/")
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/plain, */*");
                if let Some(ref csrf) = extract_csrf_token(&active_cookie) {
                    retry_req = retry_req.header("csrf", csrf).header("x-csrf-token", csrf);
                }
                resp = retry_req.json(&serde_json::json!({})).send().await;
            }
        }
    }

    let cookie_to_save = if refreshed { Some(active_cookie) } else { None };

    match resp {
        Ok(r) => {
            let status = r.status();
            if status.as_u16() == 401 {
                return (
                    false,
                    "成长中心：未登录或登录已过期，请点击【打开内置登录窗口】并在新平台完成登录与同步".to_string(),
                    None,
                    None,
                    cookie_to_save,
                );
            }
            if status.as_u16() == 403 {
                let txt = r.text().await.unwrap_or_default();
                return (false, format!("成长中心返回 403: {txt}"), None, None, cookie_to_save);
            }

            if let Ok(v) = r.json::<serde_json::Value>().await {
                let code_num = v.get("code").and_then(|c| c.as_i64());
                let code_str = v.get("code").and_then(|c| c.as_str()).unwrap_or("");
                let msg = v.get("message").and_then(|m| m.as_str())
                    .or_else(|| v.get("msg").and_then(|m| m.as_str()))
                    .unwrap_or("请求完成");

                let mut points = None;
                let mut total_points = None;
                let mut is_signed = false;

                if let Some(data) = v.get("data") {
                    if let Some(p) = data.get("points").and_then(|x| x.as_i64()) {
                        points = Some(p);
                    }
                    if let Some(tp) = data.get("total_points").and_then(|x| x.as_i64()) {
                        total_points = Some(tp);
                    }
                    if let Some(s) = data.get("signed").and_then(|x| x.as_bool()) {
                        is_signed = s;
                    }
                }

                let is_ok = code_num == Some(0) || code_num == Some(200) || code_str == "0" || code_str == "200";
                if is_ok || msg.contains("成功") {
                    let p = points.unwrap_or(0);
                    if p > 0 {
                        let total_str = total_points.map(|t| format!("（总积分 {t}）")).unwrap_or_default();
                        (true, format!("成长中心签到成功，获得 +{p} 积分{total_str}"), Some(p), total_points, cookie_to_save)
                    } else if is_signed || p == 0 {
                        let total_str = total_points.map(|t| format!("（总积分 {t}）")).unwrap_or_default();
                        (true, format!("成长中心今日已完成签到{total_str}"), None, total_points, cookie_to_save)
                    } else {
                        (true, "成长中心签到请求完成".to_string(), None, total_points, cookie_to_save)
                    }
                } else if msg.contains("已签到") || msg.contains("重复") || code_num == Some(10002) {
                    let total_str = total_points.map(|t| format!("（总积分 {t}）")).unwrap_or_default();
                    (true, format!("成长中心今日已签到过{total_str}"), None, total_points, cookie_to_save)
                } else if msg.contains("未登录") || code_num == Some(10001) {
                    (
                        false,
                        "成长中心：未登录或登录凭据已过期，请点击【打开内置登录窗口】并在新平台完成登录与同步".to_string(),
                        None,
                        None,
                        cookie_to_save,
                    )
                } else {
                    (false, format!("成长中心响应：{msg}"), None, total_points, cookie_to_save)
                }
            } else {
                (false, "成长中心接口返回数据解析异常，建议更新登录凭据".to_string(), None, None, cookie_to_save)
            }
        }
        Err(e) => (false, format!("请求成长中心异常: {e}"), None, None, cookie_to_save),
    }
}

/// 执行 CodeArts 码道 AI 算力与每日积分领取
async fn checkin_codearts_benefit(client: &reqwest::Client, cookie: &str) -> (bool, String, Option<i64>) {
    let url = "https://opengw.developer.huaweicloud.com/api/v1/benefit/claim";
    let csrf_opt = extract_csrf_token(cookie);

    let mut req = client
        .post(url)
        .header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header("Cookie", cookie)
        .header("Origin", "https://developer.huaweicloud.com")
        .header("Referer", "https://developer.huaweicloud.com/")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/plain, */*");

    if let Some(ref csrf) = csrf_opt {
        req = req.header("csrf", csrf).header("x-csrf-token", csrf);
    }

    let resp = req.json(&serde_json::json!({ "benefitType": "daily" })).send().await;

    match resp {
        Ok(r) => {
            let status = r.status();
            if status.as_u16() == 401 {
                return (false, "CodeArts 算力通道需专属 IAM 令牌，建议切换为【成长中心每日签到通道】".to_string(), None);
            }

            if let Ok(v) = r.json::<serde_json::Value>().await {
                let success = v.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
                let msg = v.get("message").and_then(|m| m.as_str())
                    .or_else(|| v.get("msg").and_then(|m| m.as_str()))
                    .unwrap_or("请求完成");

                let mut amount = None;
                if let Some(data) = v.get("data") {
                    if let Some(a) = data.get("benefitAmount").and_then(|x| x.as_i64()) {
                        amount = Some(a);
                    }
                }

                if success || msg.contains("成功") {
                    let amt_str = amount.map(|a| format!("，到账 +{a} 算力福利")).unwrap_or_default();
                    (true, format!("CodeArts 算力福利领取成功{amt_str}"), amount)
                } else if msg.contains("已领取") || msg.contains("已签到") {
                    (true, "CodeArts 算力福利今日已领取".to_string(), None)
                } else {
                    (false, format!("CodeArts 响应：{msg}"), None)
                }
            } else {
                (false, "CodeArts 福利接口解析失败，可能需更新 Cookie".to_string(), None)
            }
        }
        Err(e) => (false, format!("请求 CodeArts 福利接口异常: {e}"), None),
    }
}

#[tauri::command]
pub async fn checkin_execute_now(
    app: tauri::AppHandle,
    channel: Option<String>,
) -> Result<CheckinResult> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let mut config = load_checkin_config(&home);

    let clean_cookie = sanitize_cookie(&config.cookie);
    if clean_cookie.is_empty() {
        return Err(Error::Msg("尚未配置华为云登录凭据 (Cookie)，请先在设置中填写".to_string()));
    }

    if clean_cookie != config.cookie {
        config.cookie = clean_cookie.clone();
        let _ = save_checkin_config(&home, &config);
    }

    let cookie = &clean_cookie;
    let (today, now_time) = current_cst_datetime();
    let ch = channel.unwrap_or_else(|| config.channel.clone());

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| Error::Msg(format!("创建 HTTP 客户端失败: {e}")))?;

    let mut overall_success = false;
    let mut messages = Vec::new();
    let mut total_points_earned = 0i64;

    // 通道 1: CodeArts 码道 AI 算力与每日积分
    if ch == "codearts" || ch == "all" {
        let (ok, msg, pts) = checkin_codearts_benefit(&client, cookie).await;
        if ok {
            overall_success = true;
            if let Some(p) = pts {
                total_points_earned += p;
            }
        }
        messages.push(msg);
    }

    // 通道 2: 华为云开发者成长中心每日签到
    if ch == "growth" || ch == "all" {
        let (ok, msg, pts, latest_total, refreshed_cookie) = checkin_growth_center(&client, cookie).await;
        if let Some(rc) = refreshed_cookie {
            config.cookie = rc;
        }
        if let Some(tp) = latest_total {
            config.total_points = tp;
        }
        if ok {
            overall_success = true;
            if let Some(p) = pts {
                total_points_earned += p;
            }
        }
        messages.push(msg);
    }

    let summary_msg = if messages.is_empty() {
        "未选择有效签到通道".to_string()
    } else {
        messages.join("；")
    };

    // 维护连续签到天数与累计积分
    if overall_success {
        if let Some(ref last_d) = config.last_checkin_date {
            match days_between(last_d, &today) {
                Some(1) => {
                    config.streak_days += 1;
                }
                Some(0) => {
                    // 今日已打卡，不重置也不重复加天数
                }
                _ => {
                    config.streak_days = 1;
                }
            }
        } else {
            config.streak_days = 1;
        }

        config.last_checkin_date = Some(today.clone());
        if total_points_earned > 0 && config.total_points == 0 {
            config.total_points += total_points_earned;
        }
    }

    config.last_checkin_message = Some(summary_msg.clone());

    // 记录历史明细（最多保留 50 条）
    config.history.insert(
        0,
        CheckinHistoryItem {
            date: today.clone(),
            time: now_time,
            success: overall_success,
            channel: ch,
            message: summary_msg.clone(),
            points: if total_points_earned > 0 { Some(total_points_earned) } else { None },
        },
    );
    if config.history.len() > 50 {
        config.history.truncate(50);
    }

    save_checkin_config(&home, &config)?;

    Ok(CheckinResult {
        success: overall_success,
        date: today,
        message: summary_msg,
        points: if total_points_earned > 0 { Some(total_points_earned) } else { None },
        streak_days: config.streak_days,
        total_points: config.total_points,
    })
}

#[tauri::command]
pub async fn checkin_auto_check(app: tauri::AppHandle) -> Result<Option<CheckinResult>> {
    let settings = Settings::load(&app)?;
    let home = settings.kernel_home();
    let config = load_checkin_config(&home);

    if !config.auto_checkin || config.cookie.trim().is_empty() {
        return Ok(None);
    }

    let (today, _) = current_cst_datetime();
    if let Some(ref last) = config.last_checkin_date {
        if last == &today {
            // 今日已签到过，直接返回静默跳过
            return Ok(None);
        }
    }

    // 执行静默签到
    let res = checkin_execute_now(app, None).await?;
    Ok(Some(res))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_current_cst_datetime() {
        let (d, t) = current_cst_datetime();
        assert_eq!(d.len(), 10);
        assert_eq!(t.len(), 8);
        assert!(d.contains('-'));
        assert!(t.contains(':'));
    }

    #[test]
    fn test_days_between() {
        assert_eq!(days_between("2026-11-21", "2026-11-22"), Some(1));
        assert_eq!(days_between("2026-11-22", "2026-11-22"), Some(0));
        assert_eq!(days_between("2026-11-20", "2026-11-22"), Some(2));
        assert_eq!(days_between("2026-10-31", "2026-11-01"), Some(1));
    }

    #[test]
    fn test_sanitize_cookie() {
        let multiline_curl = "curl --url 'https://example.com' \\\n  -H 'accept: */*' \\\n  -b '_frid=123; csrf-eco=abc-456; SessionID=xyz' \\\n  -H 'csrf: abc-456'";
        assert_eq!(sanitize_cookie(multiline_curl), "_frid=123; csrf-eco=abc-456; SessionID=xyz");

        let h_cmd = r#"curl 'https://example.com' -H 'Cookie: a=1; b=2'"#;
        assert_eq!(sanitize_cookie(h_cmd), "a=1; b=2");

        let plain = "cookie: token=hello12345";
        assert_eq!(sanitize_cookie(plain), "token=hello12345");
    }

    #[test]
    fn test_extract_csrf_token() {
        let cookie = "_frid=123; csrf-eco=25a3731c-9feb-4f60-971e-2178e9be0775; cbc-sid=abc";
        assert_eq!(extract_csrf_token(cookie), Some("25a3731c-9feb-4f60-971e-2178e9be0775".to_string()));
    }
}
