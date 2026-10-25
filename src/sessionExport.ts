import type { Message, Part, Session } from "./kernelApi";

/** 工具输出截这么长：导出的 Markdown 是给人读的，几百行 stdout 只会把正文淹掉 */
const TOOL_CHARS = 600;

const pad = (n: number) => String(n).padStart(2, "0");

function stamp(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 正文里出现 ``` 时用更长的围栏，否则嵌套代码块会把 Markdown 结构撑破 */
function fence(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  return "`".repeat(longest + 1);
}

function textOf(p: Part): string {
  if (p.type === "text") {
    // 内核会往用户消息里塞 synthetic 提示（如语言说明），那不属于对话内容
    if ((p as any).synthetic || p.metadata?.synthetic) return "";
    return (p.text ?? "").trim();
  }
  if (p.type === "file") return `\`[附件] ${p.filename ?? p.mime ?? "文件"}\``;
  return "";
}

function toolOf(p: Part): string {
  if (p.type !== "tool") return "";
  const name = p.tool ?? "tool";
  const st = p.state as any;
  const head =
    st?.title ??
    (typeof st?.input === "object" && st.input
      ? (st.input.command ?? st.input.filePath ?? st.input.pattern ?? st.input.path ?? "")
      : "");
  const out = typeof st?.output === "string" ? st.output.trim() : "";
  const err = st?.status === "error" ? String(st.error ?? "工具执行失败") : "";
  const cut = (s: string) => (s.length > TOOL_CHARS ? `${s.slice(0, TOOL_CHARS)}\n…（已截断）` : s);
  const body = err ? cut(err) : out ? cut(out) : "";
  const title = `**工具** \`${name}\`${head ? ` · ${String(head).slice(0, 120)}` : ""}`;
  return body ? `${title}\n\n${fence(body)}\n${body}\n${fence(body)}` : title;
}

function usageLine(m: Message): string {
  const t = m.info.tokens ?? {};
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
  const bits: string[] = [];
  if (num(t.input)) bits.push(`输入 ${num(t.input)}`);
  if (num(t.output)) bits.push(`输出 ${num(t.output)}`);
  if (num(t.reasoning)) bits.push(`思考 ${num(t.reasoning)}`);
  if (num(m.info.cost)) bits.push(`成本 ${num(m.info.cost)}`);
  return bits.join(" · ");
}

/**
 * 把一条会话摊平成 Markdown。壳侧自己拼而不是问内核要，
 * 是因为内核没有导出接口；这里只输出人读得懂的部分：正文、附件名、工具调用摘要。
 */
export function sessionMarkdown(s: Session, msgs: Message[]): string {
  const out: string[] = [];
  out.push(`# ${s.title || "未命名会话"}`, "");
  out.push(`- 会话 ID：\`${s.id}\``);
  if (s.directory) out.push(`- 工作区：\`${s.directory}\``);
  if (s.time?.created) out.push(`- 创建时间：${stamp(s.time.created)}`);
  out.push(`- 消息数：${msgs.length}`);
  const total = msgs.reduce((n, m) => n + (typeof m.info.cost === "number" ? m.info.cost : 0), 0);
  if (total > 0) out.push(`- 累计成本：${total.toFixed(4)}`);
  out.push("", "---", "");

  for (const m of msgs) {
    const role = m.info.role === "user" ? "你" : `助手${m.info.agent ? ` · ${m.info.agent}` : ""}`;
    out.push(`## ${role}`, "");
    if (m.info.time?.created) out.push(`_${stamp(m.info.time.created)}_`, "");
    const blocks: string[] = [];
    for (const p of m.parts) {
      const text = textOf(p);
      if (text) blocks.push(text);
      const tool = toolOf(p);
      if (tool) blocks.push(tool);
    }
    out.push(blocks.length ? blocks.join("\n\n") : "_（无正文）_", "");
    const u = usageLine(m);
    if (u) out.push(`> ${u}`, "");
  }
  return out.join("\n").trimEnd() + "\n";
}

/** 保存对话框的默认文件名：去掉路径分隔符，免得在对话框里就出错 */
export function exportName(title: string, created?: number): string {
  const safe = (title || "会话").replace(/[/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
  const day = created ? stamp(created).slice(0, 10) : "";
  const stem = safe.length > 40 ? safe.slice(0, 40) : safe;
  return `${day ? `${day}-` : ""}${stem || "会话"}.md`;
}
