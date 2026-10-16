# CodeArts Desktop

本程序为Rust编写的华为云码道CodeArts的Mac桌面端（非官方版），官方只构建了Apple Silicon包，Intel版的Mac无法安装。

![主界面](docs/screenshot.png)

左侧是工作区和会话列表，右侧是对话区。顶栏显示内核版本与启停按钮，输入框下方依次是 agent、授权策略和模型选择。

## 功能

- 会话聊天：新建、切换、删除，流式增量渲染，工具调用折叠卡片和 patch 视图，中途可停止
- 多工作区：左侧栏添加和切换目录，切换时自动重启内核并把新目录写进内核信任白名单
- 斜杠命令面板与 agent 切换，数据取自内核 `/command`、`/agent`
- 子任务会话（`/session/:id/children`）只读展示
- 权限审批：内核发起的待决权限请求在界面上同意或拒绝，可切 bash 沙箱模式
- 技能与 MCP 清单只读展示（写入仍要去 CLI 侧配置）
- 内核管理：健康检查、崩溃自愈、退出时 dispose 不留孤儿进程，「更新内核」跑 `codearts upgrade`
- 凭据管理：AK/SK 存本机，SK 不进前端、不回显

## 启动

每次启动都先看首屏检测页，三项都绿了才能点「进入工作区」：

1. 码道 CLI（内核）装没装
2. 华为云 AK/SK 有没有
3. 当前工作区选没选

## 依赖

- macOS
- Rust stable、Xcode Command Line Tools
- Node 20+
- 官方码道 CLI：

```bash
sh -c "$(curl -L https://cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com/codearts/cli_tui/install_script/install.sh)"
export PATH=~/.codeartsdoer/installers:$PATH
```

装完落在 `~/.codeartsdoer/installers/bin/codearts`。国内网络建议 cargo 配 rsproxy 镜像、npm 配 npmmirror。

## 开发

```bash
npm install
npm run tauri dev       # 前端 vite 固定 1420，改端口要同步 src-tauri/tauri.conf.json
npx tsc --noEmit        # 只查前端类型
npm run tauri build     # 打包，指定架构加 -- --target x86_64-apple-darwin
```

只想看界面、不装内核：`preview-setup.html` 是首屏的浏览器预览台，用 mockIPC 顶掉 Rust 侧。
先 `npm run dev`，再打开 `/preview-setup.html?state=cli|cred|dir|ready` 看各分支。这个文件不进打包产物。

## 代码位置

```
src/App.tsx          首屏检测页、侧栏、设置面板
src/Chat.tsx         消息流与输入区
src/kernelApi.ts     内核端点的 invoke 包装
src-tauri/src/kernel.rs    端口探测、spawn serve、健康检查、重启、dispose
src-tauri/src/api.rs       Basic 鉴权的 HTTP 封装与 SSE 事件泵
src-tauri/src/settings.rs  配置读写、内核可执行文件探测
src-tauri/src/secrets.rs   凭据与 endpoint 落盘
src-tauri/src/trust.rs     写内核的 security.trustedFolders
```

Rust 侧只暴露这些命令给前端：`env_check`、`settings_save`、`credentials_save`、`credentials_status`、
`kernel_start`、`kernel_stop`、`kernel_status`、`kernel_upgrade`、`api_request`。
内核的服务密码和 SK 都只留在 Rust 侧，WebView 拿不到；serve 固定监听 127.0.0.1。

## 配置和数据

都不在仓库里：

- 非敏感配置：`~/Library/Application Support/com.wuchengchao.codeartsdesktop/settings.json`
- AK / SK / endpoint：同目录 `secrets/` 下的 0600 文件。没用钥匙串，因为未签名的 dev 二进制写进去读不出来
- 会话与消息：`<内核 HOME>/.codeartsdoer/cli-data/`，归内核自己管

内核路径全部自动探测：先按配置或环境里的 `HOME` 拼 `.codeartsdoer/installers/bin/codearts`，
找不到再遍历本机各用户目录。界面上没有手填路径的入口，`settings.json` 里的 `kernelHome`、`kernelBin`
是留着救急的，一般不要动。

## 已知限制

- 只出 macOS 包，Windows / Linux 不做
- 不做自动更新，内核升级是手动按钮
- 技能、MCP 的增删改不做，壳里只读
- 不复刻官方桌面端的建应用、一键发布、连接器市场
- 官方启动脚本带了 `NODE_TLS_REJECT_UNAUTHORIZED=0`，内核进程关了 TLS 证书校验；壳侧调别的接口不继承这个
- 如果内核的可执行文件和它的数据目录分在两个 `HOME` 下（多账户机器上会这样），
  会话记录可能看起来"丢了"，检查时 bin 路径和 cli-data 要分开看
