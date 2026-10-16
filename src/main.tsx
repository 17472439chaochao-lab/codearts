import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

/**
 * WKWebView 自带的右键菜单（重新加载 / 检查元素 / 查找 / 翻译 / 服务）对桌面壳没有意义，
 * 全局压掉；需要菜单的地方（工作区、会话）自己画。
 */
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
