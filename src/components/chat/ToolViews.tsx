import { memo, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import type { Message, Part, Todo, ToolState } from "../../kernelApi";
import { useConversationExpansion } from "../../ConversationWindow";
import { readableToolOutput } from "../../toolOutput";
import { baseName } from "../../workspaceUtils";
import { TodoRows, todoProg, parseTodos } from "./TodoView";

/**
 * 一行状态回显（"Wrote file successfully."）没什么可复制的，只有真正的代码/文件内容才给角标
 */
export const worthCopy = (t: string) => t.includes("\n") || t.length >= 120;

/** 工具块的复制角标：悬浮或键盘聚焦才显形，挂在 wrapper 上不随块内滚动跑掉 */
export function Copyable({
  text,
  onCopy,
  children,
}: {
  text: string;
  onCopy: (t: string) => void;
  children: ReactNode;
}) {
  if (!worthCopy(text)) return <>{children}</>;
  return (
    <div className="codewrap">
      {children}
      <button className="cp" onClick={() => onCopy(text)} title="复制" aria-label="复制这段内容">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
    </div>
  );
}

export const STATE_CN: Record<string, string> = {
  pending: "等待中",
  running: "执行中",
  completed: "完成",
  error: "失败",
};

/** 子任务日志里的状态角标 */
export function StatusChip({ status }: { status: string }) {
  return <span className={`st st-${status}`}>{STATE_CN[status] ?? status}</span>;
}

/** 这些工具的入参本身就写在标题行里，再摊一份 JSON 只会把正文挤成一堵墙 */
export const SELF_EXPLANATORY = new Set([
  "read",
  "list",
  "grep",
  "glob",
  "edit",
  "write",
  "bash",
  "webfetch",
  "question",
  "todowrite",
]);

/** 标题行取最能说明"在干什么"的那个字段：bash 用它的 description，读写用文件名，检索用 pattern */
export function toolHead(part: Part): string {
  const s = part.state as any;
  const { tool, input: i } = toolView(part);
  const title = String(s?.title ?? "").replace(/\s+/g, " ").trim();
  const qs = i.questions as any[] | undefined;
  const td = i.todos as any[] | undefined;
  const files = i.file_paths as string[] | undefined;
  const raw =
    tool === "bash"
      ? i.description ?? title ?? i.command
      : tool === "read" || tool === "edit" || tool === "write"
        ? baseName(i.filePath ?? i.path ?? title)
        : tool === "grep" || tool === "glob"
          ? i.pattern
          : tool === "webfetch"
            ? i.url
            : tool === "deleteFile" && files?.length
              ? files.length > 1
                ? `${files.length} 个文件`
                : baseName(files[0])
              : tool === "skill"
                ? i.name
                : tool === "tool_search" || tool === "CodeSemanticSearch"
                  ? i.query
                  : tool === "tool_describe"
                    ? i.id
                    : tool === "invalid"
                      ? i.tool
                      : tool === "question" && qs?.length
                        ? `${qs[0].header ?? qs[0].question}${qs.length > 1 ? ` 等 ${qs.length} 个问题` : ""}`
                        : tool === "todowrite" && td?.length
                          ? `${td.length} 项待办`
                          : title;
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (/^tool_[a-z0-9]{10,}$/i.test(text)) return "";
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

// preview 可能截断，展开详情优先使用完整 output，并剥离内核给模型看的包装。
export function toolResult(part: Part): { text: string; truncated: boolean } {
  const s = part.state as any;
  const meta = s?.metadata ?? {};
  const preview = typeof meta.preview === "string" ? meta.preview : "";
  const output = readableToolOutput(String(s?.output ?? ""));
  return {
    text: output.trim() ? output : preview,
    truncated: !!meta.truncated,
  };
}

/** 工具名换成人话，标题行只留用户看得懂的那半句 */
export const TOOL_CN: Record<string, string> = {
  bash: "终端命令",
  read: "读取文件",
  edit: "修改文件",
  write: "写入文件",
  grep: "搜索内容",
  glob: "查找文件",
  list: "列出目录",
  webfetch: "访问网页",
  task: "子任务",
  question: "询问",
  todowrite: "更新待办",
  todoread: "查看待办",
  deleteFile: "删除文件",
  skill: "技能",
  tool_call: "调用工具",
  tool_search: "搜索工具",
  tool_describe: "查看工具说明",
  CodeSemanticSearch: "语义搜索",
  invalid: "工具调用",
};

/** tool_call 是内核的工具代理：真实工具和参数在 input.id / input.args 里 */
export function toolView(part: Part): { tool: string; input: Record<string, any> } {
  const input = ((part.state as any)?.input ?? {}) as Record<string, any>;
  if (part.tool === "tool_call" && typeof input.id === "string") {
    return { tool: input.id, input: (input.args ?? {}) as Record<string, any> };
  }
  return { tool: part.tool ?? "", input };
}

/** 完成态按工具分说法：命令是"已运行"，其余是"已完成" */
export function runVerb(part: Part, status: string): string {
  if (status === "completed") return toolView(part).tool === "bash" ? "已运行" : "已完成";
  return STATE_CN[status] ?? status;
}

/** 行尾那半句：命令原样留（等宽），其余用标题行取到的摘要 */
export function runPreview(part: Part): { text: string; mono: boolean } {
  if (part.type === "reasoning")
    return { text: String(part.text ?? "").replace(/\s+/g, " ").trim(), mono: false };
  const { tool, input } = toolView(part);
  if (tool === "bash")
    return { text: String(input.command ?? "").replace(/\s+/g, " ").trim(), mono: true };
  if (tool === "grep" || tool === "glob" || tool === "webfetch")
    return { text: toolHead(part), mono: true };
  return { text: toolHead(part), mono: false };
}

/** 行首状态图标：完成打勾、失败打叉、执行中转圈 */
export function RunIcon({ status }: { status: string }) {
  if (status === "running" || status === "pending") {
    return (
      <svg className="tgicon spin" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeDasharray="12 27"
        />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg className="tgicon" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg className="tgicon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5 8.2l2.1 2.1 3.9-4.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 子任务的日志折叠展现 */
export function KidLog({ msgs, running }: { msgs: Message[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const items = msgs.flatMap((m) =>
    m.parts.filter((p) => p.type === "tool" || p.type === "reasoning").map((p) => ({ p, m })),
  );
  if (!items.length) return null;
  return (
    <details className="kidlog" open={open}>
      <summary onClick={(e) => { e.preventDefault(); setOpen(!open); }}>
        <span>子任务进度（{items.length} 步）</span>
        {running && <span className="running">执行中…</span>}
      </summary>
      {open && (
        <ol className="tglist">
          {items.map(({ p }) => (
            <li key={p.id} className="tgrow">
              <span className="tglabel">{TOOL_CN[toolView(p).tool] ?? p.tool}</span>
              <span className="tgpreview">{runPreview(p).text}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/** 工具细节：命令、参数、待办、子会话进展与输出；分组行展开后共用这份内容 */
export function ToolBody({
  part,
  onCopy,
  kid,
}: {
  part: Part;
  onCopy: (t: string) => void;
  kid?: Message[];
}) {
  const s: ToolState | undefined = part.state;
  const status = s?.status ?? "pending";
  const { tool, input: args } = toolView(part);
  const cmd = tool === "bash" ? String(args?.command ?? "") : "";
  const { text: result, truncated } = toolResult(part);
  const err = status === "error" ? String((s as any)?.error ?? "") : "";
  const json =
    !err && !cmd && args && !SELF_EXPLANATORY.has(tool) && Object.keys(args).length
      ? JSON.stringify(args, null, 2)
      : "";
  const todos =
    tool === "todowrite"
      ? (args?.todos as Todo[] | undefined)
      : tool === "todoread"
        ? parseTodos(readableToolOutput(String((s as any)?.output ?? "")))
        : undefined;
  return (
    <>
      {cmd && (
        <Copyable text={cmd} onCopy={onCopy}>
          <pre className="code">$ {cmd}</pre>
        </Copyable>
      )}
      {json && (
        <Copyable text={json} onCopy={onCopy}>
          <pre className="code">{json}</pre>
        </Copyable>
      )}
      {!!todos?.length && (
        <div className="todo">
          <p className="muted small">{todoProg(todos)}</p>
          <TodoRows todos={todos} />
        </div>
      )}
      {kid?.length ? (
        <KidLog msgs={kid} running={status === "pending" || status === "running"} />
      ) : null}
      {err && <pre className="code err">{err}</pre>}
      {!err && !todos && result && (
        <Copyable text={result} onCopy={onCopy}>
          <pre className="code out">{result}</pre>
        </Copyable>
      )}
      {!err && !todos && truncated && <p className="hint">输出已被内核截断</p>}
    </>
  );
}

export const ToolRow = memo(function ToolRow({
  part,
  onCopy,
  kid,
}: {
  part: Part;
  onCopy: (t: string) => void;
  kid?: Message[];
}) {
  const status = part.state?.status ?? "pending";
  const [open, setOpen] = useConversationExpansion(part.id);
  const { text, mono } = runPreview(part);
  return (
    <details className="tgr" open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <RunIcon status={status} />
        <span className="tglabel">{TOOL_CN[toolView(part).tool] ?? "工具"}</span>
        <span className={`tgverb tg-${status}`}>{runVerb(part, status)}</span>
        {text && (
          <>
            <span className="tgsep" aria-hidden="true">
              ·
            </span>
            <span className={`tgpreview ${mono ? "mono" : ""}`} title={text}>
              {text}
            </span>
          </>
        )}
      </summary>
      {open && (
        <div className="tgbody">
          <ToolBody part={part} onCopy={onCopy} kid={kid} />
        </div>
      )}
    </details>
  );
});

export const ReasoningRow = memo(function ReasoningRow({ part }: { part: Part }) {
  const [open, setOpen] = useConversationExpansion(part.id);
  const preview = String(part.text ?? "").replace(/\s+/g, " ").trim();
  return (
    <details className="tgr" open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <RunIcon status="completed" />
        <span className="tglabel">已思考</span>
        <span className="tgpreview" title={preview}>
          {preview}
        </span>
      </summary>
      {open && (
        <div className="tgbody">
          <pre className="text muted scroll">{part.text}</pre>
        </div>
      )}
    </details>
  );
});

export type RunItem = { p: Part; m: Message };

export function ToolRun({
  items,
  live,
  onCopy,
  onMenu,
  kidOf,
}: {
  items: RunItem[];
  live: boolean;
  onCopy: (t: string) => void;
  onMenu: (e: ReactMouseEvent, m: Message) => void;
  kidOf: (p: Part) => Message[] | undefined;
}) {
  const tools = items.filter((i) => i.p.type === "tool").length;
  const running = items.some((i) => {
    const s = i.p.type === "tool" ? i.p.state?.status : undefined;
    return s === "running" || s === "pending";
  });
  const [open, setOpen] = useConversationExpansion("execution");
  const latest = [...items].reverse().find((item) => item.p.type === "tool");
  const activity = latest
    ? `${TOOL_CN[toolView(latest.p).tool] ?? "工具"} · ${runPreview(latest.p).text}`
    : "思考中";
  return (
    <details className="toolrun" open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <span className="tgchev" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path
              d={open ? "M3.6 6L8 10.4 12.4 6" : "M6 3.6l4.4 4.4L6 12.4"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="tgtitle">{tools ? `执行工具 ${tools} 次` : "已思考"}</span>
        {(live || running) && (
          <span className="tgactivity" title={activity}>
            {activity}
          </span>
        )}
        <span className={`tgstate ${live || running ? "tg-active" : ""}`}>
          {live || running ? "进行中" : "已结束"}
        </span>
      </summary>
      {open && (
        <ol className="tglist">
          {items.map(({ p, m }) => (
            <li
              key={p.id}
              className={`tgrow tg-${p.type === "tool" ? (p.state?.status ?? "pending") : "completed"}`}
              onContextMenu={(e) => onMenu(e, m)}
            >
              {p.type === "reasoning" ? (
                <ReasoningRow part={p} />
              ) : (
                <ToolRow part={p} onCopy={onCopy} kid={kidOf(p)} />
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
