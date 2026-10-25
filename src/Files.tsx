import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { structuredPatch, type StructuredPatchHunk } from "diff";
import type { FileDiff, GitStatus, Session } from "./kernelApi";
import { find, restoreFile, workspaceGit } from "./kernelApi";
import { useResolvedTheme, type ResolvedTheme } from "./theme";
import type { ThemedToken } from "./highlight";
import { renderMarkdown } from "./markdown";

/** 打开文件的坐标：rel 相对当前工作区，abs 用来和内核返回的改动路径对上 */
export type OpenFile = {
  rel: string;
  abs: string;
  tab: "preview" | "diff";
  /** 计划文件可以落在内核数据目录，读取走 plan_read 而不是工作区内的 file_read */
  plan?: boolean;
  /** 全文搜索跳过来时定位并高亮的行号（1 起） */
  line?: number;
};

type Entry = {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
};
type FileList = { entries: Entry[]; truncated: boolean };
type FileContent = {
  content: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
  mtime: number;
  /** 图片的 base64 data URL，直接塞 <img>；文本文件为 null */
  dataUrl: string | null;
  /** 文件头认出来的图片类型；有值但 dataUrl 为空说明体积超限 */
  mime: string | null;
};

const FSTATUS_CN: Record<string, string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  untracked: "?",
};

const MAX_LINES = 5000;
/** 改动前后加起来超过这个量就不在 WebView 里算逐行 diff，避免整窗卡死 */
const MAX_DIFF_CHARS = 800_000;
/** 高亮是纯前端增强：再大的文本就保持纯文本，别为了配色卡住主线程 */
const MAX_HIGHLIGHT_CHARS = 300_000;
/** Markdown 渲染整棵 DOM，没有虚拟滚动；超过这个长度直接给原文 */
const MAX_MD_CHARS = 300_000;
/** 快捷打开的结果条数 */
const QUICK_LIMIT = 40;
/** 「改动」里那半段 git 清单被文件写入事件带着刷新的最小间隔 */
const GIT_REFRESH_MS = 4000;
const isMd = (rel: string) => /\.md$/i.test(rel);

const trimSlash = (p: string) => p.replace(/\/+$/, "");
const samePath = (a: string, b: string) => trimSlash(a) === trimSlash(b);

/** 内核返回的是绝对路径；不属于当前工作区的改动不给打开 */
export function relInRoot(root: string, abs: string): string | null {
  const r = trimSlash(root);
  if (samePath(abs, r)) return "";
  return abs.startsWith(r + "/") ? abs.slice(r.length + 1) : null;
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const dirName = (rel: string) => {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 内核用 `<会话创建时间>-<slug>.md` 命名，时间戳没有展示价值 */
const planTitle = (name: string) => name.replace(/\.md$/i, "").replace(/^\d{10,}-/, "");

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`chev ${open ? "open" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="fico" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 4.3A1.5 1.5 0 0 1 3 2.8h2.9l1.4 1.6H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13.4H3a1.5 1.5 0 0 1-1.5-1.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="fico" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M4 1.8h5.2L13 5.6v8.6H4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M9 2v4h4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function ChangeMark({ diff }: { diff?: FileDiff }) {
  if (!diff) return null;
  const st = diff.status ?? "modified";
  return (
    <span className={`fx ${st}`} title={`${diff.additions ?? 0} 行新增 · ${diff.deletions ?? 0} 行删除`}>
      {FSTATUS_CN[st] ?? "M"}
    </span>
  );
}

type PanelProps = {
  root: string;
  session: Session | null;
  diffs: FileDiff[];
  /** file.edited 脉冲：合并短时间内的多次写入，刷新树和打开的目录 */
  pulse: number;
  onOpenFile: (f: OpenFile) => void;
  onRefreshDiffs: () => void;
  onClose: () => void;
};

export function FilePanel({
  root,
  session,
  diffs,
  pulse,
  onOpenFile,
  onRefreshDiffs,
  onClose,
}: PanelProps) {
  const [tab, setTab] = useState<"tree" | "changes">("tree");
  const [version, setVersion] = useState(0);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 整个工作区的未提交改动；与「当前会话改过什么」并排显示在同一页签里 */
  const [git, setGit] = useState<GitStatus | null>(null);

  const wsDiffs = useMemo(
    () => diffs.filter((d) => relInRoot(root, d.file) !== null),
    [diffs, root],
  );
  const changed = useMemo(() => {
    const m = new Map<string, FileDiff>();
    for (const d of wsDiffs) m.set(trimSlash(d.file), d);
    return m;
  }, [wsDiffs]);

  const repo = git?.repo ?? false;
  const gitChanges = git?.changes ?? [];
  const changedCount = wsDiffs.length + gitChanges.length;
  const changesHint =
    git === null
      ? "读取中…"
      : !session
        ? "打开一个会话后显示它改过的文件"
        : repo
          ? "没有未提交的改动"
          : "当前会话还没有文件改动";

  const loadRoot = useCallback(() => {
    let alive = true;
    setErr(null);
    invoke<FileList>("files_list", { rel: "", directory: root })
      .then((r) => {
        if (!alive) return;
        setEntries(r.entries);
        setTruncated(r.truncated);
      })
      .catch((e) => {
        if (alive) setErr(String(e));
      });
    return () => {
      alive = false;
    };
    // 根目录由 Rust 侧按 directory 参数解析（只认登记过的工作区），换区/换会话都要重拉一次，
    // 否则只会清空旧树、一直停在「读取中」
  }, [root]);

  /** 上一次读 git 状态的时间，用来给 version 驱动的刷新限流 */
  const gitAt = useRef(0);

  /** git status 比 diff 便宜得多，但仍然不跟着 version 每 0.7 秒跑一次 */
  const loadGit = useCallback(() => {
    let alive = true;
    gitAt.current = Date.now();
    workspaceGit
      .status(root)
      .then((r) => {
        if (alive) setGit(r);
      })
      // 没装 git、目录不可读之类都按「不是仓库」处理：这一段整块不出现，不留空面板
      .catch(() => {
        if (alive) setGit({ repo: false, changes: [] });
      });
    return () => {
      alive = false;
    };
  }, [root]);

  // 换工作区立刻重读，角标不能停在上一个区的数字上
  useEffect(() => loadGit(), [loadGit]);

  // 换工作区先清掉旧树，别让两层文件混在一起
  useEffect(() => {
    setEntries(null);
    setTruncated(false);
    setGit(null);
  }, [root]);
  useEffect(() => loadRoot(), [loadRoot, version]);

  // version 在 agent 干活时每 0.7 秒就 +1，git status 压到最多 4 秒一次，且只在页签开着时排期
  useEffect(() => {
    if (tab !== "changes" || !version) return;
    const wait = Math.max(0, GIT_REFRESH_MS - (Date.now() - gitAt.current));
    const t = window.setTimeout(() => void loadGit(), wait);
    return () => window.clearTimeout(t);
  }, [tab, version, loadGit]);

  // 内核写完文件会连发多次 file.edited；收拢成一次刷新，新增文件不必手动点
  useEffect(() => {
    if (!pulse) return;
    const t = window.setTimeout(() => setVersion((v) => v + 1), 700);
    return () => window.clearTimeout(t);
  }, [pulse]);

  function refresh() {
    setVersion((v) => v + 1);
    // 手动刷新就直接重读，不等 version 那条 4 秒限流的排期
    void loadGit();
    onRefreshDiffs();
  }

  return (
    <aside className="files">
      <div className="fhead" data-tauri-drag-region="deep">
        <b>资源管理器</b>
        <span className="grow" />
        <button className="ico-btn" onClick={refresh} title="刷新" aria-label="刷新文件列表">
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
        <button className="ico-btn" onClick={onClose} title="收起文件栏" aria-label="收起文件栏">
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

      <div className="ftabs">
        <button className={tab === "tree" ? "on" : ""} onClick={() => setTab("tree")}>
          文件
        </button>
        <button className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}>
          改动
          {!!changedCount && <span className="cnt">{changedCount}</span>}
        </button>
      </div>

      {tab === "tree" ? (
        <div className="ftree">
          {err ? (
            <p className="fhint err">{err}</p>
          ) : entries === null ? (
            <p className="fhint">读取中…</p>
          ) : !entries.length ? (
            <p className="fhint">工作区里没有文件</p>
          ) : (
            <div key={root} className="ftree-root">
              {entries.map((e) =>
                e.dir ? (
                  <DirNode
                    key={e.path}
                    root={root}
                    entry={e}
                    depth={0}
                    version={version}
                    changed={changed}
                    onOpenFile={onOpenFile}
                  />
                ) : (
                  <FileRow
                    key={e.path}
                    root={root}
                    entry={e}
                    depth={0}
                    diff={changed.get(trimSlash(`${trimSlash(root)}/${e.path}`))}
                    onOpenFile={onOpenFile}
                  />
                ),
              )}
              {truncated && <p className="fhint">目录项过多，只显示前 4000 项</p>}
            </div>
          )}
        </div>
      ) : (
        <div className="ftree changes">
          {!wsDiffs.length && !gitChanges.length ? (
            <p className="fhint">{changesHint}</p>
          ) : (
            <>
              {!!wsDiffs.length && (
                <section>
                  {repo && <p className="fsec">本次会话</p>}
                  <ul className="chlist">
                    {wsDiffs.map((d) => {
                      const rel = relInRoot(root, d.file) ?? "";
                      const dir = dirName(rel);
                      return (
                        <li key={d.file}>
                          <button
                            className="chrow"
                            onClick={() => onOpenFile({ rel, abs: d.file, tab: "diff" })}
                            title={d.file}
                          >
                            <span className={`fx ${d.status ?? "modified"}`}>
                              {FSTATUS_CN[d.status ?? "modified"] ?? "M"}
                            </span>
                            <span className="cinfo">
                              <b>{baseName(d.file)}</b>
                              {dir && <span>{dir}</span>}
                            </span>
                            <span className="cnts">
                              {d.additions ? <span className="add">+{d.additions}</span> : null}
                              {d.deletions ? <span className="del">-{d.deletions}</span> : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
              {repo && !!gitChanges.length && (
                <section>
                  <p className="fsec">工作区未提交</p>
                  <ul className="chlist">
                    {gitChanges.map((c) => {
                      const abs = `${trimSlash(root)}/${c.path}`;
                      return (
                        <li key={`${c.path}:${c.index}${c.worktree}`}>
                          <button
                            className="chrow"
                            onClick={() => onOpenFile({ rel: c.path, abs, tab: "preview" })}
                            title={`${abs}${c.staged ? " · 已暂存" : ""}`}
                          >
                            <span className={`fx ${c.status === "untracked" ? "added" : c.status}`}>
                              {FSTATUS_CN[c.status] ?? "M"}
                            </span>
                            <span className="cinfo">
                              <b>{baseName(c.path)}</b>
                              <span>
                                {dirName(c.path)}
                                {c.staged ? `${dirName(c.path) ? " · " : ""}已暂存` : ""}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function DirNode({
  root,
  entry,
  depth,
  version,
  changed,
  onOpenFile,
}: {
  root: string;
  entry: Entry;
  depth: number;
  version: number;
  changed: Map<string, FileDiff>;
  onOpenFile: (f: OpenFile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<FileList | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    invoke<FileList>("files_list", { rel: entry.path, directory: root })
      .then((r) => {
        if (alive) setList(r);
      })
      .catch((e) => {
        if (alive) setErr(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, entry.path, version, root]);

  return (
    <div className="fdir">
      <button
        className={`frow ${open ? "open" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setOpen((o) => !o)}
        title={entry.path}
        aria-expanded={open}
      >
        <Chevron open={open} />
        <FolderIcon />
        <span className="fname">{entry.name}</span>
      </button>
      {open &&
        (err ? (
          <p className="fhint err" style={{ paddingLeft: 26 + depth * 14 }}>
            {err}
          </p>
        ) : loading && !list ? (
          <p className="fhint" style={{ paddingLeft: 26 + depth * 14 }}>
            读取中…
          </p>
        ) : list?.entries.map((e) =>
          e.dir ? (
            <DirNode
              key={e.path}
              root={root}
              entry={e}
              depth={depth + 1}
              version={version}
              changed={changed}
              onOpenFile={onOpenFile}
            />
          ) : (
            <FileRow
              key={e.path}
              root={root}
              entry={e}
              depth={depth + 1}
              diff={changed.get(trimSlash(`${trimSlash(root)}/${e.path}`))}
              onOpenFile={onOpenFile}
            />
          ),
        ))}
    </div>
  );
}

function FileRow({
  root,
  entry,
  depth,
  diff,
  onOpenFile,
}: {
  root: string;
  entry: Entry;
  depth: number;
  diff?: FileDiff;
  onOpenFile: (f: OpenFile) => void;
}) {
  return (
    <button
      className="frow file"
      style={{ paddingLeft: 8 + depth * 14 }}
      title={entry.path}
      onClick={() =>
        onOpenFile({
          rel: entry.path,
          abs: `${trimSlash(root)}/${entry.path}`,
          tab: "preview",
        })
      }
    >
      <span className="chev gap" />
      <FileIcon />
      <span className="fname">{entry.name}</span>
      <ChangeMark diff={diff} />
    </button>
  );
}

type QuickProps = {
  root: string;
  onClose: () => void;
  onPick: (rel: string) => void;
};

/** ⌘P 快捷打开：模糊匹配、ignore 规则全交给内核的 ripgrep 索引，壳不自己遍历目录 */
export function QuickOpen({ root, onClose, onPick }: QuickProps) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    box.current?.focus();
  }, []);

  useEffect(() => {
    const id = ++seq.current;
    const t = window.setTimeout(() => {
      setBusy(true);
      setErr(null);
      find
        .files(q, root, QUICK_LIMIT)
        .then((r) => {
          if (seq.current !== id) return;
          setRows(r);
          setSel(0);
        })
        .catch((e) => {
          if (seq.current !== id) return;
          setRows([]);
          setErr(String(e));
        })
        .finally(() => {
          if (seq.current === id) setBusy(false);
        });
    }, 120);
    return () => window.clearTimeout(t);
  }, [q, root]);

  // 方向键选中的那条要跟着进视野
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel, rows.length]);

  function onKey(e: React.KeyboardEvent) {
    // 中文输入法选词的回车不是「打开」
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (rows.length) setSel((i) => (i + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length) setSel((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = rows[sel];
      if (hit) onPick(hit);
    }
  }

  return (
    <div className="modal qomask" onClick={onClose}>
      <div className="panel qo" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="快捷打开文件">
        <div className="qoh">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M10.4 10.4L13.6 13.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={box}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="输入文件名，回车打开"
            aria-label="按文件名搜索"
            spellCheck={false}
          />
        </div>
        <div className="qolist" ref={list}>
          {err ? (
            <p className="fhint err">{err}</p>
          ) : !rows.length ? (
            <p className="fhint">{busy ? "搜索中…" : "没有匹配的文件"}</p>
          ) : (
            rows.map((p, i) => (
              <button
                key={p}
                data-i={i}
                className={`qorow ${i === sel ? "on" : ""}`}
                onClick={() => onPick(p)}
                onMouseMove={() => setSel(i)}
                title={`${trimSlash(root)}/${p}`}
              >
                <FileIcon />
                <b>{baseName(p)}</b>
                <span className="muted">{dirName(p)}</span>
              </button>
            ))
          )}
        </div>
        <footer className="qof">
          <span className="muted">↑↓ 选择 · ⏎ 打开 · Esc 关闭</span>
          <span className="muted">{baseName(root)}</span>
        </footer>
      </div>
    </div>
  );
}

type ViewerProps = {
  root: string;
  file: OpenFile;
  startTab: "preview" | "diff";
  diffs: FileDiff[];
  pulse: number;
  onClose: () => void;
  /** 还原成功后让外层重取 diff，否则「改动」页签还挂着刚被回滚掉的那一条 */
  onRestored?: () => void;
};
/** 行号与 +/- 标记是界面装饰：Cmd+C 时按选中的行重建纯文本，别把它们带进剪贴板 */
function cleanCopyText(root: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const box = document.createElement("div");
  box.append(range.cloneContents());
  const rows = box.querySelectorAll<HTMLElement>(".cl, .dline");
  if (!rows.length) return null;
  return Array.from(rows, (row) => {
    if (row.classList.contains("dline")) {
      const text = row.querySelector(".dtx")?.textContent ?? "";
      if (row.classList.contains("hunk")) return text;
      return `${row.querySelector(".dmk")?.textContent ?? ""}${text}`;
    }
    return row.querySelector(".tx")?.textContent ?? "";
  }).join("\n");
}

export function FileViewer({ root, file, startTab, diffs, pulse, onClose, onRestored }: ViewerProps) {
  const [tab, setTab] = useState<"preview" | "diff">(startTab);
  const [mdRaw, setMdRaw] = useState(false);
  const [data, setData] = useState<FileContent | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** 还原会直接覆盖磁盘上的文件，所以第一次点只把按钮变成确认态 */
  const [askRestore, setAskRestore] = useState(false);
  /** HEIC 这类系统 WebView 未必解得了的格式：解码失败就退回文字提示，别留个裂图标 */
  const [imgFail, setImgFail] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  /** pulse / 刷新按钮不走 effect cleanup，用序号丢掉过期回填 */
  const reqId = useRef(0);
  const dataRef = useRef<FileContent | null>(null);
  dataRef.current = data;

  const diff = useMemo(
    () => diffs.find((d) => samePath(d.file, file.abs)) ?? null,
    [diffs, file.abs],
  );

  const load = useCallback((soft = false) => {
    const id = ++reqId.current;
    if (!soft) {
      setBusy(true);
      setErr(null);
    }
    const req = file.plan
      ? invoke<FileContent>("plan_read", { path: file.abs, directory: root })
      : invoke<FileContent>("file_read", { rel: file.rel, directory: root });
    req
      .then((r) => {
        if (reqId.current !== id) return;
        // file.edited 后 mtime/size 未变就跳过，避免整文件重高亮
        const cur = dataRef.current;
        if (soft && cur && cur.mtime === r.mtime && cur.size === r.size) return;
        setImgFail(false);
        setData(r);
      })
      .catch((e) => {
        if (reqId.current === id && !soft) {
          setData(null);
          setErr(String(e));
        }
      })
      .finally(() => {
        if (reqId.current === id) setBusy(false);
      });
  }, [file.rel, file.abs, file.plan, root]);

  useEffect(() => {
    setTab(startTab);
    setMdRaw(false);
  }, [file.abs, startTab]);

  useEffect(() => {
    setData(null);
    setErr(null);
    setImgFail(false);
    load(false);
    return () => {
      reqId.current += 1;
    };
  }, [load]);

  // 文件正在被 agent 写：跟 file.edited 一起刷新预览，别让用户对着旧内容
  useEffect(() => {
    if (!pulse) return;
    const t = window.setTimeout(() => load(true), 700);
    return () => window.clearTimeout(t);
  }, [pulse, load]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // copy 事件落在焦点元素上，不一定冒泡到正文；挂在 document 上才不会漏
  useEffect(() => {
    const onCopy = (e: globalThis.ClipboardEvent) => {
      const root = bodyRef.current;
      if (!root || !e.clipboardData) return;
      const text = cleanCopyText(root);
      if (text === null) return;
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(file.abs);
      setNote("路径已复制");
      window.setTimeout(() => setNote(null), 1600);
    } catch (e) {
      setErr(`复制失败：${e}`);
    }
  }

  /**
   * 还原为改动前：内核的 diff 带了 before 全文，把它写回去就等于回滚这一个文件。
   * status=added 表示改动前它根本不存在，这种情况还原就是删除；
   * 没有 before 字段（二进制、只给了统计）时不给入口。
   */
  const canRestore = !!diff && (diff.status === "added" || typeof diff.before === "string");

  async function doRestore() {
    if (!diff) return;
    setAskRestore(false);
    setErr(null);
    setNote(null);
    const wipe = diff.status === "added";
    try {
      const msg = await restoreFile(file.rel, wipe ? null : (diff.before ?? ""), root);
      setNote(msg);
      load(false);
      onRestored?.();
      window.setTimeout(() => setNote(null), 3200);
    } catch (e) {
      setErr(String(e));
    }
  }

  // 搜索跳过来的一律看源码：Markdown 渲染后的 DOM 没有行号可对
  const markdown =
    tab === "preview" && isMd(file.rel) && !!data && !data.binary && data.content !== null && !file.line;

  return (
    <div
      className="modal"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // 从正文拖选到面板外时，click 的 target 也会落到遮罩上；只认从遮罩按下的关闭
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="panel fileview"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`预览 ${file.rel}`}
      >
        <header className="fvhead" data-tauri-drag-region="deep">
          <div className="fvinfo">
            <b>{file.plan ? planTitle(file.rel) : baseName(file.rel)}</b>
            <span className="muted small" title={file.abs}>
              {file.plan ? file.abs : `${trimSlash(root)}/${file.rel}`}
              {data ? ` · ${fmtSize(data.size)}` : ""}
            </span>
          </div>
          <div className="row fvacts">
            {note && <span className="muted small">{note}</span>}
            {tab === "diff" && canRestore && (
              <button
                className={`restorebtn ${askRestore ? "ask" : ""}`}
                onClick={() => (askRestore ? void doRestore() : setAskRestore(true))}
                onBlur={() => setAskRestore(false)}
                title={
                  diff?.status === "added"
                    ? "这份文件是这一轮新建的，还原等于删掉它"
                    : "把这个文件写回本轮改动之前的内容"
                }
              >
                {askRestore
                  ? diff?.status === "added"
                    ? "确认删除？"
                    : "确认还原？"
                  : diff?.status === "added"
                    ? "删除此文件"
                    : "还原为改动前"}
              </button>
            )}
            {markdown && (
              <button
                className={`ico-btn ${mdRaw ? "on" : ""}`}
                onClick={() => setMdRaw((v) => !v)}
                aria-pressed={mdRaw}
                title={mdRaw ? "显示渲染效果" : "显示 Markdown 原文"}
                aria-label={mdRaw ? "显示渲染效果" : "显示 Markdown 原文"}
              >
                {mdRaw ? (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M4 2.6h5.4L12.4 5v8.4H4z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M6 7.4h4M6 9.6h4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M6 4.5L2.8 8 6 11.5M10 4.5L13.2 8 10 11.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            )}
            <button className="ico-btn" onClick={copyPath} title="复制完整路径" aria-label="复制完整路径">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              className="ico-btn"
              onClick={() => void revealItemInDir(file.abs).catch((e) => setErr(String(e)))}
              title="在访达中显示"
              aria-label="在访达中显示"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M1.5 4.3A1.5 1.5 0 0 1 3 2.8h2.9l1.4 1.6H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13.4H3a1.5 1.5 0 0 1-1.5-1.5z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            </button>
            <button className="ico-btn" onClick={() => load(false)} title="重新读取" aria-label="重新读取">
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
            <button className="ico-btn" onClick={onClose} title="关闭" aria-label="关闭预览">
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
        </header>

        <div className="fvtabs">
          <button className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>
            预览
          </button>
          {!file.plan && (
            <button className={tab === "diff" ? "on" : ""} onClick={() => setTab("diff")}>
              Diff
              {!!diff && (diff.additions || diff.deletions) && (
                <span className="dstat">
                  <span className="add">+{diff.additions ?? 0}</span>{" "}
                  <span className="del">-{diff.deletions ?? 0}</span>
                </span>
              )}
            </button>
          )}
          {busy && data && <span className="muted small fvbusy">刷新中…</span>}
        </div>

        <div className="fvbody" ref={bodyRef}>
          {tab === "preview" ? (
            err ? (
              <p className="fhint err">{err}</p>
            ) : !data ? (
              <p className="fhint">读取中…</p>
            ) : data.dataUrl && !imgFail ? (
              <div className="fvimg">
                <img
                  src={data.dataUrl}
                  alt={baseName(file.rel)}
                  onError={() => setImgFail(true)}
                />
              </div>
            ) : data.mime ? (
              <p className="fhint">
                {imgFail
                  ? "这张图的格式系统解不了，可以「在访达中显示」用系统预览打开。"
                  : `图片太大（${fmtSize(data.size)}），不在预览里打开。`}
              </p>
            ) : data.binary ? (
              <p className="fhint">这是二进制文件（{fmtSize(data.size)}），不做文本预览。</p>
            ) : data.content === null ? (
              <p className="fhint">没有可显示的内容</p>
            ) : markdown && !mdRaw ? (
              <MdView text={data.content} rel={file.rel} truncated={data.truncated} />
            ) : (
              <CodeView
                text={data.content}
                rel={file.rel}
                truncated={data.truncated}
                focusLine={file.line}
              />
            )
          ) : (
            <DiffView row={diff} rel={file.rel} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Shiki 完全按需加载；失败或超大文件就退回纯文本，不影响预览本身 */
function useHighlighted(text: string, rel: string, enabled: boolean) {
  // 高亮结果是逐 token 的具体颜色，切主题必须重算，否则深色底上还是浅色语法色
  const theme = useResolvedTheme();
  const [state, setState] = useState<{
    text: string;
    rel: string;
    theme: ResolvedTheme;
    tokens: ThemedToken[][] | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    import("./highlight")
      .then((m) => m.highlight(text, rel, theme))
      .then((tokens) => {
        if (alive) setState({ text, rel, theme, tokens });
      })
      .catch((e) => {
        console.warn("语法高亮失败，退回纯文本", e);
        if (alive) setState({ text, rel, theme, tokens: null });
      });
    return () => {
      alive = false;
    };
  }, [text, rel, enabled, theme]);

  return enabled && state && state.text === text && state.rel === rel && state.theme === theme
    ? state.tokens
    : null;
}

function tokenStyle(t: ThemedToken): React.CSSProperties | undefined {
  const fs = Math.max(t.fontStyle ?? 0, 0);
  const style: React.CSSProperties = {};
  if (t.color) style.color = t.color;
  if (fs & 1) style.fontStyle = "italic";
  if (fs & 2) style.fontWeight = 600;
  if (fs & 4) style.textDecoration = "underline";
  return Object.keys(style).length ? style : undefined;
}

/** 逐 token 渲染而不是塞 HTML：复制仍读到干净的 textContent */
function Tokens({ tokens, text }: { tokens?: ThemedToken[]; text: string }) {
  if (!tokens?.length) return <>{text}</>;
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={tokenStyle(t)}>
          {t.content}
        </span>
      ))}
    </>
  );
}

/**
 * 滚动估算的三个基准。行高必须与 .fvcode 的 12px/1.55 对齐（18.6px），
 * 否则每行 0.4px 的误差累到几千行就是上千像素的空窗。
 */
const CODE_LINE_PX = 18.6;
/** .no 的 54px + .tx 的 24px 右内边距，扣掉之后才是排版宽度 */
const CODE_GUTTER_PX = 78;
const CODE_OVERSCAN = 48;
/** .fvcode 的上内边距，滚动坐标要减掉它才能对上第一条线 */
const CODE_PAD_TOP = 8;

/** 折行按“终端列”算：制表符补到 8 的倍数，全角字符占两列 */
function visualCols(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === "\t") n += 8 - (n % 8);
    else if (
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff)
    )
      n += 2;
    else n += 1;
  }
  return n;
}

/** 实测等宽字符宽度和行高：字号、字体被系统改过也能对上，测不到就退回常量 */
function measureMono(el: HTMLElement | null): { char: number; line: number } {
  if (!el) return { char: 7.2, line: CODE_LINE_PX };
  try {
    const cs = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return { char: 7.2, line: CODE_LINE_PX };
    ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
    const char = ctx.measureText("0").width;
    return {
      char: char > 1 ? char : 7.2,
      line: parseFloat(cs.lineHeight) || CODE_LINE_PX,
    };
  } catch {
    return { char: 7.2, line: CODE_LINE_PX };
  }
}

function CodeView({
  text,
  rel,
  truncated,
  focusLine,
}: {
  text: string;
  rel: string;
  truncated: boolean;
  focusLine?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState({ start: 0, end: 160 });
  const [box, setBox] = useState({ width: 0, char: 0, line: CODE_LINE_PX });
  const lines = useMemo(() => {
    const all = text.split("\n");
    if (all.length && all[all.length - 1] === "") all.pop();
    return all;
  }, [text]);
  const shown = useMemo(() => lines.slice(0, MAX_LINES), [lines]);

  /** 每行顶部的累计偏移：折行行数由实测字宽推出，长行走不了固定行高 */
  const offs = useMemo(() => {
    const off = new Float64Array(shown.length + 1);
    const cols = box.width > 0 && box.char > 0 ? Math.max(1, Math.floor(box.width / box.char)) : 0;
    for (let i = 0; i < shown.length; i++) {
      const rows = cols ? Math.max(1, Math.ceil(visualCols(shown[i]) / cols)) : 1;
      off[i + 1] = off[i] + rows * box.line;
    }
    return off;
  }, [shown, box]);

  /** 给定滚动位置，二分出落在哪一行 */
  const at = useCallback(
    (y: number) => {
      let lo = 0;
      let hi = shown.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offs[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [offs, shown.length],
  );

  // 字体、字号或窗宽变化都要重算基准，否则窗口会飘
  useEffect(() => {
    const scroller = host.current?.closest(".fvbody") as HTMLElement | null;
    if (!scroller) return;
    const sync = () => {
      const m = measureMono(host.current);
      const width = Math.max(0, scroller.clientWidth - CODE_GUTTER_PX);
      setBox((b) =>
        b.width === width && Math.abs(b.char - m.char) < 0.01 && b.line === m.line
          ? b
          : { width, char: m.char, line: m.line },
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const scroller = host.current?.closest(".fvbody") as HTMLElement | null;
    if (!scroller) return;
    // 搜索跳行：先滚到目标行附近，再按新的滚动位置算渲染窗口
    if (focusLine && focusLine <= shown.length) {
      scroller.scrollTop = Math.max(
        0,
        CODE_PAD_TOP + offs[focusLine - 1] - scroller.clientHeight / 3,
      );
    }
    const onScroll = () => {
      const top = Math.max(0, scroller.scrollTop - CODE_PAD_TOP);
      const start = Math.max(0, at(top) - CODE_OVERSCAN);
      const end = Math.min(shown.length, at(top + scroller.clientHeight) + 1 + CODE_OVERSCAN);
      setWin((w) => (w.start === start && w.end === end ? w : { start, end }));
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [shown.length, focusLine, at, offs]);

  const slice = shown.slice(win.start, win.end);
  const sliceText = slice.join("\n");
  const tokens = useHighlighted(
    sliceText,
    rel,
    slice.length > 0 && sliceText.length <= MAX_HIGHLIGHT_CHARS,
  );
  if (!lines.length) return <p className="fhint">空文件</p>;
  return (
    <>
      <div
        className="fvcode"
        ref={host}
        style={{
          paddingTop: CODE_PAD_TOP + offs[win.start],
          paddingBottom: 14 + Math.max(0, offs[shown.length] - offs[win.end]),
        }}
      >
        {slice.map((line, i) => (
          <div
            className={`cl ${win.start + i + 1 === focusLine ? "hit" : ""}`}
            key={win.start + i}
            style={{ minHeight: box.line }}
          >
            <span className="no">{win.start + i + 1}</span>
            <span className="tx">
              <Tokens tokens={tokens?.[i]} text={line} />
            </span>
          </div>
        ))}
      </div>
      {(lines.length > MAX_LINES || truncated) && (
        <p className="fhint pad">
          {lines.length > MAX_LINES
            ? `文件较长，只渲染前 ${MAX_LINES} 行`
            : "文件超过 2 MB，内容已截断"}
        </p>
      )}
    </>
  );
}

/** Markdown 预览：外链交给系统浏览器，相对链接只挡住默认跳转 */
function openMarkdownLinks(e: React.MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    void openUrl(href).catch((err) => console.warn("打开链接失败", err));
  }
}

/** Markdown 渲染整棵 DOM，没有虚拟滚动 */
function MdView({ text, rel, truncated }: { text: string; rel: string; truncated: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (text.length > MAX_MD_CHARS) {
      setFailed(true);
      return;
    }
    let alive = true;
    setFailed(false);
    renderMarkdown(text)
      .then((h) => {
        if (alive) setHtml(h);
      })
      .catch((e) => {
        console.warn("Markdown 渲染失败，退回原文", e);
        if (alive) setHtml(null);
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [text, renderMarkdown]);

  if (failed) return <CodeView text={text} rel={rel} truncated={truncated} />;
  if (!html) return <p className="fhint">渲染中…</p>;
  return (
    <>
      <div
        className="md"
        onClick={openMarkdownLinks}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {truncated && <p className="fhint pad">文件超过 2 MB，内容已截断</p>}
    </>
  );
}

function DiffView({ row, rel }: { row: FileDiff | null; rel: string }) {
  const patch = useMemo(() => {
    if (!row) return { kind: "none" as const };
    if (typeof row.before !== "string" || typeof row.after !== "string") {
      return { kind: "no-baseline" as const };
    }
    if (row.before.length + row.after.length > MAX_DIFF_CHARS) {
      return { kind: "big" as const };
    }
    return {
      kind: "ok" as const,
      hunks: structuredPatch(rel, rel, row.before, row.after, "", "", { context: 4 }).hunks,
    };
  }, [row, rel]);

  // 只高亮 hunk 里真正出现的行，避免对整份 before/after 做 Shiki
  const hunkHL = useMemo(() => {
    if (patch.kind !== "ok") {
      return {
        before: "",
        after: "",
        oldAt: new Map<number, number>(),
        newAt: new Map<number, number>(),
      };
    }
    const oldAt = new Map<number, number>();
    const newAt = new Map<number, number>();
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const h of patch.hunks) {
      for (const r of hunkRows(h)) {
        if (r.kind === "del" || r.kind === "same") {
          oldAt.set(Number(r.oldNo) - 1, oldLines.length);
          oldLines.push(r.text);
        }
        if (r.kind === "add" || r.kind === "same") {
          newAt.set(Number(r.newNo) - 1, newLines.length);
          newLines.push(r.text);
        }
      }
    }
    return { before: oldLines.join("\n"), after: newLines.join("\n"), oldAt, newAt };
  }, [patch]);

  const canHighlight =
    patch.kind === "ok" && hunkHL.before.length + hunkHL.after.length <= MAX_HIGHLIGHT_CHARS;
  const beforeTokens = useHighlighted(hunkHL.before, rel, canHighlight);
  const afterTokens = useHighlighted(hunkHL.after, rel, canHighlight);

  const tokensFor = (r: DiffRow) => {
    if (r.kind === "del") {
      const i = hunkHL.oldAt.get(Number(r.oldNo) - 1);
      return i != null ? beforeTokens?.[i] : undefined;
    }
    const ni = hunkHL.newAt.get(Number(r.newNo) - 1);
    if (ni != null && afterTokens?.[ni]) return afterTokens[ni];
    if (r.kind === "same") {
      const oi = hunkHL.oldAt.get(Number(r.oldNo) - 1);
      return oi != null ? beforeTokens?.[oi] : undefined;
    }
    return undefined;
  };

  if (patch.kind === "none") {
    return (
      <p className="fhint">
        {row ? "这个文件没有改动记录" : "当前会话还没有这个文件的改动记录。换个文件，或等这一轮结束再看。"}
      </p>
    );
  }
  if (patch.kind === "no-baseline") {
    return <p className="fhint">内核没有返回这个文件改动前后的内容，无法生成 diff。</p>;
  }
  if (patch.kind === "big") {
    return <p className="fhint">改动前后内容超过 80 万字符，界面不展开 diff；可先看「预览」。</p>;
  }
  if (!patch.hunks.length) {
    return <p className="fhint">改动前后内容一致。</p>;
  }

  let rendered = 0;
  return (
    <>
      <div className="fvdiff">
        {patch.hunks.map((h, hi) => {
          const rows = hunkRows(h);
          const remain = 10_000 - rendered;
          if (remain <= 0) return null;
          const visible = rows.slice(0, remain);
          rendered += visible.length;
          return (
            <div className="dhunk" key={hi}>
              <div className="dline hunk">
                <span className="dno" />
                <span className="dno" />
                <span className="dmk" />
                <span className="dtx">{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`}</span>
              </div>
              {visible.map((r, ri) => (
                <div className={`dline ${r.kind}`} key={ri}>
                  <span className="dno">{r.oldNo}</span>
                  <span className="dno">{r.newNo}</span>
                  <span className="dmk">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}</span>
                  <span className="dtx">
                    <Tokens tokens={tokensFor(r)} text={r.text} />
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {rendered >= 10_000 && <p className="fhint pad">diff 较长，只渲染前 10000 行</p>}
      <p className="fhint pad">
        当前会话改动快照
        {row?.status ? ` · ${FSTATUS_CN[row.status] ?? row.status}` : ""}
        {typeof row?.additions === "number" ? ` · +${row.additions} -${row.deletions ?? 0}` : ""}
      </p>
    </>
  );
}

type DiffRow = {
  kind: "same" | "add" | "del";
  oldNo: string;
  newNo: string;
  text: string;
};

function hunkRows(h: StructuredPatchHunk): DiffRow[] {
  let oldNo = h.oldStart;
  let newNo = h.newStart;
  const rows: DiffRow[] = [];
  for (const line of h.lines) {
    const mark = line[0];
    const text = line.slice(1);
    if (mark === "+") {
      rows.push({ kind: "add", oldNo: "", newNo: String(newNo++), text });
    } else if (mark === "-") {
      rows.push({ kind: "del", oldNo: String(oldNo++), newNo: "", text });
    } else if (mark === "\\") {
      // "\ No newline at end of file" 不是一行正文
      continue;
    } else {
      rows.push({ kind: "same", oldNo: String(oldNo++), newNo: String(newNo++), text });
    }
  }
  return rows;
}
