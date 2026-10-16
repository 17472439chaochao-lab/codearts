use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("内核未运行")]
    NotRunning,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("内核返回的内容不是合法 JSON：{0}")]
    Json(#[from] serde_json::Error),
    #[error("内核返回了非 JSON 响应（content-type: {0}）")]
    NonJson(String),
}

// Tauri 要求命令的 Err 实现 Serialize；前端只需要可读文案。
impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub trait MsgExt<T> {
    fn msg(self, ctx: impl std::fmt::Display) -> Result<T>;
}

impl<T, E: std::fmt::Display> MsgExt<T> for std::result::Result<T, E> {
    fn msg(self, ctx: impl std::fmt::Display) -> Result<T> {
        self.map_err(|e| Error::Msg(format!("{ctx}：{e}")))
    }
}
