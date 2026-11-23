import { Fragment, memo, useEffect, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import type { FileDiff, Message, Part, Todo } from "../../kernelApi";
import { isSyntheticPart } from "../../kernelApi";
import { ChatMarkdown } from "../../ChatMarkdown";
import { baseName } from "../../workspaceUtils";
import { ToolRun, type RunItem } from "./ToolViews";
import { TurnTodo } from "./TodoView";

export const FSTATUS_CN: Record<string, string> = { added: "A", deleted: "D", modified: "M" };

export function fmtNum(n: number, d = 0): string {
  if (n < 1000) return d > 0 ? n.toFixed(d) : String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}m`;
}

export function fmtSpan(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m${s ? `${s}s` : ""}`;
}

export function label(i: Message["info"]): string {
  if (i.role === "user") return "你";
  if (i.model?.modelID) return i.model.modelID;
  if (i.modelID) return i.modelID;
  return i.agent ?? "CodeArts";
}

/** 处理中秒数放在叶子里，避免每秒拖整棵 Chat 重绘 */
export function BusyHint({
  waitingPerm,
  waitingAsk,
  retry,
  activity,
}: {
  waitingPerm: boolean;
  waitingAsk: boolean;
  retry: { attempt: number; message: string } | null;
  activity: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    setElapsed(0);
    const iv = window.setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(iv);
  }, []);
  const text = waitingPerm
    ? "等待你在下方授权…"
    : waitingAsk
      ? "等待你在下方回答…"
      : retry
        ? `自动重试中（第 ${retry.attempt} 次）：${retry.message}`
        : `内核处理中 ${fmtSpan(elapsed)} · ${activity}`;
  return (
    <p className="hint busy">
      <span className="pulse" />
      {text}
    </p>
  );
}

export function cleanUserPromptText(text?: string): string {
  if (!text) return "";
  return text
    .replace(
      /\[ImageId:[^\]]+\]\[ImageName:[^\]]*\]\[ImagePath:[^\]]*\]\s*This is an image\.[\s\S]*?(?:Otherwise, Do not invoke analyzeImage tool|$)/g,
      "",
    )
    .replace(/\n*【附图(?:识别)?内容】[\s\S]*$/g, "")
    .replace(/\n*【图片 \d+ 的本地 OCR 文字】[\s\S]*$/g, "")
    .trim();
}

export const Block = memo(function Block({
  part,
  assistant = false,
  streaming = false,
}: {
  part: Part;
  assistant?: boolean;
  streaming?: boolean;
}) {
  switch (part.type) {
    case "text": {
      if (isSyntheticPart(part)) return null;
      if (assistant) {
        return <ChatMarkdown text={part.text ?? ""} streaming={streaming} />;
      }
      const userText = cleanUserPromptText(part.text);
      return userText ? <pre className="text">{userText}</pre> : null;
    }
    case "file": {
      const url = String(part.url ?? "");
      const name = part.filename ?? "图片附件";
      if (
        (String(part.mime ?? "").startsWith("image/") || url.startsWith("data:image/")) &&
        (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("http"))
      ) {
        return <img className="partimg" src={url} alt={name} title={name} />;
      }
      return <p className="hint">附件：{name && name !== "图片附件" ? name : url}</p>;
    }
    case "agent": {
      const nm = String((part as any).name ?? "");
      return nm ? <p className="hint">@ {nm}</p> : null;
    }
    case "subtask": {
      const st = part as any;
      const line = String(st.description || st.agent || "子任务");
      return (
        <details className="fold subtask">
          <summary>
            <b>子任务</b>
            <span className="arg">{line}</span>
            {st.agent && <span className="tag">{st.agent}</span>}
          </summary>
          <pre className="code">{String(st.prompt ?? "")}</pre>
        </details>
      );
    }
    case "compaction": {
      const c = part as any;
      return (
        <p className="hint compaction">
          {c.auto ? "上下文已自动压缩" : "上下文已压缩"}
          {c.overflow ? "（超出模型窗口）" : ""}
        </p>
      );
    }
    case "retry": {
      const r = part as any;
      const msg = r.error?.data?.message ?? r.error?.name ?? "未知错误";
      return <p className="hint">内核重试中（第 {r.attempt ?? 1} 次）：{msg}</p>;
    }
    case "patch": {
      const files = (part as any).files;
      if (!Array.isArray(files) || !files.length) return null;
      return (
        <details className="fold patch">
          <summary>
            <b>改动</b>
            <span className="arg">{files.length} 个文件</span>
          </summary>
          <ul className="flist">
            {files.map((f: unknown, i: number) => (
              <li key={i} title={String(f)}>
                <span className="fname">{baseName(f)}</span>
              </li>
            ))}
          </ul>
        </details>
      );
    }
    default:
      return null;
  }
});

type FlatUnit =
  | { t: "run"; key: string; items: RunItem[]; ids: string[] }
  | { t: "part"; key: string; p: Part; m: Message; ids: string[] };

const HIDDEN_PART = new Set(["step-start", "step-finish", "snapshot"]);

export function flattenParts(assistants: Message[]): FlatUnit[] {
  const parts: FlatUnit[] = [];
  const items: RunItem[] = [];
  let ids: string[] = [];
  let cardAt = 0;
  for (const m of assistants) {
    let first = true;
    for (const p of m.parts) {
      if (HIDDEN_PART.has(p.type)) continue;
      if (p.type === "reasoning" && !p.text?.trim()) continue;
      const own = first ? [m.info.id] : [];
      first = false;
      if (p.type === "tool" || p.type === "reasoning") {
        if (!items.length) cardAt = parts.length;
        items.push({ p, m });
        ids.push(...own);
      } else {
        parts.push({ t: "part", key: p.id, p, m, ids: own });
      }
    }
  }
  if (!items.length) return parts;
  const card: FlatUnit = { t: "run", key: "execution", items, ids };
  return [...parts.slice(0, cardAt), card, ...parts.slice(cardAt)];
}

export function AssistantParts({
  assistants,
  live,
  onCopy,
  onMenu,
  kidOf,
}: {
  assistants: Message[];
  live: boolean;
  onCopy: (t: string) => void;
  onMenu: (e: ReactMouseEvent, m: Message) => void;
  kidOf: (p: Part) => Message[] | undefined;
}) {
  return (
    <>
      {flattenParts(assistants).map((u) => (
        <Fragment key={u.key}>
          {u.ids.map((id) => (
            <span key={id} id={`m-${id}`} className="anchor" aria-hidden="true" />
          ))}
          {u.t === "run" ? (
            <ToolRun items={u.items} live={live} onCopy={onCopy} onMenu={onMenu} kidOf={kidOf} />
          ) : (
            <div className="unit" onContextMenu={(e) => onMenu(e, u.m)}>
              <Block part={u.p} assistant streaming={live && !u.m.info.time.completed && !u.p.time?.end} />
            </div>
          )}
        </Fragment>
      ))}
    </>
  );
}

export type TurnStat = {
  diffs: FileDiff[];
  todos: Todo[];
};

export function todosOfPart(part: Part): Todo[] | undefined {
  if (part.type !== "tool" || (part.tool !== "todowrite" && part.tool !== "todoread")) return undefined;
  const s = part.state as any;
  const input = s?.input?.todos;
  if (Array.isArray(input) && input.every((x: any) => typeof x?.content === "string")) {
    return input as Todo[];
  }
  return undefined;
}

export type TurnGroups = Record<string, Message[]>;

export function turnStatOf(arr: Message[]): TurnStat {
  const user = arr[0];
  const d = user ? (user.info as any).summary?.diffs : undefined;
  let todos: Todo[] = [];
  for (const m of arr) {
    if (m.info.role === "user") continue;
    for (const p of m.parts) {
      const t = todosOfPart(p);
      if (t) todos = t;
    }
  }
  return {
    diffs: Array.isArray(d) ? (d as FileDiff[]) : [],
    todos,
  };
}

export function turnsOf(
  msgs: Message[],
  busy: boolean,
  prev: { busy: boolean; runKey: string; stat: Record<string, TurnStat>; groups: TurnGroups } | null,
): { stat: Record<string, TurnStat>; owner: string[]; groups: TurnGroups; runKey: string } {
  const owner: string[] = [];
  const groups: TurnGroups = {};
  let cur = "";
  for (const m of msgs) {
    if (m.info.role === "user") {
      cur = m.info.id;
      groups[cur] = [];
    }
    owner.push(cur);
    if (cur) groups[cur].push(m);
  }
  const runKey = busy && owner.length ? owner[owner.length - 1] : "";
  const sameShape = !!prev && prev.busy === busy && prev.runKey === runKey;
  const stat: Record<string, TurnStat> = {};
  for (const [k, arr] of Object.entries(groups)) {
    const old = sameShape ? prev!.groups[k] : undefined;
    const reuse =
      !!old &&
      old.length === arr.length &&
      arr.every((m, i) => m === old[i]) &&
      !!prev!.stat[k];
    stat[k] = reuse ? prev!.stat[k] : turnStatOf(arr);
  }
  return { stat, owner, groups, runKey };
}

export const TurnSum = memo(function TurnSum({
  running,
  pulse,
  diffs,
  onOpenFile,
}: {
  running: boolean;
  pulse: number;
  diffs: FileDiff[];
  onOpenFile?: (d: FileDiff) => void;
}) {
  if (!diffs.length) return null;
  const add = diffs.reduce((n, d) => n + (d.additions ?? 0), 0);
  const del = diffs.reduce((n, d) => n + (d.deletions ?? 0), 0);
  return (
    <details className="fold turnsum">
      <summary>
        {running ? (
          <span className="pulse-dot" key={pulse} aria-hidden="true" />
        ) : (
          <span className="ck" aria-hidden="true">
            ✓
          </span>
        )}
        <span>
          {diffs.length} 个文件已修改
          {(add > 0 || del > 0) && (
            <>
              {" "}
              <span className="add">+{add}</span> <span className="del">-{del}</span>
            </>
          )}
        </span>
      </summary>
      <ul className="flist">
        {diffs.map((d, i) => (
          <li key={i}>
            <button
              className="flink"
              onClick={() => onOpenFile?.(d)}
              title={`${d.file} · 打开 diff`}
            >
              <span className={`fx ${d.status ?? "modified"}`}>
                {FSTATUS_CN[d.status ?? "modified"]}
              </span>
              <span className="fname">{baseName(d.file)}</span>
              <span className="muted small">
                {d.additions ? `+${d.additions}` : ""}
                {d.deletions ? ` -${d.deletions}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
});

export type TurnRowData = { key: string; owner: string; user?: Message; assistants: Message[] };

export function estimateTurnHeight(row: TurnRowData): number {
  let chars = 0;
  let blocks = 0;
  let tools = 0;
  for (const m of [row.user, ...row.assistants]) {
    if (!m) continue;
    for (const p of m.parts) {
      blocks++;
      if (p.type === "tool") tools++;
      if (p.type === "text" || p.type === "reasoning") chars += p.text?.length ?? 0;
    }
  }
  return Math.max(180, Math.min(12000, 120 + chars * 0.5 + tools * 46 + blocks * 10));
}

export function turnUsage(msgs: Message[]): string {
  const n = (x: unknown) => (typeof x === "number" && x > 0 ? x : 0);
  let inp = 0;
  let out = 0;
  let reas = 0;
  let cost = 0;
  let ms = 0;
  for (const m of msgs) {
    const i = m.info;
    const t = i.tokens ?? {};
    inp += n(t.input);
    out += n(t.output);
    reas += n(t.reasoning);
    cost += n(i.cost);
    if (i.time.completed) ms += Math.max(0, i.time.completed - i.time.created);
  }
  const bits: string[] = [];
  if (inp) bits.push(`输入 ${fmtNum(inp)}`);
  if (out) bits.push(`输出 ${fmtNum(out)}`);
  if (reas) bits.push(`思考 ${fmtNum(reas)}`);
  if (cost) bits.push(`成本 ${fmtNum(cost, 4)}`);
  if (ms >= 100) bits.push(fmtSpan(ms / 1000));
  return bits.length > 1 ? bits.join(" · ") : "";
}

export type TurnRowProps = {
  user?: Message;
  assistants: Message[];
  running: boolean;
  pulse: number;
  stat?: TurnStat;
  todo?: Todo[];
  retry?: ReactNode;
  onCopy: (t: string) => void;
  onMenu: (e: ReactMouseEvent, m: Message) => void;
  onOpenFile: (d: FileDiff) => void;
  kidOf: (p: Part) => Message[] | undefined;
};

export const TurnRow = memo(function TurnRow({
  user,
  assistants,
  running,
  pulse,
  stat,
  todo,
  retry,
  onCopy,
  onMenu,
  onOpenFile,
  kidOf,
}: TurnRowProps) {
  const tail = assistants[assistants.length - 1];
  const u = assistants.length ? turnUsage(assistants) : "";
  return (
    <>
      {user && (
        <article className="msg user" onContextMenu={(e) => onMenu(e, user)}>
          <header>
            <span>{label(user.info)}</span>
          </header>
          {(() => {
            const rendered = user.parts
              .map((p) => <Block key={p.id} part={p} />)
              .filter(Boolean);
            return rendered.length ? rendered : <p className="hint">[附图代码分析]</p>;
          })()}
        </article>
      )}
      {tail && (
        <article className="msg assistant">
          <header>
            <span>{label(tail.info)}</span>
            {u && (
              <span className="umeta" title={u}>
                {u}
              </span>
            )}
          </header>
          {assistants.map((m) =>
            m.info.error ? (
              <p className="error inline" key={m.info.id}>
                {m.info.error.data?.message ?? m.info.error.name}
                {m === tail && retry}
              </p>
            ) : null,
          )}
          <AssistantParts
            assistants={assistants}
            live={running}
            onCopy={onCopy}
            onMenu={onMenu}
            kidOf={kidOf}
          />
        </article>
      )}
      {stat && (
        <>
          <TurnSum
            running={running}
            pulse={running ? pulse : 0}
            diffs={stat.diffs}
            onOpenFile={onOpenFile}
          />
          {!running && <TurnTodo todos={todo} />}
        </>
      )}
    </>
  );
}, sameTurn);

function sameTurn(a: TurnRowProps, b: TurnRowProps): boolean {
  if (
    a.user !== b.user ||
    a.running !== b.running ||
    a.pulse !== b.pulse ||
    a.stat !== b.stat ||
    a.todo !== b.todo ||
    a.retry !== b.retry ||
    a.onCopy !== b.onCopy ||
    a.onMenu !== b.onMenu ||
    a.onOpenFile !== b.onOpenFile ||
    a.kidOf !== b.kidOf ||
    a.assistants.length !== b.assistants.length
  )
    return false;
  for (let i = 0; i < a.assistants.length; i++) if (a.assistants[i] !== b.assistants[i]) return false;
  return true;
}
