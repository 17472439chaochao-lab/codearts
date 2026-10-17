import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import Chat from "./Chat";
import { mcp, skills, type EnvCheck, type SkillInfo, type V1Skill } from "./kernelApi";
import "./App.css";

export type KernelStatus = {
  running: boolean;
  healthy: boolean;
  port: number | null;
  projectDir: string | null;
  version: string | null;
  detail: string | null;
};

/** 系统标题栏已经沉浸掉了，标题由壳自己画在左上角 */
export const APP_TITLE = "CodeArts Desktop";

/** 标题栏和关于页都要版本号，进程内取一次缓存住 */
let appVersion: Promise<string | null> | null = null;

export function useAppVersion(): string | null {
  const [ver, setVer] = useState<string | null>(null);
  useEffect(() => {
    (appVersion ??= getVersion().catch(() => null)).then(setVer);
  }, []);
  return ver;
}

type Runner = <T>(fn: () => Promise<T>) => Promise<T | null>;

/** 官方安装命令照抄文档，别自己编；复制按钮只给这一句 */
const KERNEL_INSTALL_CMD =
  'sh -c "$(curl -L https://cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com/codearts/cli_tui/install_script/install.sh)"';
/** 装完还要把 installers 目录放进 PATH，这句留在说明里，不混进复制的命令 */
const KERNEL_PATH_CMD = "export PATH=~/.codeartsdoer/installers:$PATH";
const KERNEL_REL_PATH = ".codeartsdoer/installers/bin/codearts";

export default function App() {
  const [check, setCheck] = useState<EnvCheck | null>(null);
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // 换目录要重启内核，几秒内界面不能操作；留个进度卡告诉用户在干什么
  const [switching, setSwitching] = useState<{ dir: string; stage: string } | null>(null);
  // 检测页每次启动都要看一眼，全绿了才由用户点"进入"；不持久化，重启回到这里
  const [entered, setEntered] = useState(false);

  const refresh = useCallback(
    () =>
      invoke<EnvCheck>("env_check")
        .then(setCheck)
        .catch((e) => setError(String(e))),
    [],
  );

  useEffect(() => {
    refresh();
    invoke<KernelStatus>("kernel_status").then(setStatus).catch(() => {});
    const s = listen<KernelStatus>("kernel-status", (e) => setStatus(e.payload));
    return () => {
      s.then((f) => f());
    };
  }, [refresh]);

  const run: Runner = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(() => invoke<KernelStatus>("kernel_start")).then((s) => {
      if (s) setStatus(s);
    });
  const stop = () =>
    run(() => invoke<KernelStatus>("kernel_stop")).then((s) => {
      if (s) setStatus(s);
    });

  /** serve 的 cwd 与目录信任白名单都在启动时定死，换工作区必须重启内核 */
  const applyDir = (dir: string, list: string[]) => {
    const restart = !!status?.running;
    setSwitching({ dir, stage: restart ? "正在重启内核…" : "正在保存工作区…" });
    void run(async () => {
      await invoke("settings_save", { next: { projectDir: dir, projects: list } });
      // 先把内核换到新端口，再把新目录交给界面：反过来的话新目录会对着
      // 正在停止的旧内核发 /provider，连接失败会弹一条没意义的红字
      try {
        if (restart) {
          setStatus(await invoke<KernelStatus>("kernel_start"));
          setSwitching({ dir, stage: "正在刷新工作区…" });
        }
      } finally {
        await refresh();
      }
    }).finally(() => setSwitching(null));
  };

  const switchDir = (dir: string) =>
    applyDir(
      dir,
      [dir, ...(check?.projects ?? []).filter((x) => x !== dir)],
    );

  const addDir = async () => {
    const dir = await open({ directory: true, defaultPath: check?.projectDir ?? undefined });
    if (typeof dir === "string") switchDir(dir);
  };

  const dropDir = (dir: string) => {
    const rest = (check?.projects ?? []).filter((x) => x !== dir);
    if (dir !== check?.projectDir) {
      void run(async () => {
        await invoke("settings_save", { next: { projects: rest } });
        await refresh();
      });
      return;
    }
    if (rest.length) {
      applyDir(rest[0], rest);
      return;
    }
    void run(async () => {
      await invoke("settings_save", { next: { projects: [], projectDir: "" } });
      await refresh();
    });
  };

  const ready = !!(
    check?.kernelInstalled &&
    check?.hasCredentials &&
    check?.projectDir
  );

  // 中途掉出就绪态（比如最后一个工作区被移除）就退回检测页，修好后必须重新点进入
  useEffect(() => {
    if (!ready) setEntered(false);
  }, [ready]);

  return (
    <div className="shell">
      {ready && entered ? (
        <Chat
          projectDir={check!.projectDir!}
          projects={check!.projects}
          status={status}
          busy={busy}
          onStart={start}
          onStop={stop}
          onAddDir={addDir}
          onSwitchDir={switchDir}
          onDropDir={dropDir}
          onOpenSettings={() => setShowSettings(true)}
        />
      ) : (
        <Setup
          check={check}
          busy={busy}
          run={run}
          onDone={refresh}
          onError={setError}
          onEnter={() => setEntered(true)}
        />
      )}

      {showSettings && (
        <Settings
          check={check}
          status={status}
          busy={busy}
          run={run}
          onStart={start}
          onStop={stop}
          onChanged={refresh}
          onClose={() => setShowSettings(false)}
        />
      )}

      {switching && (
        <div className="switchmask">
          <div className="switchcard" role="status" aria-live="polite">
            <b>正在切换工作区…</b>
            <span className="swdir" title={switching.dir}>
              {switching.dir}
            </span>
            <div className="switchtrack" aria-hidden="true">
              <i />
            </div>
            <p className="hint">{switching.stage}</p>
          </div>
        </div>
      )}

      {error && <pre className="error floater">{error}</pre>}
    </div>
  );
}

/** 启动检测页：内核 → 凭据 → 项目目录，三项全绿才给"进入工作区" */
function Setup({
  check,
  busy,
  run,
  onDone,
  onError,
  onEnter,
}: {
  check: EnvCheck | null;
  busy: boolean;
  run: Runner;
  onDone: () => Promise<void> | void;
  onError: (e: string) => void;
  onEnter: () => void;
}) {
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const ver = useAppVersion();
  const allOk = !!(
    check?.kernelInstalled &&
    check?.hasCredentials &&
    check?.projectDir
  );

  async function saveCreds() {
    if (!ak.trim() || !sk.trim()) {
      onError("AK / SK 都不能为空");
      return;
    }
    // credentials_save 返回 ()，invoke 解析为 null，不能当 boolean
    const ok = await run(async () => {
      await invoke("credentials_save", { ak: ak.trim(), sk: sk.trim() });
      return true;
    });
    if (ok) {
      setNote("已保存");
      await onDone();
    }
  }

  async function pickProject() {
    const dir = await open({ directory: true, defaultPath: check?.projectDir ?? undefined });
    if (typeof dir !== "string") return;
    if (await run(() => invoke("settings_save", { next: { projectDir: dir } }))) await onDone();
  }

  return (
    <div className="setup">
      <div className="setup-inner" data-tauri-drag-region="deep">
        {/* 标题栏沉浸后的拖拽把手，红绿灯压在这条带子上 */}
        <div className="drag" data-tauri-drag-region="deep">
          <span className="wtitle">{APP_TITLE}</span>
          {ver ? <span className="wver">{ver}</span> : null}
        </div>
        <h1>欢迎使用 CodeArts Desktop</h1>
        <p className="hint">
          驱动本机已安装的码道 CLI（<code>codearts serve</code>）。
        </p>

        <Step done={!!check?.kernelInstalled} n={1} title="检测码道 CLI">
          {check?.kernelInstalled ? (
            <p className="path small">{check.kernelBin}</p>
          ) : (
            <>
              <p className="hint">
                没有在 <code>{`${check?.kernelHome ?? "~"}/${KERNEL_REL_PATH}`}</code> 找到内核。
                请在终端执行官方安装命令：
              </p>
              <CopyLine text={KERNEL_INSTALL_CMD} onError={onError} />
              <p className="hint">
                装完把 <code>{KERNEL_PATH_CMD}</code> 加进 shell 配置，再点重新检测。
              </p>
            </>
          )}
        </Step>

        <Step done={!!check?.hasCredentials} n={2} title="华为云凭据">
          {check?.hasCredentials ? (
            <p className="hint">已配置，启动内核时注入子进程环境。</p>
          ) : (
            <>
              <input
                value={ak}
                onChange={(e) => setAk(e.target.value)}
                placeholder="CODEARTS_CLI_AK"
                spellCheck={false}
              />
              <input
                value={sk}
                onChange={(e) => setSk(e.target.value)}
                placeholder="CODEARTS_CLI_SK"
                type="password"
              />
              <button onClick={saveCreds} disabled={busy}>
                保存
              </button>
              {note && <p className="hint">{note}</p>}
            </>
          )}
        </Step>

        <Step done={!!check?.projectDir} n={3} title="当前工作区">
          {check?.projectDir ? (
            <p className="path small">{check.projectDir}</p>
          ) : (
            <button onClick={pickProject} disabled={busy}>
              选择目录
            </button>
          )}
          <p className="hint">serve 的工作目录，启动前会自动写入内核的信任白名单。</p>
        </Step>

        <div className="setup-foot">
          <span className="hint">内核 HOME：{check?.kernelHome ?? "检测中…"}</span>
          <div className="row">
            <button onClick={() => void onDone()} disabled={busy}>
              重新检测
            </button>
            {allOk && (
              <button className="primary" onClick={onEnter} disabled={busy}>
                进入工作区
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({
  done,
  n,
  title,
  children,
}: {
  done: boolean;
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`step ${done ? "ok" : ""}`}>
      <span className="badge">
        {done ? (
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3.6 8.3l3 3 5.8-6.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          n
        )}
      </span>
      <div className="grow">
        <h3>{`${n} · ${title}`}</h3>
        {children}
      </div>
    </div>
  );
}

/** 一行命令 + 复制按钮，让用户不用手抄长 URL */
function CopyLine({ text, onError }: { text: string; onError: (e: string) => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      onError(`复制失败，请手动选中命令：${e}`);
    }
  }

  return (
    <div className="cmdline" data-tauri-drag-region="false">
      <code>{text}</code>
      <button
        className={`ico-btn ${copied ? "ok" : ""}`}
        onClick={copy}
        title={copied ? "已复制" : "复制"}
        aria-label="复制这条命令"
      >
        {copied ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 12.5l5 5L20 6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect
              x="9"
              y="9"
              width="13"
              height="13"
              rx="2"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
    </div>
  );
}

function Settings({
  check,
  status,
  busy,
  run,
  onStart,
  onStop,
  onChanged,
  onClose,
}: {
  check: EnvCheck | null;
  status: KernelStatus | null;
  busy: boolean;
  run: Runner;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [cred, setCred] = useState<CredStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [updLog, setUpdLog] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("kernel");

  /** 内核自己带 upgrade 子命令，这里只是把「停-更-起」串起来，输出原样回显 */
  async function upgradeKernel() {
    setUpgrading(true);
    setUpdLog(null);
    try {
      setUpdLog(await invoke<string>("kernel_upgrade"));
    } catch (e) {
      setUpdLog(String(e));
    }
    setUpgrading(false);
    await onChanged();
  }

  // check 每次保存后由 onChanged 刷新，凭据状态跟着它重取
  useEffect(() => {
    invoke<CredStatus>("credentials_status")
      .then(setCred)
      .catch(() => setCred(null));
  }, [check]);

  const dir = status?.projectDir ?? null;
  // 技能与 MCP 由内核按目录装载，壳子只读不写：增减要在 CLI 侧配置
  useEffect(() => {
    if (!status?.healthy) {
      setCaps(null);
      return;
    }
    Promise.all([skills.list(dir), skills.system(dir), mcp.list(dir)])
      .then(([local, sys, servers]) => setCaps({ local, sys: sys.skills, servers }))
      .catch(() => setCaps(null));
  }, [status?.healthy, dir]);

  async function saveCreds() {
    if (!ak.trim() || !sk.trim()) {
      setNote("AK / SK 都不能为空");
      return;
    }
    // credentials_save 返回 ()，invoke 解析为 null，不能当 boolean
    const ok = await run(async () => {
      await invoke("credentials_save", { ak: ak.trim(), sk: sk.trim() });
      return true;
    });
    if (ok) {
      setNote("已保存");
      setAk("");
      setSk("");
      setEditing(false);
      await onChanged();
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      {/* 遮罩盖住主界面顶栏后，靠这条带子继续拖窗口；点它不要误关设置 */}
      <div
        className="drag modal-drag"
        data-tauri-drag-region="deep"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="panel settings" onClick={(e) => e.stopPropagation()}>
        <nav className="tabs" data-tauri-drag-region="deep">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="pane">
          <header data-tauri-drag-region="deep">
            <h2>{TABS.find((t) => t.id === tab)?.label}</h2>
            <button className="ico-btn" onClick={onClose} title="关闭" aria-label="关闭设置">
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
          </header>

          {tab === "kernel" && (
            <>
              <p className="hint">
                {status?.healthy
                  ? `在线 · 端口 ${status.port} · 版本 ${status.version}`
                  : status?.running
                    ? "启动中"
                    : "未运行"}
              </p>
              <div className="row">
                <button onClick={onStart} disabled={busy || !!status?.healthy}>
                  启动
                </button>
                <button onClick={onStop} disabled={busy || !status?.running}>
                  停止
                </button>
                <button onClick={upgradeKernel} disabled={busy || upgrading || !check?.kernelInstalled}>
                  {upgrading ? "更新中…" : "更新内核"}
                </button>
              </div>
              <p className="hint">
                更新走内核自带的 <code>codearts upgrade</code>，会先停掉当前实例、覆盖
                installers/bin/codearts，成功后再自动拉起。
              </p>
              {updLog && <pre className="detail">{updLog}</pre>}
              <p className="path small">{check?.kernelBin ?? "未检测到"}</p>
              <p className="hint">
                当前工作区：<span className="path small">{check?.projectDir ?? "未选择"}</span>
              </p>
              <p className="hint">工作区在左侧栏添加和切换；切换会重启内核。</p>
              {status?.detail && <pre className="detail">{status.detail}</pre>}
            </>
          )}

          {tab === "cred" && (
            <>
              {cred?.akMask && !editing ? (
                <>
                  <p className="hint">
                    已配置 · AK <span className="mask">{cred.akMask}</span> · SK{" "}
                    <span className="mask">••••••••••••</span>
                  </p>
                  <p className="hint">
                    {cred.saved
                      ? "本应用内保存，启动内核时注入"
                      : "取自 CLI 的 ~/.codeartsdoer/cli.env"}
                    {cred.saved && cred.inCliEnv ? "（CLI 侧也有一份，本应用这份优先）" : ""}
                    ；SK 不回显，只在保存时进 Rust 侧。
                  </p>
                  <div className="row">
                    <button onClick={() => setEditing(true)}>更换</button>
                  </div>
                </>
              ) : (
                <>
                  <input
                    value={ak}
                    onChange={(e) => setAk(e.target.value)}
                    placeholder="CODEARTS_CLI_AK"
                    spellCheck={false}
                  />
                  <input
                    value={sk}
                    onChange={(e) => setSk(e.target.value)}
                    placeholder="CODEARTS_CLI_SK"
                    type="password"
                  />
                  <div className="row">
                    <button className="primary" onClick={saveCreds} disabled={busy}>
                      保存
                    </button>
                    {cred?.akMask && (
                      <button
                        onClick={() => {
                          setEditing(false);
                          setAk("");
                          setSk("");
                          setNote(null);
                        }}
                      >
                        取消
                      </button>
                    )}
                  </div>
                </>
              )}
              {note && <p className="hint">{note}</p>}
            </>
          )}

          {tab === "caps" && (
            <>
              {!status?.healthy ? (
                <p className="hint">内核未运行，读不到清单</p>
              ) : !caps ? (
                <p className="hint">清单获取失败</p>
              ) : (
                <>
                  <p className="hint">
                    本地技能 {caps.local.length} 个 · 内置技能 {caps.sys.length} 个 · MCP 服务器{" "}
                    {Object.keys(caps.servers).length} 个 · 当前工作区{" "}
                    {dir ? dir.split("/").pop() : "未选择"}
                  </p>
                  <ul className="cap">
                    {caps.local.map((s) => (
                      <li key={s.name}>
                        <b>{s.name}</b>
                        <span>{s.description}</span>
                      </li>
                    ))}
                    {caps.sys.map((s) => (
                      <li key={s.name}>
                        <b>{s.name}</b>
                        <span>
                          {s.open === false ? "未启用 · " : ""}
                          {s.description}
                        </span>
                      </li>
                    ))}
                    {Object.entries(caps.servers).map(([n, v]) => (
                      <li key={n}>
                        <b>{n}</b>
                        <span>{typeof v === "string" ? v : (v.error ?? v.status ?? "已注册")}</span>
                      </li>
                    ))}
                    {!caps.local.length && !caps.sys.length && !Object.keys(caps.servers).length && (
                      <li>内核未报告任何技能或 MCP 服务器</li>
                    )}
                  </ul>
                  <p className="hint">
                    输入 / 可以直接调用这些命令；技能由内核按工作区装载，这里只展示。
                  </p>
                </>
              )}
            </>
          )}

          {tab === "about" && <About check={check} status={status} />}
        </div>
      </div>
    </div>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "kernel", label: "内核" },
  { id: "cred", label: "华为云凭据" },
  { id: "caps", label: "技能与 MCP" },
  { id: "about", label: "关于" },
];

/** 仓库先挂着地址，远端与发布等开发完成后再配 */
const REPO = "https://github.com/17472439chaochao-lab/codearts";

/** 码道产品官网，内核与凭据都归它，这里只做个入口 */
const OFFICIAL = "https://codearts.huaweicloud.com/";

function Url({ text, label }: { text: string; label: string }) {
  return (
    <button
      className="repo"
      title={label}
      onClick={() => void openUrl(text).catch((e) => console.error(label, e))}
    >
      {text}
    </button>
  );
}

function About({ check, status }: { check: EnvCheck | null; status: KernelStatus | null }) {
  const ver = useAppVersion();

  return (
    <>
      <dl className="about">
        <dt>应用</dt>
        <dd>CodeArts Desktop{ver ? ` ${ver}` : ""} · 本机开发版</dd>
        <dt>内核</dt>
        <dd className="path">
          {check?.kernelBin ?? "未检测到"}
          {status?.version ? ` · ${status.version}` : ""}
        </dd>
        <dt>官网</dt>
        <dd>
          <Url text={OFFICIAL} label="在浏览器中打开码道官网" />
        </dd>
        <dt>仓库</dt>
        <dd>
          <Url text={REPO} label="在浏览器中打开仓库" />
        </dd>
      </dl>

      <h3>为什么做这个壳</h3>
      <p className="hint">
        官方码道桌面端只发 Apple Silicon 包，Intel Mac 装不上；CLI 的 TUI 又不适合长时间挂着多会话。
        于是把 <code>codearts serve</code> 当内核，外面套一层本地壳：Rust 侧只负责起停进程、注入凭据、
        代理 HTTP 与 SSE，界面做聊天、多工作区和命令面板。所有能力都来自内核本身，
        不逆向私有协议，也不另接一套模型服务。
      </p>

      <h3>数据与边界</h3>
      <p className="hint">
        凭据只写本机（0600 文件，与 CLI 存 cli.env 的做法一致），SK 不进前端；serve 固定监听
        127.0.0.1，会话与消息落在内核自己的 cli-data 里，不经过任何第三方。
        这不是官方客户端：不做自动更新，也不复刻官网的建应用 / 一键发布 / 连接器市场，
        技能与 MCP 目前只读展示，写入仍在 CLI 侧配置。
      </p>

      <h3>技术栈</h3>
      <ul className="stack">
        <li>
          <code>Tauri</code> —— 桌面壳：Rust 监管内核进程，WebView 只跑界面
        </li>
        <li>
          <code>React</code> —— 聊天、侧栏与设置面板
        </li>
        <li>
          <code>Vite</code> —— 前端开发与打包
        </li>
        <li>
          <code>TypeScript</code> —— 前端类型
        </li>
        <li>
          <code>tokio</code> —— 异步运行时：进程起停、日志与 SSE 转发
        </li>
        <li>
          <code>reqwest</code> —— 内核 HTTP 客户端（只连 127.0.0.1）
        </li>
        <li>
          <code>serde</code> / <code>serde_json</code>、<code>thiserror</code>、
          <code>base64</code>、<code>rand</code>、<code>futures-util</code>
        </li>
      </ul>
    </>
  );
}

/** 设置面板只读展示的能力清单：/skill、/v1/skills、/mcp 各一份 */
type Caps = {
  local: SkillInfo[];
  sys: V1Skill[];
  servers: Record<string, { status?: string; error?: string } | string>;
};

/** credentials_status 的返回：只有有无与 AK 尾号，SK 明文不出 Rust */
type CredStatus = { saved: boolean; inCliEnv: boolean; akMask: string | null };

/** 设置面板左侧菜单的四页 */
type Tab = "kernel" | "cred" | "caps" | "about";

