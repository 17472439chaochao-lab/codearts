# CodeArts Desktop 可接入能力盘点

> 结论先行：桌面端目前只用了内核约 **9%** 的接口（约 30 / 330 个 operationId），CLI 子命令也基本只用了 `serve` 和 `upgrade`。代理白名单里已经预留了 `/cag/`、`/v1/`、`/file`、`/find`，所以**一半以上的功能只需要补前端**；真正要动 Rust 的主要是流式通道（PTY WebSocket）、少量白名单前缀，以及几个 CLI 子命令的封装。

盘点基于本机正在运行的内核（版本 `26.9.26`，端口与凭据取自 App 的 endpoint secrets）和官方 CLI 二进制。`/doc` 返回的 OpenAPI 只有 36 条且明显过期，**不能作为能力清单**；真实路由和 operationId 在可执行文件里（见附录 A）。

## 1. 当前实现覆盖了什么

| 域 | 已接入 | 代码位置 |
| --- | --- | --- |
| 内核生命周期 | 拉起、健康探测、接管遗留实例、崩溃自愈、停止、`codearts upgrade` | `src-tauri/src/kernel.rs` |
| 事件流 | `/event`（按 `x-opencode-directory` 订阅）、断线重连、限流重试 | `src-tauri/src/api.rs` |
| 会话 | 列表、新建、切换、删除、改名兜底、消息、`prompt_async`、`abort`、子会话、待办、diff、运行态 | `src/kernelApi.ts`、`src/Chat.tsx` |
| 授权与反问 | `permission.asked` / `question.asked` 卡片、回复、三种授权预设、bash 模式 | `Chat.tsx` |
| 模型 / agent / 命令 | `/provider`、`/agent`、`/command`（斜杠面板） | `Chat.tsx` |
| 文件 | Rust 侧文件树/读取、语法高亮、逐行 diff、计划文件 | `src-tauri/src/files.rs`、`src/Files.tsx` |
| 能力展示 | `/skill`、`/v1/skills`、`/mcp` 只读清单 | `App.tsx` 设置页 |
| CLI | `serve`、`upgrade` | `kernel.rs` |

明确没有的：**回退/重做、会话分叉、会话内执行命令、侧问、搜索（文件/全文/会话）、终端、后台进程、技能/Agent/MCP/规则的增删改、用量统计、导出/导入、Git/索引/定时任务**。

## 2. 内核能力地图

从二进制里提取到 330 个 `operationId`（含少量 AI SDK / 内部流式操作，实际 HTTP 路由约 280+），按域分布：

| 域 | 数量 | 代表能力 | 桌面端 |
| --- | --- | --- | --- |
| `cag.*` | 94 | 会话回退、分叉、侧问、Agent、规则、记忆、MCP、偏好、上下文审计、SDD | 仅用了部分只读 |
| `codebase.*` | 30 | 代码库索引、CodeGraph、多仓库、LSP 开关 | 未接 |
| `session.*` | 24 | fork、revert/unrevert、shell、command、summarize、share、init、deleteMessage | 用了 12 个 |
| `permission.*` | 12 | 全局规则、bash 模式、命令白名单 | 用了 4 个 |
| `tui.*` | 13 | 控制 TUI 的弹窗/输入/会话选择 | 不适用 |
| `pty.*` | 6 | 内置终端（WebSocket） | 未接 |
| `shell.*` | 6 | 后台命令列表、输出、转后台、杀掉 | 未接 |
| `cron.*` | 6 | 定时任务 CRUD、立即触发、执行日志 | 未接 |
| `mcp.*` | 8 | MCP OAuth、连接/断开、状态 | 仅只读列表 |
| `skills.*` | 6 | 技能创建/删除/批量改/云端同步 | 仅只读 |
| `model.*` | 8 | 模型增删改、校验、禁用 | 未接 |
| `rules.*` | 5 | 项目/用户/云端规则 CRUD | 未接 |
| `project.*` / `vcs.*` / `worktree.*` | 10 | Git 初始化、分支信息、工作树 | 仅 `GET /vcs`（标题栏分支），其余未接 |
| `file.*` / `find.*` | 6 | 文件读写、模糊找文件、全文搜索、符号 | 找文件/全文搜索已接入；符号未接（LSP 关闭） |
| `docgen.*` / `evolve.*` / `im.*` / `global.*` | 21 | 文档生成、自进化、IM 数字分身、全局配置/事件/升级 | 仅 health/dispose |

## 3. 建议接入的功能

### P0：会话主链路（感知最强，改动集中在前端）

| # | 功能 | 接口 | 建议 UI | 备注 |
| --- | --- | --- | --- | --- |
| 1 | **回退到某条消息** | `POST /cag/session/{id}/pre-revert` 预览 → `POST /cag/session/{id}/revert`（或 `/session/{id}/revert`） | 用户消息悬浮「从这里重来」；先弹预览（将撤回的消息 + 文件变更），确认后执行 | App 已经处理 `message.removed`（`Chat.tsx:833`），读路径是通的。预览接口在 CAG 命名空间下，`/session/.../pre-revert` 不存在 |
| 2 | **重做/恢复撤回** | `POST /session/{id}/unrevert`（CAG 同名接口也可） | 撤回后的 toast / 顶部条「恢复」 | 与 1 配套 |
| 3 | **从某条消息分叉** | `POST /session/{id}/fork` `{messageID}` | 消息菜单「在此分叉」；新会话自动继承到该消息 | 适合“保留原方案，另开一条思路” |
| 4 | **会话内执行斜杠命令（服务端）** | `POST /session/{id}/command` `{command, arguments, agent, model}` | 保留现有 `/` 面板，但发送改为走服务端 | 现在 `Chat.tsx:160` 是壳子自己替换 `$ARGUMENTS`，会丢掉 subtask/agent/model 覆盖语义。实测缺 `arguments` 会 400 |
| 5 | **会话内跑 shell** | `POST /session/{id}/shell` `{command, agent, model}` | 输入框 `!` 前缀，或「运行命令」按钮；结果作为一条 bash part 进入时间线 | 输出对模型可见，比自己开终端更贴近 agent 工作流。实测缺 `agent` 会 400 |
| 6 | **会话总结命令** | `GET /cag/command` → `POST /cag/session/{id}/command` `{command:"summarize", providerID, modelID}` | 把 `/cag/command` 合并进 `/` 面板 | `/command` 只返回 20 条普通命令，不含 `summarize` / `btw`；这是现在斜杠面板缺失的一条 |
| 7 | **手动压缩上下文** | `POST /session/{id}/summarize` `{providerID, modelID, auto}` | 上下文占用高时提示「压缩后继续」；也可手动触发 | 实测缺 `providerID` 会 400。现在只在事件里被动提示“上下文已压缩”（`Chat.tsx:938`） |
| 8 | **会话搜索 / 总数** | `GET /cag/session?search=&directory=&status=&limit=&offset=`、`GET /cag/session/total` | 侧栏搜索框；「全部会话」页，可按工作区/状态/日期筛选 | 现在侧栏每个工作区只露 3 条（`SIDE_PAGE`），找旧会话只能反复“加载更多” |
| 9 | **导出 / 导入会话** | CLI `codearts export <id>` / `codearts import <file>` | 会话菜单「导出 JSON」「导入」 | 已验证 export 输出：先一行 `Exporting session: …`，随后是 JSON；Rust 侧去掉首行即可 |
| 10 | **删除单条消息** | `DELETE /session/{id}/message/{messageID}` | 消息菜单「删除（不改文件）」 | 与回退区分：只清时间线，不动工作区 |

> 旁路提问（`POST /session/{id}/side-question`）在 HC 构建里走的是 `K()` 的另一条分支，**没有挂载**（实测返回 SPA 兜底页）；非 HC 构建才有。先不要把 UI 建在它上面。

### P0：检索与导航（把文件侧栏升级成 IDE 级）

| # | 功能 | 接口 | 建议 UI |
| --- | --- | --- | --- |
| 11 | **快速打开文件** | `GET /find/file?query=&type=file&limit=` | ✅ 已接入：`Cmd+P` / 标题栏按钮，模糊搜索，回车在 `FileViewer` 打开（`Files.tsx` 的 `QuickOpen`） |
| 12 | **工作区全文搜索** | `GET /find?pattern=` | ✅ 已接入：资源管理器「搜索」页签，`Cmd+Shift+F` 聚焦，点击跳到对应行。**该接口没有服务端条数上限**，壳侧限 300 行 + 350ms 防抖；`submatches.start/end` 是**行内 UTF-8 字节偏移**，不是 JS 下标，高亮前必须换算 |
| 13 | **文件内容 / 变更状态** | `GET /file/content?path=`、`GET /file/status`（已验证） | 现有 Rust 读取保留；搜索跳转和“内核眼里的变更”用这两个接口对齐 |
| 14 | **Git 分支 / 变更** | `GET /vcs`（已验证 `{branch, default_branch}`） | ✅ 分支已接入：标题栏分支胶囊，切工作区/会话跑动时刷新，非 Git 目录不显示（`api.rs` 白名单加了 `/vcs`）。`vcs.diff` 可做“本次会话之外”的改动视图，未接 |
| 15 | **符号跳转 / LSP** | `GET /find/symbol?query=`、`GET /lsp`、`GET /cag/codebase/v1/lsp` | 需要先把配置里的 `lsp:false` 打开；本机当前 LSP 是关闭的，符号搜索返回空 |

> 全文搜索和快速打开是投入产出比最高的一组：内核已经用 ripgrep 做好了索引和 ignore 规则，壳子不需要自己遍历工作区。

### P1：终端与后台进程

| # | 功能 | 接口 | 备注 |
| --- | --- | --- | --- |
| 16 | **内置终端** | `POST /pty`、`GET /pty`、`PUT/DELETE /pty/{id}`、`GET /pty/{id}/connect` | `connect` 是 **WebSocket**（实测 Upgrade 返回 101）。需要 Rust 用 `tokio-tungstenite` 桥接，前端用 xterm.js；端口和 Basic 密码不能进 WebView |
| 17 | **后台命令管理** | `GET /cag/shell`（已验证 `[]`）、`GET /cag/shell/{id}`、`/output`、`POST /cag/shell/{callID}/background`、`DELETE …/foreground`、`DELETE /cag/shell/{id}` | Agent 跑 `npm run dev` / 构建时常驻；现在这些进程在界面上是“消失”的。做一个「运行中的命令」面板，能看输出、转后台、杀掉 |
| 18 | **定时任务** | `GET/POST/PATCH/DELETE /cag/cron/tasks`、`POST /fire`、`GET /logs` | 数据已存在 `cli-data/cron/scheduled_tasks.json`。适合“每天跑一次测试/生成日报”这类任务 |

### P1：能力管理（把只读设置页变成可编辑）

| # | 功能 | 接口 | 现状 |
| --- | --- | --- | --- |
| 19 | **自定义 Agent** | `GET/POST/PATCH/DELETE /cag/agent`、`POST /cag/agent/toggle`、`/fresh`、`GET /cag/agent/single` | 只读列表；创建/编辑/禁用都没入口 |
| 20 | **Agent 团队 / 路由** | `GET /cag/agent-team/role`（已验证，返回内置角色全文）、`PUT /role/edit`、`GET /cag/agent-team/task`、`GET /cag/agents-router/config` | 多 agent 编排配置，适合“团队角色”页 |
| 21 | **技能管理** | `GET/POST/PUT/DELETE /v1/skills`、`GET /v1/skills/detail`、`PATCH /v1/skills/sync`、`PUT /config/skills/{name}/status` | README 明确写了“只读展示”；接口已经齐全，可以做成开关 + 云端同步 |
| 22 | **规则（Rules）** | `GET/POST/PUT/DELETE /cag/rules`、`POST /cag/rules/offline` | 项目规范/用户规范/云端规则，可直接在设置里编辑 |
| 23 | **MCP 管理** | `GET/POST/PUT/DELETE /cag/mcp`、`/connect`、`/disconnect`、`/refresh`；`POST /mcp/{name}/auth`、`/connect`、`/disconnect` | 当前只读。注意本机 HC 环境 `GET /cag/mcp/list` 返回 **403 “This feature is disabled in HC environment”**，要按环境做能力探测 |
| 24 | **模型管理** | `GET/POST /cag/model`、`/update`、`/delete`、`/verify`、`/disableAll`；`GET /provider/auth`、`/auth/{providerID}`、OAuth authorize/callback | 现在只能在 `/provider` 返回的模型里选；自定义模型、OAuth 登录都没有 |
| 25 | **偏好 / 记忆 / 经验** | `/cag/preference` CRUD + `/status`；`/cag/memory` list/import/delete + `/status`；`/cag/experience/config` | 已验证 status/config。记忆列表要带 `?directory=`（只带 header 会 400） |
| 26 | **全局配置** | `GET/PATCH /config`、`GET/PATCH /global/config`、`PATCH /cag/global/config` | `/config` 是 669KB 的已解析配置，别整份塞前端；用 `/global/config` 或按节读取 |

### P1：项目 / 索引

| # | 功能 | 接口 | 备注 |
| --- | --- | --- | --- |
| 27 | **Git 初始化 / 工作树** | `POST /project/git/init`、`GET /project/{id}`、`PATCH /project/{id}`、`GET/POST/DELETE /experimental/worktree` | 非 Git 目录目前只能直接打开；初始化后计划文件、diff、worktree 才完整 |
| 28 | **代码库索引** | `GET /cag/codebase/health`（已验证 `isCodeBaseReady:false`）、`POST /cag/codebase/v1/index`、`/v1/process`、`/v1/indexed/files`、`/v1/local-tools/codegraph/progress`、`PUT /cag/codebase/v1/lsp` | 大仓库的语义检索/CodeGraph；当前未建索引、LSP 关闭 |
| 29 | **文档生成** | `POST /cag/docgen/generate`、`GET /status`、`POST /apply`、`POST /abort` | 已有 `docgen-agent`，但没有任务态 UI |
| 30 | **SDD Schema** | `/cag/v1/sdd/schemas` CRUD + `setActive` | 规格驱动开发，偏进阶，可按需接 |

### P2：观测 / 诊断 / 平台

| # | 功能 | 接口 | 备注 |
| --- | --- | --- | --- |
| 31 | **用量统计** | CLI `codearts stats --days N --models N --tools N` | 已验证可跑：Sessions/Messages/成本/Token/模型分布/工具分布。需要和 `upgrade` 一样注入 AK/SK、trust、`KERNEL_DATA_DIR`。输出是带 ANSI 的表格，建议先原样等宽渲染，别急着解析 |
| 32 | **上下文审计** | `GET /cag/context-audit`（HTML 面板）、`/status`、`/aggregate`、`/events`、`/messages-view`、`/message-rounds`、`POST /enable` | 当前 `enabled:false`；能看每轮压缩前后消息和 token，排查“为什么上下文爆了”很有效 |
| 33 | **全局事件 / 多工作区并行**（已落地 26.10.19） | `GET /global/event`、`GET /experimental/session`、`/experimental/workspace` | SSE 桥已换成不带目录头的 `/global/event`，写路径统一带 `session.directory`：**切区不重启内核、后台会话继续跑**，实测记录见 `docs/api-contract.md` §11。`/experimental/*` 那两个接口仍未接 |
| 34 | **诊断** | CLI `codearts debug config/paths/scrap/skill/agent`；`POST /log`；`GET /global/dump` | 设置页加「诊断」页，输出脱敏 |
| 35 | **升级** | `POST /global/upgrade {target}` | 现在走 `codearts upgrade`；HTTP 版可省一次进程启动，但 CLI 版更贴近官方 |
| 36 | **分享会话** | `POST /session/{id}/share`、`DELETE /session/{id}/share` | 会生成公开链接，先确认 HC 环境的域名与合规要求再上 |
| 37 | **IM / 数字分身** | `/im/welink/*`、`/cag/im/*`、`/im/linker/*` | 企业 IM 场景，和桌面编码主线关系不大 |
| 38 | **生成式 UI / 扩展** | `/cag/widget` Schema CRUD、`/cag/extension` list/add/remove | 偏平台化，可后置 |

### 不建议接入

- `codearts uninstall`、`completion`、`privacy`：没有桌面端价值或不可逆。
- `tui.*`：那是给 TUI 自己用的控制通道。
- `/cag/browser`、`/cag/tool/edit`：需要 IDE/浏览器桥，单独做成本高。
- `part.update/delete`、`comm.create`：底层/未定型接口。
- `/global/dispose`：必须继续只由 Rust 壳调用，不能下放给 WebView。
- 原生 `/config` 整份读写：669KB，容易把配置写坏；优先按节编辑或直接改 `codearts_cli.json`（保留备份）。

## 4. 工程落点

### 4.1 代理白名单

`src-tauri/src/api.rs:12` 目前允许：
`/global/health`、`/session`、`/permission`、`/question`、`/provider`、`/config`、`/agent`、`/command`、`/skill`、`/mcp`、`/path`、`/project`、`/file`、`/find`、`/vcs`、`/v1/`、`/cag/`、`/sandbox`、`/whitelist`、`/doc`。

接新功能还需要补的前缀（`/vcs` 已于 26.10.20 补上）：

```text
/lsp          # LSP 状态
/formatter    # 格式化状态
/pty          # 终端
/experimental # worktree / session / workspace
/auth         # provider 凭据
/instance     # instance reload
/sync         # 事件补偿（如启用）
/im           # 数字分身（可选）
/log          # 壳侧写日志（可选）
/skillRule    # 技能下载规则（可选）
/global/event
/global/config
/global/dump
/global/sync-event
```

`/global/upgrade` 不建议直接放给 WebView，继续走已有的 `kernel_upgrade` 命令；`/global/dispose` 必须保持拒绝。

注意 `/cag/` 是带斜杠的前缀匹配，所以 **挂在 `/cag/` 下的接口现在就已经能过代理**，不需要改 Rust，只差前端调用（94 个 `cag.*` operationId 里有个别挂在 `/file-diffs`、`/part` 等路径下，需要单独放行）。

### 4.2 流式通道

- `/event`：现有 SSE 泵已经够用。
- `/global/event`：同样的 SSE 解析，换成不带目录头的连接；可作为“跨工作区实时状态”的基础。
- `/pty/{id}/connect`：**WebSocket**。建议加一个 `pty_connect` 命令：Rust 侧持有 WS，前端通过 Tauri event/channel 收发二进制帧；不要在前端直连端口。
- `/session/{id}/shell` 不是流式，输出会作为 part 通过 `/event` 回来。

### 4.3 CLI 封装

`kernel.rs` 的 `upgrade()` 已经是模板：注入 `HOME`、`KERNEL_DATA_DIR`、`KERNEL_CONFIG_DIR`、`OPENCODE_CONFIG`、`SCENARIO`，脱敏 AK/SK，设置 cwd 并做目录信任。新增 `run_cli(args, timeout)` 后可以复用给：

- `stats`（用量页）
- `export` / `import`（会话导入导出）
- `debug config` / `debug paths`（诊断页）
- `codebase` / `codebase-knowledge`（如果不想走 HTTP）
- `mcp add` / `agent create`：这两个是交互式的，**不适合直接包**；走 HTTP 的 `/cag/mcp`、`/cag/agent` 更稳。

### 4.4 数据层

`~/.codeartsdoer/cli-data/opencode.db` 里已有 `session`、`message`、`part`、`todo`、`cag_file_diff`、`preference`、`event` 等表。可以做只读查询来补：

- 跨工作区会话搜索/统计（避免每个目录都发一次请求）
- 离线用量统计（不依赖 CLI 输出解析）
- 事件补偿

但这是内核私有 schema，升级可能变；优先 HTTP/CLI，DB 只做兜底。

### 4.5 能力探测

不同环境/版本差异很大，建议启动时探一次并存成 `capabilities`：

| 探测 | 本机结果 |
| --- | --- |
| `GET /cag/mcp/list` | 403，HC 环境禁用 |
| `GET /cag/codebase/v1/lsp` | `{enabled:false}` |
| `GET /cag/codebase/health` | `isCodeBaseReady:false` |
| `GET /cag/context-audit/status` | `enabled:false` |
| `GET /find/symbol` | `[]`（LSP 关闭） |
| `GET /pty/shells` | 路由被 `/:ptyID` 抢先匹配，实际不可用；用 `GET /pty` 列表即可 |

按探测结果隐藏入口，比“点了才报错”体验好得多。

## 5. 推荐落地顺序

**迭代 1（1～2 天，纯前端为主）**
1. 回退/重做 + pre-revert 预览
2. 消息分叉
3. 会话搜索 + 总数
4. ~~`Cmd+P` 快速打开 + `Cmd+Shift+F` 全文搜索~~ 已完成（26.10.20，走内核 ripgrep）
5. ~~分支名显示（`/vcs`）~~ 已完成（26.10.20）

**迭代 2（3～5 天）**
6. 服务端斜杠命令 + `!` shell + 侧问
7. 手动压缩 + 单条消息删除
8. 导出/导入（CLI）
9. 后台命令面板（`/cag/shell`）

**迭代 3（1 周+）**
10. PTY 终端（WebSocket 桥 + xterm.js）
11. 技能 / Agent / 规则 / MCP / 模型管理
12. 用量统计（CLI stats）+ 上下文审计
13. 定时任务 / 代码库索引 / worktree

**架构专项（单独评估）**
14. ~~`/global/event` + 跨目录 `prompt_async`~~ 已完成（26.10.19）：切区不再重启内核，后台会话继续跑；待办只剩各工作区忙闲的侧栏徽标和各实例的内存开销基线。

## 附录 A：怎么复现这份清单

`/doc` 不可靠，直接从 CLI 二进制提取 operationId：

```bash
python3 - <<'PY'
import re
data = open('/Users/<user>/.codeartsdoer/installers/bin/codearts','rb').read().decode('utf-8','ignore')
ops = sorted(set(re.findall(r'operationId:"([^"]+)"', data)))
print(len(ops))
print('\n'.join(ops))
PY
```

本机运行中的内核可以直接探接口（端口/密码在 App 的 `secrets/endpoint`，只在本机使用）：

```bash
curl -s -u "codearts:$PASSWORD" -H "x-opencode-directory: $PWD" \
  http://127.0.0.1:$PORT/session | head -c 200
```

注意：`/doc` 只列了 36 条，且 `tags` 只有 Digital Avatar；不要用它判断功能是否存在。

## 附录 B：本次实测通过的端点

| 端点 | 结果 |
| --- | --- |
| `GET /session`、`/session/{id}/message`、`/todo`、`/diff`、`/children` | 200 JSON |
| `GET /find/file?query=README&type=file` | `["README.md"]` |
| `GET /find?pattern=createSession` | 带行号/offset/submatches 的匹配 |
| `GET /file/content?path=README.md` | `{type:"text",content:…}` |
| `GET /vcs` | `{branch:"main",default_branch:"main"}` |
| `GET /lsp`、`/formatter`、`/pty` | `[]` |
| `GET /experimental/tool/ids`、`/experimental/tool?provider=…&model=…` | 工具 ID 列表、完整工具 schema |
| `GET /cag/session`、`/cag/session/total`、`/cag/session/keywordsearch?search=` | 200 |
| `GET /cag/agent`、`/cag/agent-team/role` | 200（角色全文 157KB） |
| `GET /cag/rules`、`/cag/preference/status`、`/cag/experience/config` | 200 |
| `GET /cag/memory/status`（`?directory=` 必需） | 200 |
| `GET /cag/evolve/daemon/config`、`/cag/widget/config`、`/cag/model` | 200 |
| `GET /cag/codebase/health`、`/v1/lsp`、`/v1/local-tools/codegraph` | 200 |
| `GET /cag/context-audit/status`、`/aggregate`、`/events` | 200（当前 disabled） |
| `POST /cag/session/{id}/pre-revert`、`/revert`、`/unrevert` | 路由存在；缺 `messageID` 返回 400 |
| `POST /session/{id}/revert`、`/unrevert` | 200（空体会返回完整 session） |
| `POST /session/{id}/summarize`、`/command`、`/shell` | 路由存在；分别要求 `providerID`、`arguments`、`agent` |
| `POST /session/{id}/side-question` | SPA 兜底，HC 构建未挂载 |
| `POST /pty` → `GET /pty` → `DELETE /pty/{id}` | 创建/列出/删除均成功 |
| `GET /pty/{id}/connect` + WebSocket Upgrade | `101 Switching Protocols` |
| `GET /cag/shell` | `[]` |
| `GET /cag/mcp/list` | `403`，HC 环境禁用 |
| CLI `codearts stats --days 30` | 正常输出统计表 |
| CLI `codearts export <sessionID>` | 首行提示 + JSON |
