import { useEffect, useState } from "react";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  statsApi,
  codebaseApi,
  memoryApi,
  checkinApi,
  type StatsReport,
  type CodebaseStatus,
  type MemoryConfig,
  type MemoryFileItem,
  type CheckinConfig,
} from "../kernelApi";

export type StatsModalProps = {
  currentProject: string | null;
  activeSessionId?: string | null;
  kernelVersion?: string | null;
  onClose: () => void;
  onSessionImported?: () => void;
};

function sanitizeCookie(raw: string): string {
  let val = raw.trim();
  // 1. 支持用户直接复制粘贴 cURL 命令（如 curl ... -b '...' 或 --cookie '...'）
  const bMatch = val.match(/(?:-b|--cookie)\s+['"]([^'"]+)['"]/);
  if (bMatch) {
    val = bMatch[1];
  } else {
    // 2. 支持 -H 'cookie: ...' 或 -H "Cookie: ..."
    const hMatch = val.match(/-H\s+['"][Cc]ookie:\s*([^'"]+)['"]/i);
    if (hMatch) {
      val = hMatch[1];
    }
  }
  // 3. 过滤行首多余的 "Cookie:" 或 "cookie:" 前缀
  val = val.replace(/^cookie:\s*/i, "");
  // 4. 清理所有换行符与回车符，确保是符合 HTTP Header 规范的单行文本
  return val.replace(/[\r\n]+/g, " ").trim();
}

function cleanAnsi(text: string): string {
  if (!text) return "";
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b/g, "")
    .replace(/\r/g, "")
    .trim();
}

// 数据库持久化缓存 Key 前缀（与本地 stats_db.json 同步）
const STATS_DB_STORAGE_PREFIX = "codearts_stats_db_";

function getLocalDbReport(key: string): { report: StatsReport; timestamp: number } | null {
  try {
    const raw = localStorage.getItem(STATS_DB_STORAGE_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setLocalDbReport(key: string, report: StatsReport, timestamp: number) {
  try {
    localStorage.setItem(STATS_DB_STORAGE_PREFIX + key, JSON.stringify({ report, timestamp }));
  } catch {
    // 忽略 localStorage 容量限制异常
  }
}

let cachedLspStatus: boolean | null = null;
let cachedCodebaseStatus: CodebaseStatus | null = null;
let cachedMemoryConfig: MemoryConfig | null = null;

export function StatsModal({
  currentProject,
  activeSessionId,
  kernelVersion,
  onClose,
  onSessionImported,
}: StatsModalProps) {
  const [days, setDays] = useState<number | undefined>(undefined);
  const [filterProject, setFilterProject] = useState(false);

  const dbKey = `${days ?? "all"}:${filterProject && currentProject ? currentProject : "all"}`;
  const initialLocal = getLocalDbReport(dbKey);

  const [loading, setLoading] = useState(!initialLocal);
  const [report, setReport] = useState<StatsReport | null>(initialLocal ? initialLocal.report : null);
  const [cacheTime, setCacheTime] = useState<number | null>(initialLocal ? initialLocal.timestamp : null);
  const [fromDb, setFromDb] = useState<boolean>(Boolean(initialLocal));
  const [err, setErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"stats" | "codebase" | "memory" | "lsp" | "checkin" | "io">("stats");

  // Checkin
  const [checkinCfg, setCheckinCfg] = useState<CheckinConfig | null>(null);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [checkinMsg, setCheckinMsg] = useState<string | null>(null);
  const [checkinCookieInput, setCheckinCookieInput] = useState("");
  const [checkinChannel, setCheckinChannel] = useState("all");
  const [autoCheckinVal, setAutoCheckinVal] = useState(true);
  const [configEditing, setConfigEditing] = useState(false);
  const [fetchingCookie, setFetchingCookie] = useState(false);
  const [loginWinOpen, setLoginWinOpen] = useState(false);

  // 今日 CST 日期字符串 YYYY-MM-DD
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  // LSP
  const [lspEnabled, setLspEnabled] = useState<boolean | null>(cachedLspStatus);
  const [lspToggling, setLspToggling] = useState(false);
  const [lspMsg, setLspMsg] = useState<string | null>(null);

  // IO
  const [ioStatus, setIoStatus] = useState<string | null>(null);
  const [ioBusy, setIoBusy] = useState(false);

  // Codebase
  const [codebaseStatus, setCodebaseStatus] = useState<CodebaseStatus | null>(cachedCodebaseStatus);
  const [codebaseLoading, setCodebaseLoading] = useState(false);
  const [codebaseBusy, setCodebaseBusy] = useState(false);
  const [codebaseMsg, setCodebaseMsg] = useState<string | null>(null);

  // Memory
  const [memoryCfg, setMemoryCfg] = useState<MemoryConfig | null>(cachedMemoryConfig);
  const [memoryFiles, setMemoryFiles] = useState<MemoryFileItem[]>([]);
  const [selectedMemFile, setSelectedMemFile] = useState<string | null>(null);
  const [memContent, setMemContent] = useState<string>("");
  const [memLoading, setMemLoading] = useState(false);
  const [memSaving, setMemSaving] = useState(false);
  const [memMsg, setMemMsg] = useState<string | null>(null);

  useEffect(() => {
    // 优先从本地持久化缓存恢复，保证秒开
    const local = getLocalDbReport(dbKey);
    if (local) {
      setReport(local.report);
      setCacheTime(local.timestamp);
      setFromDb(true);
      setLoading(false);
    } else {
      // 本地无缓存时静默从后端 stats_db 读取
      loadData(false);
    }
    loadLsp();
    loadCodebase();
    loadMemory();
    loadCheckin();
  }, [days, filterProject, currentProject]);

  async function loadData(force = false) {
    setLoading(true);
    setErr(null);
    try {
      const proj = filterProject && currentProject ? currentProject : undefined;
      // force 为 false 时优先读取本地 stats_db.json，为 true 时强制重跑 CLI 并更新数据库
      const res = await statsApi.report(days, proj, force);
      const time = res.cached_at ?? Date.now();
      setReport(res);
      setCacheTime(time);
      setFromDb(Boolean(res.from_db));
      // 同步更新本地存储
      setLocalDbReport(dbKey, res, time);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadLsp() {
    try {
      const st = await statsApi.lspStatus();
      cachedLspStatus = st;
      setLspEnabled(st);
    } catch {
      setLspEnabled(null);
    }
  }

  async function toggleLsp() {
    if (lspEnabled === null || lspToggling) return;
    setLspToggling(true);
    setLspMsg(null);
    try {
      const next = !lspEnabled;
      const res = await statsApi.lspToggle(next);
      cachedLspStatus = res;
      setLspEnabled(res);
      setLspMsg(res ? "已成功开启 LSP 语言服务" : "已停用 LSP 语言服务");
    } catch (e) {
      setLspMsg(`切换失败：${e}`);
    } finally {
      setLspToggling(false);
    }
  }

  // ── Codebase 操作 ──
  async function loadCodebase() {
    setCodebaseLoading(true);
    try {
      const st = await codebaseApi.status(currentProject);
      cachedCodebaseStatus = st;
      setCodebaseStatus(st);
    } catch (e) {
      setCodebaseMsg(`获取代码库状态失败：${cleanAnsi(String(e))}`);
    } finally {
      setCodebaseLoading(false);
    }
  }

  async function handleCodebaseAction(action: "init" | "update" | "delete") {
    if (codebaseBusy) return;
    setCodebaseBusy(true);
    setCodebaseMsg(null);
    try {
      const res = await codebaseApi.action(action, currentProject);
      setCodebaseMsg(cleanAnsi(res) || "操作已完成");
      await loadCodebase();
    } catch (e) {
      setCodebaseMsg(`执行失败：${cleanAnsi(String(e))}`);
    } finally {
      setCodebaseBusy(false);
    }
  }

  // ── Memory 操作 ──
  async function loadMemory() {
    setMemLoading(true);
    setMemMsg(null);
    try {
      const [cfg, files] = await Promise.all([
        memoryApi.status(),
        memoryApi.listFiles(currentProject),
      ]);
      cachedMemoryConfig = cfg;
      setMemoryCfg(cfg);
      setMemoryFiles(files);
      if (files.length > 0) {
        const defaultFile = files.find((f) => f.name === "MEMORY.md")?.name ?? files[0].name;
        setSelectedMemFile(defaultFile);
        const text = await memoryApi.readFile(defaultFile, currentProject);
        setMemContent(text);
      } else {
        setSelectedMemFile(null);
        setMemContent("");
      }
    } catch (e) {
      setMemMsg(`读取记忆失败：${e}`);
    } finally {
      setMemLoading(false);
    }
  }

  async function handleToggleMemory() {
    if (!memoryCfg) return;
    const next = !memoryCfg.status;
    try {
      await memoryApi.toggle(next);
      setMemoryCfg({ ...memoryCfg, status: next });
      setMemMsg(next ? "长效记忆已启用" : "长效记忆已停用");
    } catch (e) {
      setMemMsg(`切换记忆状态失败：${e}`);
    }
  }

  async function handlePickMemFile(name: string) {
    setSelectedMemFile(name);
    setMemMsg(null);
    try {
      const text = await memoryApi.readFile(name, currentProject);
      setMemContent(text);
    } catch (e) {
      setMemMsg(`无法读取文件：${e}`);
    }
  }

  async function handleSaveMemFile() {
    if (!selectedMemFile || memSaving) return;
    setMemSaving(true);
    setMemMsg(null);
    try {
      await memoryApi.saveFile(selectedMemFile, memContent, currentProject);
      setMemMsg(`已成功保存 ${selectedMemFile}`);
      const files = await memoryApi.listFiles(currentProject);
      setMemoryFiles(files);
    } catch (e) {
      setMemMsg(`保存失败：${e}`);
    } finally {
      setMemSaving(false);
    }
  }

  async function handleCreateDefaultMemory() {
    const defaultTemplate = `# MEMORY.md\n\n## 项目环境与规约\n\n- 在此记录当前代码库的关键设计架构、环境变量要求与常用验证命令。\n- CodeArts 内核在后续多轮会话中将自动参考此文件的知识沉淀。\n`;
    try {
      await memoryApi.saveFile("MEMORY.md", defaultTemplate, currentProject);
      await loadMemory();
      setMemMsg("已成功初始化 MEMORY.md");
    } catch (e) {
      setMemMsg(`初始化失败：${e}`);
    }
  }

  // ── Checkin 签到 ──
  async function loadCheckin() {
    try {
      const cfg = await checkinApi.getConfig();
      setCheckinCfg(cfg);
      setCheckinCookieInput(cfg.cookie || "");
      setCheckinChannel(cfg.channel || "all");
      setAutoCheckinVal(cfg.auto_checkin);
    } catch (e) {
      console.warn("读取签到配置失败:", e);
    }
  }

  async function handleExecuteCheckin() {
    if (checkinBusy) return;
    setCheckinBusy(true);
    setCheckinMsg(null);
    try {
      const res = await checkinApi.executeNow(checkinChannel);
      setCheckinMsg(res.message);
      await loadCheckin();
    } catch (e) {
      setCheckinMsg(`签到失败：${cleanAnsi(String(e))}`);
    } finally {
      setCheckinBusy(false);
    }
  }

  async function handleOpenLoginWindow(url?: string) {
    try {
      setCheckinMsg("正在打开华为云内置窗口，请在弹出的窗口中登录账号或进行日常打卡...");
      await checkinApi.openLoginWindow(url);
      setLoginWinOpen(true);
    } catch (e) {
      setCheckinMsg(`打开窗口失败：${cleanAnsi(String(e))}`);
    }
  }

  async function handleFetchWebviewCookie() {
    if (fetchingCookie) return;
    setFetchingCookie(true);
    setCheckinMsg("正在从登录窗口安全读取 Cookie 凭据...");
    try {
      const cookie = await checkinApi.fetchWebviewCookies();
      setCheckinCookieInput(cookie);
      if (checkinCfg) {
        setCheckinCfg({ ...checkinCfg, cookie });
      }
      setLoginWinOpen(false);
      setCheckinMsg("🎉 凭据与会话同步成功！正在为您立即执行签到测试...");
      // 延迟 500ms 自动打卡
      setTimeout(() => {
        void handleExecuteCheckin();
      }, 500);
    } catch (e) {
      setCheckinMsg(`抓取凭证失败：${cleanAnsi(String(e))}`);
    } finally {
      setFetchingCookie(false);
    }
  }

  async function handleClearFailedHistory() {
    if (!checkinCfg) return;
    const cleanHistory = checkinCfg.history.filter((h) => h.success);
    const updated = { ...checkinCfg, history: cleanHistory };
    try {
      await checkinApi.saveConfig(updated);
      setCheckinCfg(updated);
      setCheckinMsg("已成功清除所有失败与异常的流水记录");
    } catch (e) {
      setCheckinMsg(`清除失败：${e}`);
    }
  }

  async function handleSaveCheckinConfig() {
    if (!checkinCfg) return;
    try {
      const cleanCookie = sanitizeCookie(checkinCookieInput);
      const updated: CheckinConfig = {
        ...checkinCfg,
        cookie: cleanCookie,
        channel: checkinChannel,
        auto_checkin: autoCheckinVal,
      };
      await checkinApi.saveConfig(updated);
      setCheckinCookieInput(cleanCookie);
      setCheckinCfg(updated);
      setConfigEditing(false);
      setCheckinMsg("签到凭证与自动打卡配置已保存成功！");
    } catch (e) {
      setCheckinMsg(`保存配置失败：${cleanAnsi(String(e))}`);
    }
  }

  // ── 原生导出导入 ──
  async function handleExportNative() {
    if (!activeSessionId || ioBusy) return;
    setIoBusy(true);
    setIoStatus(null);
    try {
      const p = await saveDialog({
        title: "导出原生内核会话 (JSON)",
        defaultPath: `session-${activeSessionId.slice(0, 8)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!p) {
        setIoBusy(false);
        return;
      }
      await statsApi.exportNative(activeSessionId, p);
      setIoStatus(`会话已成功导出到：${p}`);
    } catch (e) {
      setIoStatus(`导出失败：${e}`);
    } finally {
      setIoBusy(false);
    }
  }

  async function handleImportNative() {
    if (ioBusy) return;
    setIoBusy(true);
    setIoStatus(null);
    try {
      const p = await open({
        title: "导入原生内核会话文件",
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!p || typeof p !== "string") {
        setIoBusy(false);
        return;
      }
      const res = await statsApi.importNative(p);
      setIoStatus(`导入成功：${res || "会话已就绪"}`);
      onSessionImported?.();
    } catch (e) {
      setIoStatus(`导入失败：${e}`);
    } finally {
      setIoBusy(false);
    }
  }

  return (
    <div className="stats-modal-backdrop" onClick={onClose}>
      <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
        {/* 顶部标题栏 */}
        <div className="stats-header">
          <div className="stats-title-group">
            <h3>用量统计与工程度量</h3>
            <span className="stats-badge">
              CLI {kernelVersion ? `v${kernelVersion}` : "官方"} 内核能力
            </span>
          </div>

          <button className="ico-btn" onClick={onClose} title="关闭" aria-label="关闭">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* 独立二级导航栏：避免在小屏下与标题争抢空间挤成两行 */}
        <div className="stats-nav-bar">
          <div className="stats-tabs">
            <button
              className={`stats-tab ${activeTab === "stats" ? "active" : ""}`}
              onClick={() => setActiveTab("stats")}
            >
              📊 概览与看板
            </button>
            <button
              className={`stats-tab ${activeTab === "codebase" ? "active" : ""}`}
              onClick={() => setActiveTab("codebase")}
            >
              ⚡ 代码库索引
            </button>
            <button
              className={`stats-tab ${activeTab === "memory" ? "active" : ""}`}
              onClick={() => setActiveTab("memory")}
            >
              🧠 项目记忆
            </button>
            <button
              className={`stats-tab ${activeTab === "lsp" ? "active" : ""}`}
              onClick={() => setActiveTab("lsp")}
            >
              🛠️ LSP 语言服务
            </button>
            <button
              className={`stats-tab ${activeTab === "checkin" ? "active" : ""}`}
              onClick={() => setActiveTab("checkin")}
            >
              🎁 每日签到
            </button>
            <button
              className={`stats-tab ${activeTab === "io" ? "active" : ""}`}
              onClick={() => setActiveTab("io")}
            >
              📦 原生导入导出
            </button>
          </div>
        </div>

        {activeTab === "stats" && (
          <div className="stats-filter-bar">
            <div className="filter-group">
              <span className="filter-label">时间范围：</span>
              <button
                className={`filter-chip ${days === undefined ? "active" : ""}`}
                onClick={() => setDays(undefined)}
              >
                全部
              </button>
              <button
                className={`filter-chip ${days === 30 ? "active" : ""}`}
                onClick={() => setDays(30)}
              >
                近 30 天
              </button>
              <button
                className={`filter-chip ${days === 7 ? "active" : ""}`}
                onClick={() => setDays(7)}
              >
                近 7 天
              </button>
            </div>

            <div className="filter-group">
              <span className="filter-label">作用域：</span>
              <button
                className={`filter-chip ${!filterProject ? "active" : ""}`}
                onClick={() => setFilterProject(false)}
              >
                全部项目
              </button>
              <button
                className={`filter-chip ${filterProject ? "active" : ""}`}
                onClick={() => setFilterProject(true)}
                disabled={!currentProject}
                title={currentProject ?? "暂无活动工作区"}
              >
                当前工作区
              </button>
            </div>

            <div className="stats-reload-wrap">
              {cacheTime && !loading && (
                <span className="stats-cache-hint">
                  {fromDb ? "💾 本地数据库 " : "⚡ 最新聚合 "}
                  {Math.round((Date.now() - cacheTime) / 1000) < 60
                    ? "(刚刚更新)"
                    : `(${Math.round((Date.now() - cacheTime) / 60000)}分钟前)`}
                </span>
              )}
              <button
                className="stats-reload-btn"
                onClick={() => void loadData(true)}
                disabled={loading}
              >
                {loading ? "全量拉取中…" : "🔄 刷新数据"}
              </button>
            </div>
          </div>
        )}

        <div className="stats-body">
          {err && <div className="stats-error">获取数据失败：{err}</div>}

          {activeTab === "stats" ? (
            loading && !report ? (
              <div className="stats-loading">正在拉取内核度量数据…</div>
            ) : report ? (
              <div className="stats-content">
                {/* 四格总览 */}
                <div className="stats-grid-4">
                  <div className="stat-card">
                    <div className="stat-card-title">累计会话</div>
                    <div className="stat-card-val highlight">
                      {report.overview.sessions.toLocaleString()}
                    </div>
                    <div className="stat-card-sub">独立 Session 账单</div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-card-title">消息总数</div>
                    <div className="stat-card-val">
                      {report.overview.messages.toLocaleString()}
                    </div>
                    <div className="stat-card-sub">回合对话总轮次</div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-card-title">活跃天数</div>
                    <div className="stat-card-val">{report.overview.days} 天</div>
                    <div className="stat-card-sub">累计使用跨度</div>
                  </div>

                  <div className="stat-card">
                    <div className="stat-card-title">总消费开销</div>
                    <div className="stat-card-val accent">
                      {report.cost_tokens.total_cost || "$0.00"}
                    </div>
                    <div className="stat-card-sub">日均 {report.cost_tokens.avg_cost_per_day}</div>
                  </div>
                </div>

                {/* Token 消耗与缓存效率 */}
                <div className="stats-section-box">
                  <div className="section-head">
                    <h4>Token 消耗与缓存命中率</h4>
                    <span className="section-sub">
                      平均会话 {report.cost_tokens.avg_tokens_per_session} · 中位数{" "}
                      {report.cost_tokens.median_tokens_per_session}
                    </span>
                  </div>

                  <div className="token-metrics">
                    <div className="token-item">
                      <span className="token-dot input" />
                      <span className="token-lbl">输入 Tokens:</span>
                      <b>{report.cost_tokens.input_tokens}</b>
                    </div>
                    <div className="token-item">
                      <span className="token-dot output" />
                      <span className="token-lbl">输出 Tokens:</span>
                      <b>{report.cost_tokens.output_tokens}</b>
                    </div>
                    <div className="token-item">
                      <span className="token-dot cache" />
                      <span className="token-lbl">Prompt 缓存命中 (Cache Read):</span>
                      <b className="green">{report.cost_tokens.cache_read}</b>
                    </div>
                  </div>
                </div>

                {/* 工具调用分布与频率 */}
                <div className="stats-section-box">
                  <div className="section-head">
                    <h4>工具调用频次与占比</h4>
                    <span className="section-sub">
                      统计当前范围内所有工具实际执行轮次
                    </span>
                  </div>

                  <div className="tool-bars">
                    {report.tool_usage.map((t) => (
                      <div className="tool-row" key={t.tool}>
                        <div className="tool-info">
                          <span className="tool-name">{t.tool}</span>
                          <span className="tool-stat">
                            {t.count} 次 ({t.percent}%)
                          </span>
                        </div>
                        <div className="tool-track">
                          <div
                            className={`tool-fill ${
                              t.tool === "bash"
                                ? "fill-bash"
                                : t.tool === "read"
                                ? "fill-read"
                                : t.tool === "edit"
                                ? "fill-edit"
                                : "fill-other"
                            }`}
                            style={{ width: `${Math.min(100, t.percent)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模型明细表格 */}
                {report.model_usage.length > 0 && (
                  <div className="stats-section-box">
                    <div className="section-head">
                      <h4>模型使用分布明细</h4>
                    </div>
                    <div className="model-table-box">
                      <table className="model-table">
                        <thead>
                          <tr>
                            <th>提供商 / 模型</th>
                            <th>消息数</th>
                            <th>输入 Token</th>
                            <th>输出 Token</th>
                            <th>缓存读取</th>
                            <th>预估费用</th>
                          </tr>
                        </thead>
                        <tbody>
                          {report.model_usage.map((m) => (
                            <tr key={m.model}>
                              <td className="model-name-cell">{m.model}</td>
                              <td>{m.messages.toLocaleString()}</td>
                              <td>{m.input_tokens}</td>
                              <td>{m.output_tokens}</td>
                              <td className="green">{m.cache_read}</td>
                              <td>{m.cost}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ) : null
          ) : activeTab === "codebase" ? (
            <div className="codebase-container">
              <div className="codebase-card">
                <div className="codebase-head">
                  <div>
                    <span className={`section-tag ${codebaseStatus?.indexed ? "indexed" : ""}`}>
                      {codebaseStatus?.indexed ? "● 索引已建立 (Indexed)" : "○ 尚未建立索引 (No Index)"}
                    </span>
                    <h3>代码库索引 (CodeBase Indexing)</h3>
                    <p className="codebase-project-hint">
                      工作区路径：<code>{currentProject ?? "未选择工作区"}</code>
                    </p>
                  </div>
                  <button
                    className="sec-btn"
                    onClick={loadCodebase}
                    disabled={codebaseLoading}
                  >
                    {codebaseLoading ? "探测中…" : "刷新状态"}
                  </button>
                </div>

                <p className="codebase-desc">
                  CodeArts CLI 26.11.11 内置 Merkle 增量快照与 AST 分块代码索引技术。
                  创建索引后，模型在回答复杂大仓工程时，可直接通过 <code>CodeSemanticSearch</code> 语义检索跨文件代码定义与符号引用，回答更精准，避免通篇盲读。
                </p>

                {codebaseMsg && <div className="io-msg">{codebaseMsg}</div>}

                <div className="codebase-detail-box">
                  <div className="detail-title">内核详细报告：</div>
                  <pre className="codebase-raw">
                    {codebaseStatus?.raw || "暂无索引详情"}
                  </pre>
                </div>

                <div className="codebase-actions">
                  <button
                    className="primary-btn"
                    onClick={() => handleCodebaseAction("init")}
                    disabled={codebaseBusy}
                  >
                    {codebaseBusy ? "处理中…" : "⚡ 初始化全量索引 (--init)"}
                  </button>
                  <button
                    className="sec-btn"
                    onClick={() => handleCodebaseAction("update")}
                    disabled={codebaseBusy}
                  >
                    🔄 增量更新索引 (--update)
                  </button>
                  <button
                    className="sec-btn btn-danger"
                    onClick={() => handleCodebaseAction("delete")}
                    disabled={codebaseBusy || !codebaseStatus?.indexed}
                  >
                    🗑️ 删除索引 (--delete)
                  </button>
                </div>
              </div>
            </div>
          ) : activeTab === "memory" ? (
            <div className="memory-container">
              <div className="memory-top-bar">
                <div className="memory-status-info">
                  <span className={`lsp-tag ${memoryCfg?.status ? "on" : "off"}`}>
                    {memoryCfg?.status ? "● 记忆沉淀系统已启用" : "○ 记忆已停用"}
                  </span>
                  <span className="memory-dream-hint">
                    {memoryCfg?.enable_dream ? "后台梦境蒸馏 (Dreaming): 开启" : ""}
                  </span>
                </div>
                <button
                  className={`sec-btn ${memoryCfg?.status ? "" : "btn-primary-alt"}`}
                  onClick={handleToggleMemory}
                >
                  {memoryCfg?.status ? "停用记忆系统" : "启用记忆系统"}
                </button>
              </div>

              {memMsg && <div className="io-msg">{memMsg}</div>}

              <div className="memory-workspace-view">
                <div className="memory-files-side">
                  <div className="files-side-head">
                    <span>工作区记忆文件</span>
                    <button
                      className="text-btn"
                      onClick={loadMemory}
                      disabled={memLoading}
                    >
                      刷新
                    </button>
                  </div>
                  {memoryFiles.length === 0 ? (
                    <div className="no-mem-files">
                      <p>当前项目尚未沉淀记忆规则</p>
                      <button
                        className="sec-btn small"
                        onClick={handleCreateDefaultMemory}
                      >
                        ＋ 初始化 MEMORY.md
                      </button>
                    </div>
                  ) : (
                    <ul className="mem-file-list">
                      {memoryFiles.map((f) => (
                        <li
                          key={f.name}
                          className={`mem-file-item ${
                            selectedMemFile === f.name ? "active" : ""
                          }`}
                          onClick={() => handlePickMemFile(f.name)}
                        >
                          <span className="file-name">{f.name}</span>
                          <span className="file-meta">
                            {(f.size / 1024).toFixed(1)} KB
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="memory-editor-main">
                  {selectedMemFile ? (
                    <>
                      <div className="editor-head">
                        <span className="editor-file-title">
                          📝 {selectedMemFile}
                        </span>
                        <button
                          className="primary-btn small"
                          onClick={handleSaveMemFile}
                          disabled={memSaving}
                        >
                          {memSaving ? "保存中…" : "保存修改"}
                        </button>
                      </div>
                      <textarea
                        className="memory-textarea"
                        value={memContent}
                        onChange={(e) => setMemContent(e.target.value)}
                        placeholder="输入记忆 Markdown 内容…"
                      />
                    </>
                  ) : (
                    <div className="editor-empty">
                      请在左侧选择要查看或编辑的记忆知识文件
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : activeTab === "lsp" ? (
            <div className="lsp-container">
              <div className="lsp-card">
                <div className="lsp-badge-status">
                  {lspEnabled === true ? (
                    <span className="lsp-tag on">● 语言服务已启用 (Active)</span>
                  ) : lspEnabled === false ? (
                    <span className="lsp-tag off">○ 语言服务已停用 (Disabled)</span>
                  ) : (
                    <span className="lsp-tag">探测中…</span>
                  )}
                </div>

                <h3>LSP (Language Server Protocol) 智能代码服务</h3>
                <p className="lsp-desc">
                  CodeArts CLI {kernelVersion ? `v${kernelVersion}` : "官方"} 内置针对工程的语言服务器引擎（基于 VS Code
                  扩展生态与语言协议）。开启后，模型在代码补全、函数引用查找、类型跳转、编译诊断时能获得第一手语法 AST 与跨文件符号支持，大幅降低复杂大仓重构时的幻觉率。
                </p>

                {lspMsg && <div className="lsp-msg">{lspMsg}</div>}

                <div className="lsp-actions">
                  <button
                    className={`primary-btn ${lspEnabled ? "btn-danger" : ""}`}
                    onClick={toggleLsp}
                    disabled={lspToggling || lspEnabled === null}
                  >
                    {lspToggling
                      ? "正在切换…"
                      : lspEnabled
                      ? "停用 LSP 服务"
                      : "立即开启 LSP 服务"}
                  </button>
                  <button className="sec-btn" onClick={loadLsp}>
                    刷新状态
                  </button>
                </div>
              </div>
            </div>
          ) : activeTab === "checkin" ? (
            <div className="checkin-container">
              {/* 今日打卡总览卡片 */}
              <div className="checkin-status-grid">
                <div className="stat-card">
                  <div className="stat-card-title">今日打卡状态</div>
                  <div className="stat-card-val highlight">
                    {checkinCfg?.last_checkin_date === todayStr ? "🟢 今日已签到" : "⚪ 今日未签到"}
                  </div>
                  <div className="stat-card-sub">
                    {checkinCfg?.last_checkin_date === todayStr
                      ? checkinCfg?.last_checkin_message ?? "算力积分已到账"
                      : "点击下方按钮立即领取每日福利"}
                  </div>
                </div>

                <div className="stat-card">
                  <div className="stat-card-title">连续签到</div>
                  <div className="stat-card-val accent">
                    {checkinCfg?.streak_days ?? 0} 天
                  </div>
                  <div className="stat-card-sub">保持连续打卡享更多权益</div>
                </div>

                <div className="stat-card">
                  <div className="stat-card-title">累计领取福利积分</div>
                  <div className="stat-card-val highlight">
                    {checkinCfg?.total_points ?? 0}
                  </div>
                  <div className="stat-card-sub">CodeArts 算力与社区积分</div>
                </div>

                <div className="stat-card">
                  <div className="stat-card-title">每日自动签到</div>
                  <div className="stat-card-val">
                    {checkinCfg?.auto_checkin ? "⚡ 已开启" : "○ 已停用"}
                  </div>
                  <div className="stat-card-sub">客户端启动时自动打卡</div>
                </div>
              </div>

              {/* 签到操作主卡片 */}
              <div className="checkin-card">
                <div className="checkin-head">
                  <div>
                    <h3>华为云 CodeArts 每日福利与积分签到</h3>
                    <p className="checkin-desc">
                      直连华为云码道（CodeArts AICoding / Snap）算力福利中心与开发者成长中心。
                      每天一键签到，免费获取官方赠送的 <b>100 ~ 200 算力积分</b>，直接抵扣大模型编码用量！
                    </p>
                  </div>
                  <div className="checkin-head-actions">
                    <button
                      className="primary-btn"
                      onClick={handleExecuteCheckin}
                      disabled={checkinBusy || !checkinCfg?.cookie?.trim()}
                    >
                      {checkinBusy ? "正在请求官方接口…" : "✨ 立即签到领积分"}
                    </button>
                    <button
                      className="sec-btn"
                      onClick={() => setConfigEditing(!configEditing)}
                    >
                      ⚙️ {configEditing ? "收起凭据设置" : "配置登录凭证 (Cookie)"}
                    </button>
                  </div>
                </div>

                {checkinMsg && <div className="io-msg">{checkinMsg}</div>}

                {!checkinCfg?.cookie?.trim() && !configEditing && (
                  <div className="checkin-welcome-banner">
                    <span className="banner-icon">✨</span>
                    <div className="banner-text">
                      <b>推荐快速打卡：</b>无需繁琐查找 Cookie！点击 <b>「🌐 打开内置窗口登录」</b> 在华为云官方页面登录账号，随后点击 <b>「📥 自动抓取」</b> 即可全自动完成凭证绑定与每日打卡！
                    </div>
                    <div className="banner-actions">
                      <button
                        type="button"
                        className="primary-btn small"
                        onClick={() => void handleOpenLoginWindow()}
                      >
                        🌐 1. 打开登录窗口
                      </button>
                      <button
                        type="button"
                        className="sec-btn small"
                        onClick={handleFetchWebviewCookie}
                        disabled={fetchingCookie}
                      >
                        {fetchingCookie ? "⏳ 抓取中…" : "📥 2. 自动抓取并签到"}
                      </button>
                    </div>
                  </div>
                )}

                {/* 凭据设置展开面板 */}
                {configEditing && (
                  <div className="checkin-config-panel">
                    <div className="config-panel-head">
                      <h4>⚙️ 凭证与自动打卡配置</h4>
                      <span className="config-panel-hint">凭据仅安全保存在本地 (~/.codeartsdoer)，不向任何第三方上报</span>
                    </div>

                    {/* 内置窗口一键登录自动抓取 */}
                    <div className="webview-login-card">
                      <div className="login-card-badge">✨ 官方开发者成长中心一键登录</div>
                      <h4 className="login-card-title">在软件内置浏览器窗口直接登录与打卡</h4>
                      <p className="login-card-desc">
                        点击下方按钮将直接在客户端内弹出原生窗口，登录后您既可直接在页面中参与打卡，也可一键同步凭证到本地实现开机自动打卡！
                      </p>

                      <div className="login-steps-row">
                        <div className="login-step-card">
                          <div className="step-circle">1</div>
                          <div className="step-content">
                            <div className="step-name">弹出官方开发者成长中心</div>
                            <div className="step-intro">直达成长中心，登录后即可一键同步与每日打卡</div>
                            <button
                              type="button"
                              className="sec-btn small step-btn"
                              onClick={() => void handleOpenLoginWindow("https://grow.developer.huaweicloud.com/")}
                            >
                              🎁 打开开发者成长中心
                            </button>
                          </div>
                        </div>

                        <div className="login-step-arrow">➔</div>

                        <div className="login-step-card">
                          <div className="step-circle">2</div>
                          <div className="step-content">
                            <div className="step-name">完成登录后一键同步</div>
                            <div className="step-intro">登录成功后点击，自动绑定凭据并开启开机自动打卡</div>
                            <button
                              type="button"
                              className={loginWinOpen ? "primary-btn small step-btn pulse" : "sec-btn small step-btn"}
                              onClick={handleFetchWebviewCookie}
                              disabled={fetchingCookie}
                            >
                              {fetchingCookie ? "⏳ 正在提取凭据…" : "📥 我已登录，自动抓取凭据"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="config-grid-2">
                      <div className="config-field">
                        <label className="config-lbl">打卡通道选择：</label>
                        <select
                          className="checkin-select-custom"
                          value={checkinChannel}
                          onChange={(e) => setCheckinChannel(e.target.value)}
                        >
                          <option value="all">双通道联动（CodeArts 算力福利 + 成长中心）</option>
                          <option value="growth">华为云开发者成长中心签到通道 (社区积分，推荐)</option>
                          <option value="codearts">CodeArts 码道 AI 算力福利通道</option>
                        </select>
                      </div>

                      <div className="config-field">
                        <label className="config-lbl">后台静默打卡：</label>
                        <div
                          className="config-switch-row"
                          onClick={() => setAutoCheckinVal(!autoCheckinVal)}
                        >
                          <div className={`modern-switch ${autoCheckinVal ? "active" : ""}`}>
                            <div className="switch-thumb" />
                          </div>
                          <div className="switch-label-group">
                            <span className="switch-title">启动自动打卡</span>
                            <span className="switch-desc">（开机首次打开时自动在后台打卡）</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="config-footer-actions">
                      <button
                        className="sec-btn small"
                        type="button"
                        onClick={() => setConfigEditing(false)}
                      >
                        收起设置
                      </button>
                      <button
                        className="primary-btn small"
                        type="button"
                        onClick={handleSaveCheckinConfig}
                      >
                        💾 保存凭证与打卡配置
                      </button>
                    </div>
                  </div>
                )}

                {/* 签到流水历史 */}
                <div className="checkin-history-box">
                  <div className="history-head">
                    <h4>近期签到流水明细</h4>
                    <div className="history-head-right" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span className="history-count">
                        共 {checkinCfg?.history?.length ?? 0} 条记录
                      </span>
                      {checkinCfg?.history?.some((h) => !h.success) && (
                        <button
                          type="button"
                          className="text-btn small"
                          onClick={() => void handleClearFailedHistory()}
                          title="清理失败/异常流水记录"
                        >
                          🗑️ 清除异常记录
                        </button>
                      )}
                    </div>
                  </div>

                  {(!checkinCfg?.history || checkinCfg.history.length === 0) ? (
                    <div className="no-history-hint">
                      暂无签到记录。录入 Cookie 凭证后点击上方“立即签到”或开启每天自动打卡！
                    </div>
                  ) : (
                    <div className="history-table-wrap">
                      <table className="model-table">
                        <thead>
                          <tr>
                            <th>打卡日期</th>
                            <th>时间</th>
                            <th>通道</th>
                            <th>状态</th>
                            <th>奖励</th>
                            <th>官方响应反馈</th>
                          </tr>
                        </thead>
                        <tbody>
                          {checkinCfg.history.map((h, idx) => (
                            <tr key={`${h.date}-${h.time}-${idx}`}>
                              <td>{h.date}</td>
                              <td>{h.time}</td>
                              <td>
                                {h.channel === "codearts"
                                  ? "CodeArts 算力"
                                  : h.channel === "growth"
                                  ? "成长中心"
                                  : "双通道联动"}
                              </td>
                              <td>
                                <span className={`status-pill ${h.success ? "success" : "fail"}`}>
                                  {h.success ? "成功" : "异常"}
                                </span>
                              </td>
                              <td className="green">
                                {h.points ? `+${h.points} 积分` : "-"}
                              </td>
                              <td className="msg-cell">{h.message}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : activeTab === "io" ? (
            <div className="io-container">
              <div className="io-card">
                <h3>原生会话导入与导出</h3>
                <p className="io-desc">
                  借助官方内核 <code>codearts export</code> 与 <code>codearts import</code>，
                  您可以将本桌面端上的完整会话树（包括工具调用链路、待办状态、Diff
                  锚点）无损打包为原生 JSON 格式，或导入外部终端 TUI 导出的会话继续协作。
                </p>

                {ioStatus && <div className="io-msg">{ioStatus}</div>}

                <div className="io-grid">
                  <div className="io-box">
                    <h4>📤 导出当前会话</h4>
                    <p>将当前正在浏览的会话完整导出为内核标准 JSON 数据包。</p>
                    <button
                      className="primary-btn"
                      onClick={handleExportNative}
                      disabled={!activeSessionId || ioBusy}
                    >
                      {activeSessionId ? "导出当前会话为 JSON" : "请先进入某个会话"}
                    </button>
                  </div>

                  <div className="io-box">
                    <h4>📥 导入会话文件</h4>
                    <p>选择外部 <code>session-*.json</code> 文件，将其导入到本机内核列表中。</p>
                    <button
                      className="primary-btn"
                      onClick={handleImportNative}
                      disabled={ioBusy}
                    >
                      从本地 JSON 文件导入
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
