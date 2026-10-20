import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import Chat, { ChipSelect, MODEL_KEY } from "./Chat";
import {
  api,
  customProviders,
  kernelBusy,
  mcp,
  normalizeProviders,
  reloadInstance,
  skills,
  type CustomProvider,
  type EnvCheck,
  type SkillInfo,
  type V1Skill,
} from "./kernelApi";
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
  // 改完第三方模型后让 Chat 重拉一次 /provider：免重启的同步不改端口，靠这个计数触发
  const [provTick, setProvTick] = useState(0);
  // 进工作区要拉起内核，这几秒界面不能操作；进度卡告诉用户在干什么（切工作区已经不重启了）
  const [switching, setSwitching] = useState<{
    dir: string;
    title: string;
    stage: string;
  } | null>(null);
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

  /** 内核在一个进程里按目录分实例，实例随第一次请求懒起。
   *  切区只改界面当前目录，后台会话照旧在原来的实例里跑，不再重启内核。 */
  const applyDir = (dir: string, list: string[]) => {
    void run(async () => {
      await invoke("settings_save", { next: { projectDir: dir, projects: list } });
      await refresh();
    });
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

  /** 进入工作区时内核还不在就顺手拉起，沿用换目录那张进度卡 */
  const enterWorkspace = () => {
    setEntered(true);
    if (status?.healthy) return;
    setSwitching({
      dir: check?.projectDir ?? "",
      title: "正在启动内核…",
      stage: "首次启动需要几秒，就绪后自动接入",
    });
    void run(() => invoke<KernelStatus>("kernel_start"))
      .then((s) => {
        if (s) setStatus(s);
      })
      .finally(() => setSwitching(null));
  };

  return (
    <div className="shell">
      {ready && entered ? (
        <Chat
          projectDir={check!.projectDir!}
          projects={check!.projects}
          status={status}
          busy={busy}
          keepAwake={check!.keepAwake}
          onStart={start}
          onStop={stop}
          onAddDir={addDir}
          onSwitchDir={switchDir}
          onDropDir={dropDir}
          provTick={provTick}
          onOpenSettings={() => setShowSettings(true)}
        />
      ) : (
        <Setup
          check={check}
          busy={busy}
          run={run}
          onDone={refresh}
          onError={setError}
          onEnter={enterWorkspace}
        />
      )}

      {showSettings && (
        <Settings
          check={check}
          status={status}
          busy={busy}
          keepAwake={!!check?.keepAwake}
          run={run}
          onStart={start}
          onStop={stop}
          onChanged={refresh}
          onModelChange={() => setProvTick((t) => t + 1)}
          onClose={() => setShowSettings(false)}
        />
      )}

      {switching && (
        <div className="switchmask">
          <div className="switchcard" role="status" aria-live="polite">
            <b>{switching.title}</b>
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
  keepAwake,
  run,
  onStart,
  onStop,
  onChanged,
  onModelChange,
  onClose,
}: {
  check: EnvCheck | null;
  status: KernelStatus | null;
  busy: boolean;
  keepAwake: boolean;
  run: Runner;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onChanged: () => Promise<void> | void;
  /** 第三方模型列表同步进内核后通知外层，Chat 那边要重拉 /provider */
  onModelChange: () => void;
  onClose: () => void;
}) {
  const [ak, setAk] = useState("");
  const [sk, setSk] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [capsTick, setCapsTick] = useState(0);
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

  // 切区不重启内核，status.projectDir 是 serve 启动时的 cwd，会落后于当前区；
  // 技能/模型/权限这些按区生效的设置必须跟着当前区走
  const dir = check?.projectDir ?? null;
  // 清单本身只读；装完技能靠内核的目录监视热加载，这里重新拉一次就能看见
  useEffect(() => {
    if (!status?.healthy) {
      setCaps(null);
      return;
    }
    Promise.all([skills.list(dir), skills.system(dir), mcp.list(dir)])
      .then(([local, sys, servers]) => setCaps({ local, sys: sys.skills, servers }))
      .catch(() => setCaps(null));
  }, [status?.healthy, dir, capsTick]);

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
              {updLog && <pre className="detail">{updLog}</pre>}
              {status?.detail && <pre className="detail">{status.detail}</pre>}
              <label className="awake">
                <input
                  type="checkbox"
                  checked={keepAwake}
                  onChange={async (e) => {
                    const on = e.target.checked;
                    if (await run(() => invoke("settings_save", { next: { keepAwake: on } }))) {
                      await onChanged();
                    }
                  }}
                />
                任务运行时阻止电脑休眠
              </label>
            </>
          )}

          {tab === "model" && (
            <ModelSettings
              dir={dir}
              healthy={!!status?.healthy}
              port={status?.port ?? null}
              onModelChange={onModelChange}
              onRestart={async () => {
                await onStop();
                await onStart();
              }}
            />
          )}

          {tab === "cred" && (
            <>
              {cred?.akMask && !editing ? (
                <>
                  <p className="hint">
                    已配置 · AK <span className="mask">{cred.akMask}</span> · SK{" "}
                    <span className="mask">••••••••••••</span>
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
                </>
              )}
              <SkillManager
                dir={dir}
                healthy={!!status?.healthy}
                onChanged={() => setCapsTick((t) => t + 1)}
              />
            </>
          )}

          {tab === "about" && <About check={check} status={status} />}
        </div>
      </div>
    </div>
  );
}

type ManagedSkill = {
  name: string;
  /** 原样回显的来源，如 foo/bar/skills/x@v1 */
  source: string;
  installedAt: number;
  updatedAt: number;
};

type ManagedView = {
  project: ManagedSkill[];
  user: ManagedSkill[];
  projectRoot: string;
  userRoot: string;
};

type SkillReport = {
  installed: string[];
  conflicts: string[];
  invalid: string[];
  removed: string[];
  root: string;
  message: string;
};

/**
 * 技能安装：Rust 侧抓 GitHub 压缩包、校验 SKILL.md、写进内核的技能目录。
 * 作用域只有"当前工作区 / 用户级"，目录一律由 Settings 推导，前端传不进来。
 * 写完文件内核还不认，得让实例重载一次（见 kernelApi.reloadInstance）。
 */
function SkillManager({
  dir,
  healthy,
  onChanged,
}: {
  dir: string | null;
  healthy: boolean;
  onChanged: () => void;
}) {
  const [src, setSrc] = useState("");
  const [view, setView] = useState<ManagedView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [working, setWorking] = useState(false);

  const reload = useCallback(
    () =>
      invoke<ManagedView>("skills_managed")
        .then(setView)
        .catch(() => setView(null)),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 空闲才自动重载：实例重载会清掉实例状态，正在出活时点会把这轮消息弄丢 */
  async function syncKernel(quiet: boolean, done?: string) {
    if (!healthy || !dir) {
      setStale(false);
      if (!quiet) setNote(done ?? "内核没在跑；技能文件已经落盘，下次启动内核就会装载");
      return;
    }
    try {
      if (!quiet && (await kernelBusy(dir))) {
        setStale(true);
        setNote(`${done ? done + "；" : ""}有会话正在出活，先等它空闲再点「重载内核」`);
        return;
      }
      await reloadInstance(dir);
      setStale(false);
      await new Promise((r) => setTimeout(r, 600));
      onChanged();
    } catch (e) {
      setStale(true);
      setNote(`${done ? done + "；" : ""}内核重载失败：${String(e)}`);
    }
  }

  async function call(cmd: string, args: Record<string, string>) {
    setWorking(true);
    setNote(null);
    let done = "";
    let ok = false;
    try {
      const r = await invoke<SkillReport>(cmd, args);
      setNote(r.message);
      done = r.message;
      ok = true;
    } catch (e) {
      setNote(String(e));
    }
    await reload();
    setWorking(false);
    if (ok) await syncKernel(false, done);
  }

  const rows: { skill: ManagedSkill; scope: "project" | "user" }[] = [
    ...(view?.project ?? []).map((skill) => ({ skill, scope: "project" as const })),
    ...(view?.user ?? []).map((skill) => ({ skill, scope: "user" as const })),
  ];

  return (
    <>
      <h3>从 GitHub 装技能</h3>
      <div className="row">
        <input
          value={src}
          onChange={(e) => setSrc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && src.trim() && !working) {
              void call("skill_install_github", { source: src.trim() });
            }
          }}
          placeholder="owner/repo、owner/repo/skills/名称@tag，也可以直接粘仓库链接"
          spellCheck={false}
        />
        <button
          className="primary"
          disabled={working || !src.trim()}
          onClick={() => void call("skill_install_github", { source: src.trim() })}
        >
          {working ? "处理中…" : "安装"}
        </button>
        {stale && (
          <button onClick={() => void syncKernel(false)} disabled={working}>
            重载内核
          </button>
        )}
      </div>
      {note && <p className="hint">{note}</p>}
      {rows.length > 0 && (
        <ul className="cap managed">
          {rows.map(({ skill, scope: s }) => (
            <li key={`${s}:${skill.name}`}>
              <b>{skill.name}</b>
              <span title={skill.source}>
                {s === "project" ? "当前工作区 · " : ""}
                {skill.source}
              </span>
              <button
                className="ico-btn"
                disabled={working}
                title="按安装时记录的来源重新拉一次"
                aria-label={`更新 ${skill.name}`}
                onClick={() => void call("skill_update_github", { name: skill.name, scope: s })}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M13 8a5 5 0 1 1-1.5-3.6M13 2.6V6h-3.4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                className="ico-btn"
                disabled={working}
                title="卸载：只删这份清单里记着的那一个目录"
                aria-label={`卸载 ${skill.name}`}
                onClick={() => void call("skill_uninstall", { name: skill.name, scope: s })}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M3.4 4.8h9.2M6.3 4.8V3.3h3.4v1.5M4.9 4.8l.5 7.9h5.2l.5-7.9M6.7 6.9v3.7M9.3 6.9v3.7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 内核配置里第三方模型的窗口缺省值：/models 大多不返回，先给个能跑的先填上，用户可改 */
const DEFAULT_CONTEXT = 128000;

type ModelRow = { id: string; name: string; context: string; output: string; reasoning: boolean };

type ModelForm = {
  preset: string;
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ModelRow[];
};

/** 常见的 OpenAI 兼容端点，只带地址，模型一律靠拉取或手填，不替用户猜模型 ID */
const PRESETS: { id: string; label: string; baseUrl: string }[] = [
  { id: "custom", label: "自定义", baseUrl: "" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "moonshot", label: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "dashscope", label: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
];

const blankRow = (): ModelRow => ({ id: "", name: "", context: "", output: "", reasoning: false });

const blankForm = (): ModelForm => ({
  preset: "custom",
  id: "",
  name: "",
  baseUrl: "",
  apiKey: "",
  models: [blankRow()],
});

/** 编辑已有提供商：密钥不回传，留空即沿用配置里的原值 */
function formOf(p: CustomProvider): ModelForm {
  return {
    preset: PRESETS.find((x) => x.baseUrl === p.baseUrl)?.id ?? "custom",
    id: p.id,
    name: p.name === p.id ? "" : p.name,
    baseUrl: p.baseUrl,
    apiKey: "",
    models: p.models.map((m) => ({
      id: m.id,
      name: m.name === m.id ? "" : m.name,
      context: m.context ? String(m.context) : "",
      output: m.output ? String(m.output) : "",
      reasoning: m.reasoning,
    })),
  };
}

type LiveProviders = ReturnType<typeof normalizeProviders>;

/** 一次模型配置操作；models 是这次想在内核里见到的模型清单，移除提供商时为空 */
type ModelOp = { id: string; kind: "save" | "remove"; models: { id: string; context: number }[] };

/** 还没同步进内核的那次操作；why 决定收尾给「重载内核」还是「重启内核」 */
type PendingOp = ModelOp & { why: "sync" | "boot" };

/**
 * 拿内核运行态的模型和配置里想要的逐一对账。
 * 2026-10-20 隔离实例实测：提供商的模型表在启动时整份灌进内核，重载只做增量——
 * 新模型能补进来、整家提供商能删掉，但启动时就有的一篇都刷不掉（删掉、改 limit 都一样）。
 */
function modelGap(op: ModelOp, live: LiveProviders) {
  const got = live.models.filter((m) => m.providerID === op.id);
  const wantIds = new Set(op.models.map((m) => m.id));
  const gotIds = new Set(got.map((m) => m.modelID));
  const stale = got.filter((m) => !wantIds.has(m.modelID)).map((m) => m.modelID);
  const missing = op.models.filter((m) => !gotIds.has(m.id)).map((m) => m.id);
  const edited = op.models
    .filter((m) => {
      const g = got.find((x) => x.modelID === m.id);
      return g != null && typeof g.context === "number" && g.context !== m.context;
    })
    .map((m) => m.id);
  return { stale, missing, edited };
}

/** 对账结果里挑出对不上内核的那些，逐条说清楚 */
function gapText(g: ReturnType<typeof modelGap>) {
  const list = (ids: string[]) =>
    ids.slice(0, 3).join("、") + (ids.length > 3 ? ` 等 ${ids.length} 个` : "");
  const bits: string[] = [];
  if (g.stale.length) bits.push(`已删除的 ${list(g.stale)} 还挂在列表里`);
  if (g.missing.length) bits.push(`新增的 ${list(g.missing)} 还没装载`);
  if (g.edited.length) bits.push(`${list(g.edited)} 的参数改动没生效`);
  return bits.join("；");
}

/** 收尾文案集中在这儿：自动同步和点按钮重试共用同一套说法 */
function notice(op: ModelOp, how: "off" | "busy" | "boot" | "ok" | "err", detail?: string) {
  const wrote = op.kind === "save" ? "已写入内核配置" : `已移除「${op.id}」`;
  if (how === "off") return `${wrote}；内核没在跑，下次启动内核时生效`;
  if (how === "busy") return `${wrote}；有会话正在出活，先等它空闲再点「重载内核」`;
  if (how === "boot")
    return `${wrote}；${detail ?? "内核的模型列表还没对上"}。重载只能补新模型，删掉和改过的要重启内核才会刷新`;
  if (how === "ok")
    return op.kind === "save" ? `${wrote}，模型列表已经对上，下拉框现在就能选` : wrote;
  return `${wrote}；内核同步失败：${detail ?? "未知错误"}`;
}

/**
 * 模型页：上半是内核此刻真正可用的模型，下半是接第三方提供商。
 * 写的是内核自己的全局配置文件。2026-10-20 隔离实例实测出的免重启边界：
 * 新增模型、删掉整家提供商靠重载工作区实例就立刻生效（serve 进程不换、会话不丢）；
 * 但删掉启动时就存在的模型、改它的参数、或新接一家提供商都得重启内核。
 * 所以每次保存/移除都回读 /provider 逐模型对账，对不上就把按钮换成「重启内核」。
 */
function ModelSettings({
  dir,
  healthy,
  port,
  onRestart,
  onModelChange,
}: {
  dir: string | null;
  healthy: boolean;
  port: number | null;
  onRestart: () => Promise<void>;
  onModelChange: () => void;
}) {
  const [custom, setCustom] = useState<CustomProvider[] | null>(null);
  const [live, setLive] = useState<LiveProviders>({ models: [], default: null });
  const [form, setForm] = useState<ModelForm | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 内核还没同步的那次操作：忙 → 重载内核，新标识 → 重启内核 */
  const [pending, setPending] = useState<PendingOp | null>(null);
  const [working, setWorking] = useState(false);

  const reload = useCallback(
    () =>
      customProviders
        .list()
        .then(setCustom)
        .catch((e) => {
          setCustom([]);
          setErr(String(e));
        }),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const fetchLive = useCallback(
    () =>
      !healthy || !dir
        ? Promise.resolve({ models: [], default: null } as LiveProviders)
        : api<any>("GET", "/provider", undefined, dir).then(normalizeProviders),
    [healthy, dir],
  );

  useEffect(() => {
    fetchLive()
      .then(setLive)
      .catch(() => setLive({ models: [], default: null }));
  }, [fetchLive, port]);

  function applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setForm((f) => (f ? { ...f, preset: id, baseUrl: f.baseUrl || p.baseUrl } : f));
  }

  function setRow(i: number, patch: Partial<ModelRow>) {
    setForm((f) =>
      f ? { ...f, models: f.models.map((r, j) => (j === i ? { ...r, ...patch } : r)) } : f,
    );
  }

  /**
   * 落盘之后把配置同步进内核：空闲就重载工作区实例（实测 serve 进程不换、会话不丢），
   * 再回读 /provider 逐模型对账。对不上就说明碰上了启动时才刷新的那批（删掉的、改过参数的、
   * 新提供商标识），只能重启。
   */
  async function syncKernel(op: ModelOp) {
    setPending(null);
    if (!healthy || !dir) {
      setNote(notice(op, "off"));
      return;
    }
    try {
      if (await kernelBusy(dir).catch(() => false)) {
        setPending({ ...op, why: "sync" });
        setNote(notice(op, "busy"));
        return;
      }
      await reloadInstance(dir);
      // 实例重建要一两秒，立刻回读拿到的是旧列表
      await new Promise((r) => setTimeout(r, 600));
      const next = await fetchLive();
      setLive(next);
      onModelChange();
      const gap = modelGap(op, next);
      if (gap.stale.length || gap.missing.length || gap.edited.length) {
        setPending({ ...op, why: "boot" });
        setNote(notice(op, "boot", gapText(gap)));
      } else {
        setNote(notice(op, "ok"));
      }
    } catch (e) {
      setPending({ ...op, why: "sync" });
      setNote(notice(op, "err", String(e)));
    }
  }

  /** 待同步那次操作的补救：会话在跑就再重载一次，对不上账的先重启内核再走同一套校验 */
  async function retry() {
    if (!pending) return;
    const op: ModelOp = { id: pending.id, kind: pending.kind, models: pending.models };
    setWorking(true);
    try {
      if (pending.why === "boot") await onRestart();
      await syncKernel(op);
    } finally {
      setWorking(false);
    }
  }

  async function submit() {
    if (!form) return;
    setErr(null);
    setNote(null);
    const draft = {
      id: form.id.trim(),
      name: form.name.trim() || undefined,
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim() || undefined,
      models: form.models
        .filter((m) => m.id.trim())
        .map((m) => ({
          id: m.id.trim(),
          name: m.name.trim() || undefined,
          context: Number(m.context) || 0,
          output: Number(m.output) || 0,
          reasoning: m.reasoning,
        })),
    };
    setWorking(true);
    try {
      setCustom(await customProviders.save(draft));
      setForm(null);
      await syncKernel({
        id: draft.id,
        kind: "save",
        models: draft.models.map((m) => ({ id: m.id, context: m.context })),
      });
    } catch (e) {
      setErr(String(e));
    }
    setWorking(false);
  }

  async function drop(id: string) {
    setErr(null);
    setWorking(true);
    try {
      setCustom(await customProviders.remove(id));
      if (form?.id === id) setForm(null);
      await syncKernel({ id, kind: "remove", models: [] });
    } catch (e) {
      setErr(String(e));
    }
    setWorking(false);
  }

  /** 用提供商自己的 /models 列一把，省得手抄 ID */
  async function pull() {
    if (!form) return;
    setErr(null);
    setNote(null);
    if (!form.baseUrl.trim()) {
      setErr("先填服务地址");
      return;
    }
    setWorking(true);
    try {
      const ids = await customProviders.fetchModels(form.baseUrl.trim(), form.apiKey.trim());
      if (!ids.length) {
        setErr("对方没有返回模型，改成手动填");
      } else {
        setForm((f) =>
          f
            ? {
                ...f,
                models: ids.map((m) => {
                  const ctx = m.context ?? DEFAULT_CONTEXT;
                  return {
                    id: m.id,
                    name: "",
                    context: String(ctx),
                    output: String(Math.min(8192, Math.floor(ctx / 4))),
                    reasoning: false,
                  };
                }),
              }
            : f,
        );
        setNote(`拉到 ${ids.length} 个模型，窗口大小按 ${DEFAULT_CONTEXT} 兜底，按实际改一下`);
      }
    } catch (e) {
      // 已存的密钥内核是加密放的，这一趟没法替你解密，只能让用户重填
      setErr(`拉取失败：${e}${form.apiKey.trim() ? "" : "（编辑已有提供商时要重填一次 API Key）"}`);
    }
    setWorking(false);
  }

  const keyOf = (m: { providerID: string; modelID: string }) => `${m.providerID}/${m.modelID}`;
  /** 与界面选模型同一套兜底：记住的那条 → 内核默认 → 列表第一条 */
  const current = keyOf(
    live.models.find((m) => keyOf(m) === localStorage.getItem(MODEL_KEY)) ??
      live.default ??
      live.models[0] ?? { providerID: "", modelID: "" },
  );

  return (
    <>
      <h3>当前可用模型</h3>
      {!healthy ? (
        <p className="hint">内核未运行，读不到实际列表。</p>
      ) : !live.models.length ? (
        <p className="hint">内核没有返回模型。</p>
      ) : (
        <ul className="cap models">
          {(() => {
            const rowOf = (m: (typeof live.models)[number]) => {
              const key = keyOf(m);
              return (
                <li key={key} className={key === current ? "on" : ""}>
                  <b>{m.name}</b>
                  <span>
                    {m.context ? `${Math.round(m.context / 1024)}K` : ""}
                    {m.image ? " · 可看图" : ""}
                  </span>
                  {key === current && <em className="tag">当前</em>}
                </li>
              );
            };
            const out: ReturnType<typeof rowOf>[] = [];
            live.models.filter((m) => !m.custom).forEach((m) => out.push(rowOf(m)));
            const custom = live.models.filter((m) => m.custom);
            const ids: string[] = [];
            for (const m of custom) if (!ids.includes(m.providerID)) ids.push(m.providerID);
            const groups = ids.map((id) => custom.filter((m) => m.providerID === id));
            groups.forEach((list, pi) => {
              if (pi === 0) out.push(<li className="grp" key="grp-custom">自定义</li>);
              out.push(<li className="grp sub" key={`grp-${list[0].providerID}`}>{list[0].providerName}</li>);
              list.forEach((m) => out.push(rowOf(m)));
            });
            return out;
          })()}
        </ul>
      )}

      <h3>接入第三方模型</h3>
      <p className="hint">
        加模型、删掉整家提供商，保存后自动重载实例就生效；新接一家提供商、删掉或改动内核启动时就带着的模型，需要重启内核。
      </p>
      {custom && custom.length > 0 && (
        <ul className="cap managed">
          {custom.map((p) => (
            <li key={p.id}>
              <b>{p.name}</b>
              <span title={p.baseUrl}>
                {p.id} · {p.models.length} 个模型 ·{" "}
                {p.keyMask ?? "未填密钥"} · {p.baseUrl}
              </span>
              <button
                className="ico-btn"
                disabled={working}
                title="编辑"
                aria-label={`编辑 ${p.id}`}
                onClick={() => {
                  setErr(null);
                  setForm(formOf(p));
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M11.2 2.6l2.2 2.2L5.6 12.6 2.8 13.2l.6-2.8z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                className="ico-btn"
                disabled={working}
                title="移除：会从配置文件里删掉这一项，密钥也一起没了"
                aria-label={`移除 ${p.id}`}
                onClick={() => void drop(p.id)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M3.4 4.8h9.2M6.3 4.8V3.3h3.4v1.5M4.9 4.8l.5 7.9h5.2l.5-7.9M6.7 6.9v3.7M9.3 6.9v3.7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!form && (
        <div className="row">
          <button
            onClick={() => {
              setErr(null);
              setForm(blankForm());
            }}
          >
            添加提供商
          </button>
        </div>
      )}

      {form && (
        <div className="mform">
          <div className="row">
            <ChipSelect
              value={form.preset}
              options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
              placeholder="预设"
              title="常见服务商的地址"
              onChange={applyPreset}
            />
            <input
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="标识，如 openai"
              spellCheck={false}
            />
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="显示名，如 OpenAI"
              spellCheck={false}
            />
          </div>
          <div className="row">
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="服务地址，如 https://api.openai.com/v1"
              spellCheck={false}
            />
            <button onClick={pull} disabled={working}>
              {working ? "处理中…" : "拉取模型"}
            </button>
          </div>
          <div className="row">
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder="API Key（编辑时留空表示不改）"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="mhead">
            <span>模型 ID</span>
            <span>显示名</span>
            <span title="上下文窗口 token 数">上下文</span>
            <span title="最大输出 token 数">最大输出</span>
            <span title="是否支持思考模式">思考</span>
            <span />
          </div>
          {form.models.map((row, i) => (
            <div className="mrow" key={i}>
              <input
                value={row.id}
                onChange={(e) => setRow(i, { id: e.target.value })}
                placeholder="gpt-4o-mini"
                spellCheck={false}
              />
              <input
                value={row.name}
                onChange={(e) => setRow(i, { name: e.target.value })}
                placeholder="可选"
                spellCheck={false}
              />
              <input
                value={row.context}
                onChange={(e) => setRow(i, { context: e.target.value })}
                placeholder="128000"
                inputMode="numeric"
              />
              <input
                value={row.output}
                onChange={(e) => setRow(i, { output: e.target.value })}
                placeholder="8192"
                inputMode="numeric"
              />
              <input
                className="chk"
                type="checkbox"
                checked={row.reasoning}
                onChange={(e) => setRow(i, { reasoning: e.target.checked })}
              />
              <button
                className="ico-btn"
                disabled={form.models.length === 1}
                title="删掉这一行"
                aria-label="删掉这一行"
                onClick={() => setForm({ ...form, models: form.models.filter((_, j) => j !== i) })}
              >
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
          ))}
          {/* 三个动作全收成图标靠右：加一行 / 落盘 / 关掉编辑（真删除在列表行那枚垃圾桶上） */}
          <div className="row mfoot">
            <button
              className="ico-btn"
              title="增加一个模型"
              aria-label="增加一个模型"
              onClick={() => setForm({ ...form, models: [...form.models, blankRow()] })}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 3.4v9.2M3.4 8h9.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button className="ico-btn" title="保存" aria-label="保存" onClick={submit} disabled={working}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M3.2 8.6l3.2 3.2L12.8 4.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className="ico-btn"
              title="取消编辑"
              aria-label="取消编辑"
              onClick={() => {
                setForm(null);
                setErr(null);
              }}
            >
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
        </div>
      )}

      {pending && (
        <div className="row">
          <button onClick={() => void retry()} disabled={working}>
            {pending.why === "boot" ? "重启内核" : "重载内核"}
          </button>
        </div>
      )}
      {note && <p className="hint">{note}</p>}
      {err && <pre className="error inline">{err}</pre>}
    </>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "kernel", label: "内核" },
  { id: "model", label: "模型" },
  { id: "cred", label: "华为云凭据" },
  { id: "caps", label: "技能与 MCP" },
  { id: "about", label: "关于" },
];

/** 仓库先挂着地址，远端与发布等开发完成后再配 */
const REPO = "https://github.com/17472439chaochao-lab/codearts";

/** 码道产品官网，内核与凭据都归它，这里只做个入口 */
const OFFICIAL = "https://codearts.huaweicloud.com/";

/** 版本按 lock 的解析结果写死，升级依赖时一起改 */
const STACK: [string, string][] = [
  ["Tauri", "2.12.4"],
  ["React", "19.3.1"],
  ["Vite", "8.3.4"],
  ["TypeScript", "6.0.3"],
  ["tokio", "1.53.3"],
  ["reqwest", "0.12.28"],
  ["serde", "1.0.229"],
  ["serde_json", "1.0.154"],
  ["thiserror", "2.0.21"],
  ["base64", "0.22.1"],
  ["rand", "0.8.8"],
  ["futures-util", "0.3.34"],
];

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

      <h3>技术栈</h3>
      <ul className="stack">
        {STACK.map(([name, version]) => (
          <li key={name}>
            <code>{name}</code> {version}
          </li>
        ))}
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

/** 设置面板左侧菜单的五页 */
type Tab = "kernel" | "model" | "cred" | "caps" | "about";

