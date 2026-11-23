//! 本机 Vision OCR：内核没有视觉模型时，用 macOS 自带框架把截图里的文字读出来。

use base64::Engine;

#[tauri::command]
pub async fn ocr_image(data_url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || recognize(&data_url))
        .await
        .map_err(|e| format!("OCR 任务异常：{e}"))?
}

/// 读取剪贴板中的图片（解决 macOS WebKit 无法通过 navigator.clipboard 读取图片的问题）
#[tauri::command]
pub fn read_clipboard_image() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::rc::autoreleasepool;
        use objc2::runtime::{AnyClass, AnyObject};
        use objc2_foundation::{NSData, NSString};

        autoreleasepool(|_| {
            let cls = AnyClass::get(c"NSPasteboard")?;
            let pboard: *mut AnyObject = unsafe { msg_send![cls, generalPasteboard] };
            if pboard.is_null() {
                return None;
            }

            // 优先检查 png
            let png_type = NSString::from_str("public.png");
            let data: *mut NSData = unsafe { msg_send![pboard, dataForType: &*png_type] };
            if let Some(data) = unsafe { data.as_ref() } {
                let bytes_ptr: *const u8 = unsafe { msg_send![data, bytes] };
                let len: usize = unsafe { msg_send![data, length] };
                if !bytes_ptr.is_null() && len > 0 {
                    let slice = unsafe { std::slice::from_raw_parts(bytes_ptr, len) };
                    let b64 = base64::engine::general_purpose::STANDARD.encode(slice);
                    return Some(format!("data:image/png;base64,{b64}"));
                }
            }

            // 次选 tiff (macOS 截图原生支持 tiff)
            let tiff_type = NSString::from_str("public.tiff");
            let data: *mut NSData = unsafe { msg_send![pboard, dataForType: &*tiff_type] };
            if let Some(data) = unsafe { data.as_ref() } {
                let bytes_ptr: *const u8 = unsafe { msg_send![data, bytes] };
                let len: usize = unsafe { msg_send![data, length] };
                if !bytes_ptr.is_null() && len > 0 {
                    let slice = unsafe { std::slice::from_raw_parts(bytes_ptr, len) };
                    let b64 = base64::engine::general_purpose::STANDARD.encode(slice);
                    return Some(format!("data:image/tiff;base64,{b64}"));
                }
            }

            None
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// 非 macOS 平台暂时没有调用方（Windows/Linux 的本地 OCR 还没接），允许 dead_code
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn decode_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let (head, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "图片数据格式不正确".to_string())?;
    if !head.starts_with("data:") || !head.contains(";base64") {
        return Err("只支持 base64 编码的图片".into());
    }
    base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("图片解码失败：{e}"))
}

#[cfg(target_os = "macos")]
fn recognize(data_url: &str) -> Result<String, String> {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
        VNRequestTextRecognitionLevel,
    };

    let bytes = decode_data_url(data_url)?;
    autoreleasepool(|_| {
        let data = NSData::with_bytes(&bytes);
        let options = NSDictionary::<VNImageOption, AnyObject>::new();
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &options,
        );

        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        request.setRecognitionLanguages(&NSArray::from_retained_slice(&[
            NSString::from_str("zh-Hans"),
            NSString::from_str("zh-Hant"),
            NSString::from_str("en-US"),
        ]));

        let request_ref: &VNRequest = &request;
        handler
            .performRequests_error(&NSArray::from_slice(&[request_ref]))
            .map_err(|e| format!("Vision 请求失败：{}", e.localizedDescription()))?;

        let Some(results) = request.results() else {
            return Ok(String::new());
        };

        // Vision 的坐标原点在左下角，按 y 从大到小还原阅读顺序；同一行再按 x 从左到右
        let mut lines: Vec<(f64, f64, String)> = Vec::new();
        for obs in results.iter() {
            let Some(candidate) = obs.topCandidates(1).firstObject() else {
                continue;
            };
            let text = candidate.string().to_string();
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            let rect = unsafe { obs.boundingBox() };
            lines.push((rect.origin.y, rect.origin.x, text.to_string()));
        }
        lines.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        });
        Ok(lines
            .into_iter()
            .map(|(_, _, text)| text)
            .collect::<Vec<_>>()
            .join("\n"))
    })
}

#[cfg(not(target_os = "macos"))]
fn recognize(_data_url: &str) -> Result<String, String> {
    Err("本地 OCR 目前只支持 macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_base64_data_url() {
        let bytes = decode_data_url("data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(bytes, b"hello");
        assert!(decode_data_url("data:image/png,hello").is_err());
        assert!(decode_data_url("hello").is_err());
    }

    /// 真图跑一遍 Vision。截图属于仓库里的可选素材（README 早就不引用它了），
    /// 文件不在时跳过而不是判失败，否则每次 cargo test 都红。
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_text_from_a_real_screenshot() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/screenshot.png");
        let Ok(raw) = std::fs::read(path) else {
            eprintln!("跳过 reads_text_from_a_real_screenshot：{path} 不存在");
            return;
        };
        let url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(raw)
        );
        let text = recognize(&url).unwrap();
        assert!(
            text.to_lowercase().contains("codearts"),
            "OCR 没认出截图标题：{text:.200}"
        );
    }
}
