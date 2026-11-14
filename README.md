# CodeArts CLI Desktop

![platform](docs/badges/platform.svg) ![license](docs/badges/license.svg) ![version](docs/badges/version.svg) ![UI](docs/badges/ui.svg)

非官方的 **桌面端，用 Tauri 2 驱动本机码道 CLI**。支持 macOS（Universal 包，Intel 与 Apple Silicon 通吃）和 Windows（x64 / arm64，0.1.8 起）。官方桌面端只发 Apple Silicon 包。源码在 [GitHub](https://github.com/17472439chaochao-lab/codearts)，MIT 开源。

![首次启动](screenshots/setup.png)
![主界面](screenshots/main.png)

## 功能

- 会话：流式输出、停止与重试；工具调用按轮折叠，轮末汇总改动的文件
- 文件：按工作区浏览、预览、语法高亮与逐行 diff，文本文件可直接编辑并保存（⌘S / Ctrl+S）
- 多工作区切换不重启内核，后台会话继续跑；支持 Git 分支切换
- 子任务进展、待办清单、权限审批、反问选项与斜杠命令
- 设置整体导出/导入（明文 JSON，含凭据）；支持从 GitHub 安装技能
- 断线自动重连、限流自动重试、危险命令告警
- 本地截图 OCR 目前仅 macOS（系统 Vision 框架）

## 构建

### macOS

需要 macOS、Rust stable（rustup）、Xcode Command Line Tools、Node 20+。

先安装官方码道 CLI（安装脚本会自动取本机架构的二进制）：

```bash
sh -c "$(curl -L https://cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com/codearts/cli_tui/install_script/install.sh)"
export PATH=~/.codeartsdoer/installers:$PATH
```

```bash
npm install
npm run tauri dev
npm run tauri build
```

`npm run tauri build` 默认产出 **Universal** 包（`*_universal.dmg`）：一份安装包在 Intel 和 Apple Silicon 上都原生运行，缺少的 rustup target 会在构建前自动补装。只想出单一架构时显式传 `--target`：

```bash
npm run tauri build -- --target aarch64-apple-darwin   # 只出 Apple Silicon
npm run tauri build -- --target x86_64-apple-darwin    # 只出 Intel
```

### Windows

需要 Windows 10/11、Rust stable（MSVC 工具链，rustup 默认即带）、Node 20+。

先在 PowerShell 安装官方码道 CLI：

```powershell
irm https://cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com/codearts/cli_tui/install_script/install.ps1 | iex
```

```powershell
npm install
npm run tauri dev
npm run tauri build
```

产出 NSIS（`*_x64-setup.exe`）与 MSI 安装包，在 `src-tauri/target/release/bundle/` 下的 `nsis/`、`msi/` 目录。

只想看界面：`npm run dev`，打开 `/preview-setup.html`。

## CI 出包

不用本机编译的话，到 [Actions → 构建安装包](https://github.com/17472439chaochao-lab/codearts/actions/workflows/installers.yml) 手动 Run workflow：matrix 并行构建，`windows-latest` 出 NSIS/MSI，`macos-latest` 出 Universal DMG，在该次运行的 Artifacts 里下载。

## 测试

```bash
npm test           # 消息合并与工具输出单测
npm run test:ui    # 浏览器回归，需要 Node 22+ 和 Chrome
```

## 说明

不做自动更新；MCP 只做只读展示；Windows 支持自 0.1.8 起（窗口暂用原生标题栏，自绘标题栏的适配在计划中）。本项目与华为云官方无关，CodeArts 名称及相关内核权利归华为云所有。
