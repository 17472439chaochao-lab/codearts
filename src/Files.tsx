import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { structuredPatch, type StructuredPatchHunk } from "diff";
import type { FileDiff, FindMatch, Session } from "./kernelApi";
import { find } from "./kernelApi";
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
};
type PlanEntry = {
  name: string;
  path: string;
  source: "workspace" | "kernel" | "project";
  size: number;
  mtime: number;
};

const FSTATUS_CN: Record<string, string> = { added: "A", deleted: "D", modified: "M" };
const PLAN_SOURCE_CN: Record<string, string> = {
  workspace: "工作区",
  kernel: "内核数据",
  project: "项目目录",
};
const MAX_LINES = 5000;
/** 改动前后加起来超过这个量就不在 WebView 里算逐行 diff，避免整窗卡死 */
const MAX_DIFF_CHARS = 800_000;
/** 高亮是纯前端增强：再大的文本就保持纯文本，别为了配色卡住主线程 */
const MAX_HIGHLIGHT_CHARS = 300_000;
/** Markdown 渲染整棵 DOM，没有虚拟滚动；超过这个长度直接给原文 */
const MAX_MD_CHARS = 300_000;
/** 全文搜索一页最多渲染多少条匹配（内核不截，WebView 得自己收） */
const SEARCH_ROWS = 300;
/** 快捷打开的结果条数 */
const QUICK_LIMIT = 40;
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

/**
 * 内核 `/find` 的 submatch 偏移是 ripgrep 的 UTF-8 字节下标；
 * 行内有非 ASCII 时字节下标和 JS 下标会错开（实测「资源管理器」差 4），先换成字符下标再切片。
 */
function charRanges(line: string, subs: FindMatch["submatches"]): [number, number][] {
  if (!subs.length) return [];
  const bytes = new TextEncoder().encode(line);
  const dec = new TextDecoder();
  const at = (n: number) => dec.decode(bytes.subarray(0, Math.min(n, bytes.length))).length;
  return subs.map((s) => [at(s.start), at(s.end)]);
}

/** 按文件分组：内核按匹配顺序平铺返回，同一文件的连续命中要并成一段 */
type SearchGroup = { path: string; rows: { line: number; text: string; ranges: [number, number][] }[] };

function groupHits(hits: FindMatch[], limit: number) {
  const groups: SearchGroup[] = [];
  let rows = 0;
  for (const h of hits) {
    if (rows >= limit) break;
    const text = h.lines.text.replace(/\r?\n$/, "");
    const row = { line: h.line_number, text, ranges: charRanges(text, h.submatches) };
    const last = groups[groups.length - 1];
    if (last && last.path === h.path.text) last.rows.push(row);
    else groups.push({ path: h.path.text, rows: [row] });
    rows += 1;
  }
  return { groups, rows, truncated: hits.length > rows };
}

/** 一行里把命中片段套上高亮；没有 submatch（例如只按文件命中）就整行原样输出 */
function HitLine({ row }: { row: SearchGroup["rows"][number] }) {
  if (!row.ranges.length) return <>{row.text}</>;
  const out: React.ReactNode[] = [];
  let cur = 0;
  for (const [s, e] of row.ranges) {
    if (s > cur) out.push(row.text.slice(cur, s));
    out.push(<i key={`${s}-${e}`}>{row.text.slice(s, Math.max(e, s))}</i>);
    cur = Math.max(cur, e);
  }
  if (cur < row.text.length) out.push(row.text.slice(cur));
  return <>{out}</>;
}

/** 内核用 `<会话创建时间>-<slug>.md` 命名，时间戳没有展示价值 */
const planTitle = (name: string) => name.replace(/\.md$/i, "").replace(/^\d{10,}-/, "");

/** 规划模式写 `<feature>/plan.md`；文件名本身没信息量时用目录名 */
const planLabel = (p: PlanEntry) => {
  const title = planTitle(p.name);
  if (title.toLowerCase() !== "plan") return title;
  const parts = p.path.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : title;
};

function fmtWhen(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
  /** ⌘⇧F 递增一次：切到搜索页签并把光标放到输入框 */
  focusSearch: number;
  onOpenFile: (f: OpenFile) => void;
  onRefreshDiffs: () => void;
  onClose: () => void;
};

export function FilePanel({
  root,
  session,
  diffs,
  pulse,
  focusSearch,
  onOpenFile,
  onRefreshDiffs,
  onClose,
}: PanelProps) {
  const [tab, setTab] = useState<"tree" | "changes" | "plans" | "search">("tree");
  const [version, setVersion] = useState(0);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanEntry[] | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [hits, setHits] = useState<FindMatch[] | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const searchBox = useRef<HTMLInputElement | null>(null);
  /** 内核 /find 没有 limit，宽模式一次能回几千条，靠序号丢掉迟到的旧结果 */
  const searchSeq = useRef(0);

  const wsDiffs = useMemo(
    () => diffs.filter((d) => relInRoot(root, d.file) !== null),
    [diffs, root],
  );
  const changed = useMemo(() => {
    const m = new Map<string, FileDiff>();
    for (const d of wsDiffs) m.set(trimSlash(d.file), d);
    return m;
  }, [wsDiffs]);
  const grouped = useMemo(() => groupHits(hits ?? [], SEARCH_ROWS), [hits]);

  /** 技能写的计划就在工作区里，展示相对目录比"项目目录"四个字有用 */
  const planWhere = (p: PlanEntry) => {
    const rel = p.source === "project" ? relInRoot(root, p.path) : null;
    if (rel) return rel.replace(/\/[^/]*$/, "");
    return PLAN_SOURCE_CN[p.source] ?? p.source;
  };

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

  const loadPlans = useCallback(() => {
    let alive = true;
    setPlanErr(null);
    invoke<PlanEntry[]>("plans_list", { directory: root })
      .then((r) => {
        if (alive) setPlans(r);
      })
      .catch((e) => {
        if (alive) setPlanErr(String(e));
      });
    return () => {
      alive = false;
    };
  }, [root]);

  // 换工作区先清掉旧树，别让两层文件混在一起
  useEffect(() => {
    setEntries(null);
    setTruncated(false);
    setPlans(null);
    setHits(null);
    setSearchErr(null);
  }, [root]);
  useEffect(() => loadRoot(), [loadRoot, version]);

  // 计划文件由 agent 增量写入，跟 file.edited 的 version 一起刷新；只看当前页签，别空转
  useEffect(() => {
    if (tab !== "plans") return;
    return loadPlans();
  }, [tab, loadPlans, version, root, session?.id]);

  const runSearch = useCallback(
    (p: string) => {
      const pat = p.trim();
      const id = ++searchSeq.current;
      if (pat.length < 2) {
        setHits(null);
        setSearchErr(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      setSearchErr(null);
      find
        .text(pat, root)
        .then((r) => {
          if (searchSeq.current === id) setHits(r);
        })
        .catch((e) => {
          if (searchSeq.current !== id) return;
          setHits(null);
          setSearchErr(String(e));
        })
        .finally(() => {
          if (searchSeq.current === id) setSearching(false);
        });
    },
    [root],
  );

  // 每敲一个字就打一次 ripgrep 没必要，停手 350ms 再查；只看当前页签
  useEffect(() => {
    if (tab !== "search") return;
    const t = window.setTimeout(() => runSearch(pattern), 350);
    return () => window.clearTimeout(t);
  }, [tab, pattern, runSearch]);

  // ⌘⇧F：切到搜索页签并把光标放进输入框（刚切过去时 input 还没挂载，等一帧）
  useEffect(() => {
    if (!focusSearch) return;
    setTab("search");
    const t = window.setTimeout(() => searchBox.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [focusSearch]);

  // 内核写完文件会连发多次 file.edited；收拢成一次刷新，新增文件不必手动点
  useEffect(() => {
    if (!pulse) return;
    const t = window.setTimeout(() => setVersion((v) => v + 1), 700);
    return () => window.clearTimeout(t);
  }, [pulse]);

  function refresh() {
    setVersion((v) => v + 1);
    onRefreshDiffs();
  }

  return (
    <aside className="files">
      <div className="fhead" data-tauri-drag-region="deep">
        <b>资源管理器</b>
        <span className="muted small fws" title={root}>
          {baseName(root)}
        </span>
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
        <button className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>
          搜索
        </button>
        <button className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}>
          改动
          {!!wsDiffs.length && <span className="cnt">{wsDiffs.length}</span>}
        </button>
        <button className={tab === "plans" ? "on" : ""} onClick={() => setTab("plans")}>
          计划
          {!!plans?.length && <span className="cnt">{plans.length}</span>}
        </button>
      </div>

      {tab === "search" ? (
        <div className="ftree fsearch">
          <div className="sbox">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path
                d="M10.4 10.4L13.6 13.6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
            <input
              ref={searchBox}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch(pattern);
              }}
              placeholder="在工作区里搜索（正则，区分大小写）"
              aria-label="工作区全文搜索"
              spellCheck={false}
            />
          </div>
          {searchErr ? (
            <p className="fhint err">{searchErr}</p>
          ) : searching ? (
            <p className="fhint">搜索中…</p>
          ) : pattern.trim().length < 2 ? (
            <p className="fhint">至少两个字符；ignore 规则与内核一致</p>
          ) : !hits?.length ? (
            <p className="fhint">没有匹配</p>
          ) : (
            <>
              <p className="fhint smeta">
                {grouped.rows} / {hits.length} 处匹配 · {grouped.groups.length} 个文件
              </p>
              <ul className="slist">
                {grouped.groups.map((g) => (
                  <li key={g.path} className="sgroup">
                    <div className="spath" title={`${trimSlash(root)}/${g.path}`}>
                      <FileIcon />
                      <b>{baseName(g.path)}</b>
                      <span className="muted">{dirName(g.path)}</span>
                    </div>
                    {g.rows.map((r) => (
                      <button
                        key={`${g.path}:${r.line}`}
                        className="srow"
                        onClick={() =>
                          onOpenFile({
                            rel: g.path,
                            abs: `${trimSlash(root)}/${g.path}`,
                            tab: "preview",
                            line: r.line,
                          })
                        }
                      >
                        <span className="slno">{r.line}</span>
                        <span className="sltx">
                          <HitLine row={r} />
                        </span>
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
              {grouped.truncated && (
                <p className="fhint">
                  结果过多，只列出前 {grouped.rows} 条；缩小范围或加上更具体的模式
                </p>
              )}
            </>
          )}
        </div>
      ) : tab === "tree" ? (
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
      ) : tab === "changes" ? (
        <div className="ftree changes">
          {!wsDiffs.length ? (
            <p className="fhint">
              {session ? "当前会话还没有文件改动" : "打开一个会话后显示它改过的文件"}
            </p>
          ) : (
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
          )}
        </div>
      ) : (
        <div className="ftree changes">
          {planErr ? (
            <p className="fhint err">{planErr}</p>
          ) : plans === null ? (
            <p className="fhint">读取中…</p>
          ) : !plans.length ? (
            <p className="fhint">
              还没有计划。点输入区左下的「规划」开关，让 agent 先出计划再动手
            </p>
          ) : (
            <ul className="chlist">
              {plans.map((p) => (
                <li key={p.path}>
                  <button
                    className="chrow"
                    onClick={() =>
                      // rel 保留 .md，给 highlight 认语言；标题仍用 planTitle 展示
                      onOpenFile({ rel: p.name, abs: p.path, tab: "preview", plan: true })
                    }
                    title={p.path}
                  >
                    <FileIcon />
                    <span className="cinfo">
                      <b>{planLabel(p)}</b>
                      <span>
                        {planWhere(p)}
                        {p.mtime ? ` · ${fmtWhen(p.mtime)}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
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

export function FileViewer({ root, file, startTab, diffs, pulse, onClose }: ViewerProps) {
  const [tab, setTab] = useState<"preview" | "diff">(startTab);
  const [mdRaw, setMdRaw] = useState(false);
  const [data, setData] = useState<FileContent | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
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
  const [state, setState] = useState<{
    text: string;
    rel: string;
    tokens: ThemedToken[][] | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    import("./highlight")
      .then((m) => m.highlight(text, rel))
      .then((tokens) => {
        if (alive) setState({ text, rel, tokens });
      })
      .catch((e) => {
        console.warn("语法高亮失败，退回纯文本", e);
        if (alive) setState({ text, rel, tokens: null });
      });
    return () => {
      alive = false;
    };
  }, [text, rel, enabled]);

  return enabled && state && state.text === text && state.rel === rel ? state.tokens : null;
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

/** 与 .fvcode 的 12px/1.55 对齐，做滚动窗口估算 */
const CODE_LINE_PX = 19;
const CODE_OVERSCAN = 48;

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
  const lines = useMemo(() => {
    const all = text.split("\n");
    if (all.length && all[all.length - 1] === "") all.pop();
    return all;
  }, [text]);
  const shown = lines.slice(0, MAX_LINES);

  useEffect(() => {
    const scroller = host.current?.closest(".fvbody") as HTMLElement | null;
    if (!scroller) return;
    // 搜索跳行：先滚到目标行附近，再按新的滚动位置算渲染窗口
    if (focusLine && focusLine <= shown.length) {
      scroller.scrollTop = Math.max(0, (focusLine - 1) * CODE_LINE_PX - scroller.clientHeight / 3);
    }
    const onScroll = () => {
      const start = Math.max(0, Math.floor(scroller.scrollTop / CODE_LINE_PX) - CODE_OVERSCAN);
      const end = Math.min(
        shown.length,
        Math.ceil((scroller.scrollTop + scroller.clientHeight) / CODE_LINE_PX) + CODE_OVERSCAN,
      );
      setWin((w) => (w.start === start && w.end === end ? w : { start, end }));
    };
    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [shown.length, focusLine]);

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
          paddingTop: 8 + win.start * CODE_LINE_PX,
          paddingBottom: 14 + Math.max(0, shown.length - win.end) * CODE_LINE_PX,
        }}
      >
        {slice.map((line, i) => (
          <div
            className={`cl ${win.start + i + 1 === focusLine ? "hit" : ""}`}
            key={win.start + i}
            style={{ minHeight: CODE_LINE_PX }}
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
