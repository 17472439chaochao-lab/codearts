//! 本机 Vision OCR：内核没有视觉模型时，用 macOS 自带框架把截图里的文字读出来。

use base64::Engine;

#[tauri::command]
pub async fn ocr_image(data_url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || recognize(&data_url))
        .await
        .map_err(|e| format!("OCR 任务异常：{e}"))?
}

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

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_text_from_a_real_screenshot() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/screenshot.png");
        let raw = std::fs::read(path).expect("README 截图不存在");
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
