import { invoke } from "@tauri-apps/api/core";

/** 所有请求都经 Rust 代理：端口、Basic 凭据、服务密码不进 WebView。 */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  directory?: string | null,
): Promise<T> {
  return invoke<T>("api_request", {
    method,
    path,
    body: body ?? null,
    directory: directory ?? null,
  });
}

export type MessageInfo = {
  id: string;
  role: "user" | "assistant";
  sessionID: string;
  time: { created: number; completed?: number };
  agent?: string;
  model?: { providerID: string; modelID: string };
  modelID?: string;
  providerID?: string;
  cost?: number;
  tokens?: Record<string, any>;
  error?: { name: string; data?: { message?: string } };
};

export type ToolState =
  | { status: "pending"; input: unknown; raw?: string }
  | { status: "running"; input: unknown; title?: string; metadata?: unknown; time?: { start: number } }
  | {
      status: "completed";
      input: unknown;
      output: string;
      title?: string;
      metadata?: unknown;
      attachments?: unknown[];
      time?: { start: number; end?: number };
    }
  | { status: "error"; input: unknown; error: string; time?: { start: number; end?: number } };

export type Part = {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  mime?: string;
  url?: string;
  filename?: string;
  callID?: string;
  tool?: string;
  state?: ToolState;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
  reason?: string;
  cost?: number;
  tokens?: Record<string, number>;
};

export type Message = { info: MessageInfo; parts: Part[] };

/** `todowrite` 的一项：内核按 (sessionID, position) 存整份清单，改一次就整体覆盖 */
export type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
};

export type Session = {
  id: string;
  title: string;
  projectID?: string;
  directory?: string;
  /** 子任务会话才有；顶层会话的 payload 里不带这个键 */
  parentID?: string;
  time: { created: number; updated: number };
  /** session.updated / 列表接口会带上当前改动汇总，diffs 是逐文件明细 */
  summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
};

/**
 * session.diff 事件的每一行；file 是绝对路径。
 * `/session/:id/diff` 还会给出改动前后全文（before/after），壳子用它算逐行 diff。
 */
export type FileDiff = {
  file: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
  status?: "added" | "deleted" | "modified";
};

export type KernelEvent = { type: string; properties: Record<string, any> };

export type ModelRef = { providerID: string; modelID: string };

export type ModelInfo = {
  providerID: string;
  modelID: string;
  name: string;
  context?: number;
  reasoning?: boolean;
};

export type EnvCheck = {
  kernelInstalled: boolean;
  kernelBin: string | null;
  hasCredentials: boolean;
  projectDir: string | null;
  projects: string[];
  kernelHome: string;
};

/** /provider → { all:[{id,name,models:{...}}], default:{providerID:modelID} } */
export function normalizeProviders(root: any): { models: ModelInfo[]; default: ModelRef | null } {
  const models: ModelInfo[] = [];
  for (const p of root?.all ?? []) {
    for (const m of Object.values<any>(p.models ?? {})) {
      models.push({
        providerID: p.id,
        modelID: m.id,
        name: m.name || m.id,
        context: m.limit?.context,
        reasoning: m.capabilities?.reasoning,
      });
    }
  }
  const entry = Object.entries(root?.default ?? {})[0];
  return {
    models,
    default: entry ? { providerID: entry[0], modelID: entry[1] as string } : null,
  };
}

/** 真凭据实测：permission.asked 的 properties 就是这个形状 */
export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always?: unknown[];
  executeMode?: string;
  metadata?: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
};

export const permissions = {
  list: (dir?: string | null) => api<PermissionRequest[]>("GET", "/permission", undefined, dir),
  reply: (id: string, reply: "once" | "always" | "reject", dir?: string | null) =>
    api<boolean>("POST", `/permission/${id}/reply`, { reply }, dir),
};

/**
 * 内核让模型反问用户的通道：`GET /question` 是待答队列，`question.asked` 的 properties
 * 就是下面这个对象原样。回答按 questions 的顺序回一组 label 数组。
 */
export type QuestionOption = { label: string; description?: string };

export type QuestionInfo = {
  question: string;
  /** 一句话短标题，卡片上摊开的是它 */
  header?: string;
  options: QuestionOption[];
  /** 允许多选，缺省单选 */
  multiple?: boolean;
  /** 允许自己写答案，内核默认开 */
  custom?: boolean;
};

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
};

export const questions = {
  list: (dir?: string | null) => api<QuestionRequest[]>("GET", "/question", undefined, dir),
  reply: (id: string, answers: string[][], dir?: string | null) =>
    api<unknown>("POST", `/question/${id}/reply`, { answers }, dir),
  reject: (id: string, dir?: string | null) =>
    api<unknown>("POST", `/question/${id}/reject`, undefined, dir),
};

/**
 * 事前策略（实测 26.9.26）：`/permission/global` 是除 bash 外全部工具的规则，
 * bash 单独走 `/permission/bash/mode`；两者都落盘到 cli-data/storage/permission/，
 * 重启内核不丢，所以壳子只需要读一次、改的时候写一次。
 */
export type PermAction = "allow" | "deny" | "ask";
export type PermRule = { permission: string; pattern: string; action: PermAction };
export type BashMode = "always_allow" | "always_ask" | "sandbox";

export const permissionConfig = {
  rules: (dir?: string | null) => api<PermRule[]>("GET", "/permission/global", undefined, dir),
  setRules: (rules: PermRule[], dir?: string | null) =>
    api<unknown>("PUT", "/permission/global", rules, dir),
  bashMode: (dir?: string | null) =>
    api<{ mode: BashMode }>("GET", "/permission/bash/mode", undefined, dir),
  setBashMode: (mode: BashMode, dir?: string | null) =>
    api<{ mode: BashMode; permissions: PermRule[] }>("POST", "/permission/bash/mode", { mode }, dir),
};

export const sessions = {
  list: (dir?: string | null) => api<Session[]>("GET", "/session", undefined, dir),
  get: (id: string, dir?: string | null) =>
    api<Session>("GET", `/session/${id}`, undefined, dir),
  create: (title: string, dir?: string | null) =>
    api<Session>("POST", "/session", { title }, dir),
  /** 内核的自动起名偶发失败会停在「新会话」，壳侧在首轮发送后用它兜底 */
  update: (id: string, title: string, dir?: string | null) =>
    api<Session>("PATCH", `/session/${id}`, { title }, dir),
  remove: (id: string, dir?: string | null) =>
    api<Session>("DELETE", `/session/${id}`, undefined, dir),
  messages: (id: string, dir?: string | null) =>
    api<Message[]>("GET", `/session/${id}/message`, undefined, dir),
  /** 主链路：204 立即返回，内容全靠 SSE。agent 只认 GET /agent 返回的名字，写错内核不报错 */
  prompt: (
    id: string,
    parts: unknown[],
    dir?: string | null,
    model?: ModelRef | null,
    agent?: string | null,
  ) =>
    api<null>("POST", `/session/${id}/prompt_async`, { parts, model: model ?? undefined, agent: agent ?? undefined }, dir),
  abort: (id: string, dir?: string | null) =>
    api<boolean>("POST", `/session/${id}/abort`, undefined, dir),
  /** task 工具派出去的子会话 */
  children: (id: string, dir?: string | null) =>
    api<Session[]>("GET", `/session/${id}/children`, undefined, dir),
  /** spec 里没写但内核确实提供：当前整份待办清单，顺序即内核的 position */
  todos: (id: string, dir?: string | null) =>
    api<Todo[]>("GET", `/session/${id}/todo`, undefined, dir),
  /** 会话累计改动；每项带 before/after 全文，可直接算 diff */
  diff: (id: string, dir?: string | null) =>
    api<FileDiff[]>("GET", `/session/${id}/diff`, undefined, dir),
  /** 所有非 idle 会话的运行态；断线重连后用来对齐 busy / Stop */
  status: (dir?: string | null) =>
    api<Record<string, { type?: string; attempt?: number; message?: string }>>(
      "GET",
      "/session/status",
      undefined,
      dir,
    ),
};

export type AgentInfo = {
  name: string;
  description?: string;
  mode?: "primary" | "subagent" | "all";
  native?: boolean;
  hidden?: boolean;
};

export type CommandInfo = {
  name: string;
  description?: string;
  source?: string;
  template?: string;
  /** 占位符列表，实测最多就是 ["$ARGUMENTS"] */
  hints?: string[];
  /** true 表示内核 TUI 会把它丢给子会话跑；HTTP 侧没有对应开关，壳按普通 prompt 发 */
  subtask?: boolean;
  agent?: string;
  model?: string;
};

export type SkillInfo = { name: string; description?: string; location?: string };
export type V1Skill = {
  name: string;
  source?: string;
  description?: string;
  open?: boolean;
  filePath?: string;
};

export const agents = {
  list: (dir?: string | null) => api<AgentInfo[]>("GET", "/agent", undefined, dir),
};

export const commands = {
  list: (dir?: string | null) => api<CommandInfo[]>("GET", "/command", undefined, dir),
};

export const skills = {
  /** 本地安装的 skill（带正文） */
  list: (dir?: string | null) => api<SkillInfo[]>("GET", "/skill", undefined, dir),
  /** 内核内置的 skill 目录，华为侧还有 /v1/skills/sync 等管理端点 */
  system: (dir?: string | null) =>
    api<{ count: number; skills: V1Skill[] }>("GET", "/v1/skills", undefined, dir),
};

/** GET /mcp 当前是空对象；有注册时键是 server 名，值是状态。先按宽松类型接 */
export const mcp = {
  list: (dir?: string | null) =>
    api<Record<string, { status?: string; error?: string } | string>>("GET", "/mcp", undefined, dir),
};
