import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  agents,
  api,
  commands,
  normalizeProviders,
  permissionConfig,
  permissions,
  questions,
  sessions,
  type AgentInfo,
  type BashMode,
  type CommandInfo,
  type FileDiff,
  type KernelEvent,
  type Message,
  type MessageInfo,
  type ModelInfo,
  type ModelRef,
  type Part,
  type PermRule,
  type PermissionRequest,
  type QuestionRequest,
  type Session,
  type Todo,
  type ToolState,
} from "./kernelApi";
import { APP_TITLE, useAppVersion, type KernelStatus } from "./App";
import { FilePanel, FileViewer, relInRoot, type OpenFile } from "./Files";

type Props = {
  projectDir: string;
  projects: string[];
  status: KernelStatus | null;
  busy: boolean;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onAddDir: () => void;
  onSwitchDir: (dir: string) => void;
  onDropDir: (dir: string) => void;
  onOpenSettings: () => void;
};

/** 自绘右键菜单的一项 */
type MenuItem = { label: string; danger?: boolean; run: () => void };

type Menu = { x: number; y: number; items: MenuItem[] };

/** 本机 OCR：模型不能看图时，把截图里的文字带进 prompt */
type OcrState = {
  state: "pending" | "done" | "empty" | "error";
  text?: string;
  error?: string;
};

/** 粘贴进输入框的图片：有视觉模型时随 prompt 发 data URL，否则只带本机 OCR 文字 */
type Attachment = {
  id: string;
  name: string;
  mime: string;
  url: string;
  size: number;
  ocr?: OcrState;
};

/** 截图通常只有几百 KB；给个上限，别让整段 base64 把输入区撑爆 */
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MAX_COUNT = 4;
const DEFAULT_TITLES = new Set(["", "新会话", "New session", "Untitled", "untitled"]);

function imageTitle(raw: string, images: number): string {
  const first = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
  const compact = first.replace(/\s+/g, " ");
  if (compact) return compact.length > 40 ? `${compact.slice(0, 40)}…` : compact;
  return images > 1 ? `图片会话（${images} 张）` : "图片会话";
}

const imgSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function ocrLabel(ocr?: OcrState): string {
  if (!ocr || ocr.state === "pending") return "识别中";
  if (ocr.state === "done") return `文字 ${ocr.text?.length ?? 0}`;
  if (ocr.state === "empty") return "无文字";
  return "OCR 失败";
}

function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (!url.startsWith("data:")) {
        reject(new Error("读取图片失败"));
        return;
      }
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || `粘贴图片-${Date.now()}.${file.type.split("/")[1] || "png"}`,
        mime: file.type || "image/png",
        url,
        size: file.size,
        ocr: { state: "pending" },
      });
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

/** 上次用的模型：内核 /provider 的 default 每次重启都可能变，用户的选择要自己记住 */
export const MODEL_KEY = "codearts.model";
const AGENT_KEY = "codearts.agent";
/** 文件栏默认展开；用户收起一次之后记住 */
const FILES_KEY = "codearts.filesPanel";
/** 侧栏默认露出的条数：工作区列表，以及每个工作区下的会话。「加载更多」按同样步长展开，「收起」回到这个数 */
const SIDE_PAGE = 3;

/** 内核用来起标题、做摘要、压缩上下文的内部 agent，选它们当主对话只会得到一句废话 */
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"]);

const AGENT_CN: Record<string, string> = {
  build: "执行",
  plan: "规划",
  "docgen-agent": "文档",
};

/** 内核返回的 agent 描述是英文，菜单里只放译好的；不认识的 agent 不硬翻 */
const AGENT_DESC_CN: Record<string, string> = {
  build: "默认 agent，按当前授权策略执行工具。",
  plan: "规划模式，禁用所有修改文件的工具。",
  "docgen-agent": "自动完成文档生成任务（docgen、codebase-cli），无需人工交互。",
  explore: "只读探索代码和工作区，不做修改。",
};

const newMsg = (info: Message["info"]): Message => ({ info, parts: [] });

/** 工作区路径可能带尾斜杠，内核返回的一定不带 */
const sameDir = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** 正在敲一条斜杠命令时才返回它的名字部分；一旦敲空格就说明参数已经在写了，面板要收起 */
function slashToken(text: string): string | null {
  if (!text.startsWith("/") || /\s/.test(text)) return null;
  return text.slice(1);
}

function slashMatches(text: string, cmds: CommandInfo[]): CommandInfo[] {
  const tok = slashToken(text);
  if (tok === null) return [];
  const k = tok.toLowerCase();
  return cmds.filter((c) => c.name.toLowerCase().includes(k)).slice(0, 8);
}

/**
 * 内核的 HTTP 侧不展开命令模板（实测直接把 "/review x" 当普通 prompt 发，
 * 模型只看到一个陌生斜杠词），所以壳子自己按 TUI 的做法替换 $ARGUMENTS。
 */
function expandSlash(text: string, cmds: CommandInfo[]): string {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!m) return text;
  const cmd = cmds.find((c) => c.name === m[1]);
  if (!cmd?.template) return text;
  const args = m[2].trim();
  if (cmd.template.includes("$ARGUMENTS")) return cmd.template.replace(/\$ARGUMENTS/g, args);
  return args ? `${cmd.template}\n\n${args}` : cmd.template;
}

function upsertInfo(list: Message[], info: Message["info"]): Message[] {
  const i = list.findIndex((m) => m.info.id === info.id);
  if (i < 0) return [...list, newMsg(info)];
  const merged = { ...list[i], info: { ...list[i].info, ...info } };
  return [...list.slice(0, i), merged, ...list.slice(i + 1)];
}

function upsertPart(list: Message[], part: Part): Message[] {
  let hit = false;
  const next = list.map((m) => {
    if (m.info.id !== part.messageID) return m;
    hit = true;
    const i = m.parts.findIndex((p) => p.id === part.id);
    if (i < 0) return { ...m, parts: [...m.parts, part] };
    const merged = { ...m.parts[i] } as Record<string, unknown>;
    for (const [k, val] of Object.entries(part)) {
      // 内核会把 text:"" 的空 part.updated 排在增量之后，不能让已渲染的正文被抹掉
      if (val === "" && typeof merged[k] === "string" && merged[k]) continue;
      merged[k] = val;
    }
    return { ...m, parts: [...m.parts.slice(0, i), merged, ...m.parts.slice(i + 1)] } as Message;
  });
  return hit ? next : list;
}

/**
 * 实测 26.9.26：`message.part.delta` = `{sessionID, messageID, partID, field:"text", delta}`，
 * `delta` 是**增量片段**（一轮 285 帧），part 由更早的 `part.updated`（text:""）建好，
 * 收尾再发一条带全文的 `part.updated`。
 */
function appendDelta(list: Message[], p: Record<string, any>): Message[] {
  const field = String(p.field ?? "text");
  return list.map((m) => {
    if (m.info.id !== p.messageID) return m;
    const i = m.parts.findIndex((q) => q.id === p.partID);
    if (i < 0) return m; // part 还没建，等它的 part.updated 再来
    const cur = m.parts[i] as Record<string, unknown>;
    const part = { ...cur, [field]: String(cur[field] ?? "") + String(p.delta ?? "") } as unknown as Part;
    return { ...m, parts: [...m.parts.slice(0, i), part, ...m.parts.slice(i + 1)] };
  });
}

/** 子会话回灌与早期 SSE 合并：快照补缺口，已流式更新的消息保留更多 parts 的一侧 */
function mergeMessages(live: Message[], snap: Message[]): Message[] {
  if (!live.length) return snap;
  if (!snap.length) return live;
  const liveMap = new Map(live.map((m) => [m.info.id, m]));
  const merged = snap.map((m) => {
    const cur = liveMap.get(m.info.id);
    if (!cur) return m;
    return cur.parts.length > m.parts.length ? cur : m;
  });
  const inSnap = new Set(snap.map((m) => m.info.id));
  for (const m of live) {
    if (!inSnap.has(m.info.id)) merged.push(m);
  }
  return merged;
}

export default function Chat({
  projectDir,
  projects,
  status,
  busy: kernelBusy,
  onStart,
  onStop,
  onAddDir,
  onSwitchDir,
  onDropDir,
  onOpenSettings,
}: Props) {
  const live = status?.healthy ?? false;
  const dir = projectDir;
  const ver = useAppVersion();

  const [list, setList] = useState<Session[]>([]);
  /** 已展开的工作区个数；缺省按 SIDE_PAGE */
  const [wsShown, setWsShown] = useState<number | null>(null);
  /** 每个工作区已展开的会话条数；缺省按 SIDE_PAGE */
  const [sessShown, setSessShown] = useState<Record<string, number>>({});
  const [active, setActive] = useState<string | null>(null);
  /** 异步回填对比用：listener / fetch 完成时 active 可能已变 */
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;
  /** SSE 只订一次，切会话走 ref，避免双订户叠 delta */
  const dirRef = useRef(dir);
  dirRef.current = dir;
  /** 跨工作区点会话：先换目录重启内核，回到工作区后再打开这一条 */
  const pending = useRef<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  /** 输入区待发送的截图；只保存在内存里，发送或移除即丢弃 */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** 每张图的本地 OCR 任务：发送时等它们落地，避免刚粘上就回车漏字 */
  const ocrJobs = useRef(new Map<string, Promise<string>>());
  /**
   * 忙的是"哪条会话"而不是整个界面：从跑着的 A 切到空闲的 B，
   * 单布尔会卡在"处理中"，点停止还会 abort 到 B 头上。
   */
  const [busySet, setBusySet] = useState<Set<string>>(new Set());
  /** 内核自动重试（限流/网络）时的详情；只在它所属的会话上显示 */
  const [retry, setRetry] = useState<{ sid: string; attempt: number; message: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** 内核检测到危险命令（无 sessionID，全局提示），单独一条红色告警栏 */
  const [alert, setAlert] = useState<{ text: string; cmd: string } | null>(null);
  /** 事件流链路状态：断线期间帧会丢，重连后要补拉一次数据 */
  const [bridge, setBridge] = useState<"open" | "down">("open");
  const bridgeDown = useRef(false);
  /** file.edited 的脉冲：让正在跑的那轮小结胶囊跳动一下 */
  const [editPulse, setEditPulse] = useState(0);
  /** 删除会话的二次确认：先按 × 或菜单进入待确认，再点「删」才真的删 */
  const [delAsk, setDelAsk] = useState<string | null>(null);
  const delTimer = useRef<number | null>(null);
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  /** 内核的 question 工具在等人选项：不接住就只能看着一张 JSON 卡片卡在"执行中" */
  const [asks, setAsks] = useState<QuestionRequest[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<ModelRef | null>(null);
  const [rules, setRules] = useState<PermRule[] | null>(null);
  const [bashMode, setBashMode] = useState<BashMode | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  // 用户往上翻的时候不能再被拽回底部
  const stick = useRef(true);
  const sending = useRef(false);
  const [railHit, setRailHit] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const barThumb = useRef<HTMLDivElement>(null);
  const barTimer = useRef<number | null>(null);
  const barDrag = useRef<{ y: number; top: number; k: number } | null>(null);
  const [tip, setTip] = useState<{ text: string; top: number } | null>(null);
  const [cmds, setCmds] = useState<CommandInfo[]>([]);
  const [agentList, setAgentList] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  /** 自动换 agent 时记下已经处理过的工具 part，避免同一帧重复到达把用户手动选择改回去 */
  const planSwitch = useRef<string | null>(null);
  /** 退出规划模式要回到规划之前那个 agent，而不是写死 build */
  const prevAgent = useRef("build");
  /** 选 agent 的单一入口：下拉、规划开关、内核 plan_exit 自动切都走这里 */
  const chooseAgent = useCallback((name: string) => {
    if (name !== "plan") prevAgent.current = name;
    setAgent(name);
    localStorage.setItem(AGENT_KEY, name);
  }, []);
  const [hi, setHi] = useState(0);
  /** Esc 关掉的候选项所属的 /token，继续打字（token 变了）会重新弹。必须是 state，用 ref 的话按 Esc 不重渲染，面板会赖着不走 */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [kids, setKids] = useState<Session[]>([]);
  /**
   * task 工具派出去的子会话各存一份消息。内核把子任务的每一步都发在子会话的 sessionID 上，
   * 不接住就只能对着"内核处理中"干等。
   */
  const [kidMsgs, setKidMsgs] = useState<Record<string, Message[]>>({});
  const kidIds = useRef<Set<string>>(new Set());
  /** 会话级待办清单（内核每次 todowrite 整体覆盖）：最后一轮胶囊的兜底数据 */
  const [todos, setTodos] = useState<Todo[]>([]);
  /**
   * 每轮对话各自留一份清单快照（键 = 该轮的用户消息 id）。
   * 内核只发会话级的 todo.updated、不带轮次归属，靠「当前轮」这个 ref 认领。
   */
  const [turnTodos, setTurnTodos] = useState<Record<string, Todo[]>>({});
  const turnKeyRef = useRef<{ sid: string; id: string } | null>(null);
  /** 右侧资源管理器与文件大窗；默认展开，用户收起后记在本地 */
  const [filesOpen, setFilesOpen] = useState(() => {
    try {
      return localStorage.getItem(FILES_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [fileView, setFileView] = useState<OpenFile | null>(null);
  /** 当前会话的文件改动（内核 `/session/:id/diff`，带 before/after 全文） */
  const [sessionDiffs, setSessionDiffs] = useState<FileDiff[]>([]);

  /**
   * 每个工作区各发一次 `GET /session`（带各自的 x-opencode-directory）。
   * 内核的 opencode.db 是全项目共用的，所以不用切目录、也不用自己存一份会话索引，
   * 就能在左侧看到别的工作区的历史；非 git 目录会塌缩成同一个 projectID=global，
   * 同一个 project 的会话会被多个工作区各拿一次，靠 id 去重、按 session.directory 归位。
   */
  const wsKey = projects.join("\n");
  const reloadList = useCallback(() => {
    const ws = projects.length ? projects : [dir];
    Promise.all(
      ws.map((p) =>
        sessions
          .list(p)
          .then((s) => s.map((x) => ({ ...x, directory: x.directory ?? p })))
          .catch(() => [] as Session[]),
      ),
    ).then((groups) => {
      const byId = new Map<string, Session>();
      for (const g of groups.flat()) byId.set(g.id, g);
      setList([...byId.values()].sort((a, b) => b.time.updated - a.time.updated));
    });
    // wsKey 才是依赖内容，projects 每次渲染都是新数组
  }, [dir, wsKey]);
  const reloadListRef = useRef(reloadList);
  reloadListRef.current = reloadList;

  useEffect(reloadList, [reloadList, live]);

  useEffect(() => {
    if (!live) return;
    let alive = true;
    let rejectTimer = 0;
    setModels([]);
    // 上一轮失败留下的红字先收掉；新请求失败会重新弹
    setErr((cur) => (cur?.startsWith("模型列表获取失败") ? null : cur));
    api<any>("GET", "/provider", undefined, dir)
      .then((root) => {
        if (!alive) return;
        const { models, default: def } = normalizeProviders(root);
        setModels(models);
        const saved = localStorage.getItem(MODEL_KEY);
        const remembered = models.find(
          (m) => `${m.providerID}/${m.modelID}` === saved,
        );
        const inList = (m: ModelRef | null) =>
          !!m && models.some((x) => x.providerID === m.providerID && x.modelID === m.modelID);
        // 换工作区后旧 model 可能不在新列表：不能用 prev ?? 死守
        setModel((prev) => {
          if (inList(prev)) return prev;
          if (remembered) return { providerID: remembered.providerID, modelID: remembered.modelID };
          return def ?? models[0] ?? null;
        });
      })
      // 假凭据/排队时 /provider 会 500，静默失败只会留下一个空的模型下拉框；
      // 但切工作区会重启内核，旧端口的连接失败是瞬时的——等端口稳定再说
      .catch((e) => {
        rejectTimer = window.setTimeout(() => {
          if (alive) setErr(`模型列表获取失败：${e}`);
        }, 1500);
      });
    return () => {
      alive = false;
      window.clearTimeout(rejectTimer);
    };
  }, [live, dir, status?.port]);

  // 事前授权策略：内核落盘在 cli-data/storage/permission/，读一次就够，切工作区不用重设
  useEffect(() => {
    if (!live) {
      setRules(null);
      setBashMode(null);
      return;
    }
    Promise.all([permissionConfig.rules(dir), permissionConfig.bashMode(dir)])
      .then(([r, m]) => {
        setRules(r);
        setBashMode(m.mode);
      })
      .catch(() => {
        setRules(null);
        setBashMode(null);
      });
  }, [live, dir]);

  /**
   * 内核每条会话都带真实 directory 和 parentID，归属与子任务标记直接读它。
   * 注意 `GET /session` 也会列出 task 派出去的子会话，所以只读判定靠 parentID，
   * 不靠"是不是从子任务折叠里点进来的"。
   */
  const activeSess = list.find((s) => s.id === active) ?? null;
  const wsOf = activeSess?.directory ?? null;
  const wsOfRef = useRef(wsOf);
  wsOfRef.current = wsOf;
  // 子会话可能还没进 list（noteKid 先到），activeSess 找不到时也要按子会话处理
  const isChild = !!activeSess?.parentID || kids.some((k) => k.id === active);
  const readOnly = !!active && (isChild || (!!wsOf && !sameDir(wsOf, dir)));
  const busy = !!active && busySet.has(active);
  const selectedModel = model
    ? models.find((m) => m.providerID === model.providerID && m.modelID === model.modelID)
    : undefined;
  const visionReady = selectedModel?.image === true;
  /** 内置模型排前面不带副标；接进来的第三方收到「自定义」一段，段内再按提供商分组 */
  const modelOptions = (() => {
    const ref = (m: ModelInfo) => `${m.providerID}/${m.modelID}`;
    const label = (m: ModelInfo) => `${m.name}${m.context ? ` · ${Math.round(m.context / 1024)}K` : ""}`;
    const out: ChipOption[] = models
      .filter((m) => !m.custom)
      .map((m) => ({ value: ref(m), label: label(m) }));
    const custom = models.filter((m) => m.custom);
    const ids: string[] = [];
    for (const m of custom) if (!ids.includes(m.providerID)) ids.push(m.providerID);
    ids.forEach((id, pi) => {
      const list = custom.filter((m) => m.providerID === id);
      list.forEach((m, mi) => {
        out.push({
          value: ref(m),
          label: label(m),
          group: pi === 0 && mi === 0 ? "自定义" : undefined,
          prov: mi === 0 ? m.providerName : undefined,
        });
      });
    });
    return out;
  })();

  /** 时间线最后一条已经带错误时，输入框那一行的重复提示就不再显示 */
  const lastErr = (() => {
    const e = msgs[msgs.length - 1]?.info.error;
    return e ? e.data?.message ?? e.name ?? null : null;
  })();
  /** 可重发的内容 = 最后一条用户消息的文字和图片；没有它就没有重试入口 */
  const retryParts = (() => {
    const src = [...msgs].reverse().find((m) => m.info.role === "user");
    if (!src) return null;
    const parts = src.parts.flatMap(
      (p): { type: string; text?: string; mime?: string; url?: string; filename?: string }[] => {
        if (p.type === "text" && p.text) return [{ type: "text", text: p.text }];
        if (p.type === "file" && p.url)
          return [{ type: "file", mime: p.mime, url: p.url, filename: p.filename }];
        return [];
      },
    );
    return parts.length ? parts : null;
  })();
  const canRetry = !!retryParts && !!active && !readOnly && !busy;

  /** 改动快照按会话存；内核在每轮收尾和文件写入时会更新它 */
  const reloadDiffs = useCallback(() => {
    if (!active || !live) {
      setSessionDiffs([]);
      return;
    }
    const sid = active;
    sessions
      .diff(sid, wsOf ?? dir)
      .then((d) => {
        if (activeRef.current !== sid) return;
        setSessionDiffs(Array.isArray(d) ? d : []);
      })
      .catch(() => {
        if (activeRef.current === sid) setSessionDiffs([]);
      });
  }, [active, live, wsOf, dir]);
  const reloadDiffsRef = useRef(reloadDiffs);
  reloadDiffsRef.current = reloadDiffs;

  useEffect(() => {
    setSessionDiffs([]);
    reloadDiffs();
  }, [reloadDiffs]);

  // file.edited 可能一轮里来几十次，收拢成一次重取
  useEffect(() => {
    if (!editPulse) return;
    const t = window.setTimeout(reloadDiffs, 700);
    return () => window.clearTimeout(t);
  }, [editPulse, reloadDiffs]);

  /**
   * agent 与斜杠命令都是工作区相关的：/agent 会带上这个项目 .codearts 里定义的
   * 角色，/command 也是，所以切区必须重取。
   */
  useEffect(() => {
    if (!live) {
      setCmds([]);
      setAgentList([]);
      return;
    }
    commands
      .list(dir)
      .then(setCmds)
      .catch(() => setCmds([]));
    agents
      .list(dir)
      .then((all) => {
        const visible = all.filter(
          (a) => a.mode === "primary" && !a.hidden && !INTERNAL_AGENTS.has(a.name),
        );
        setAgentList(visible);
        if (!visible.length) return;
        const saved = localStorage.getItem(AGENT_KEY);
        const chosen =
          visible.find((a) => a.name === saved) ??
          visible.find((a) => a.name === "build") ??
          visible[0];
        chooseAgent(chosen.name);
      })
      .catch(() => setAgentList([]));
  }, [live, dir, chooseAgent]);

  /**
   * 换会话就重建子会话表。children 接口给的是历史，所以每条都要回灌一次消息；
   * 与 SSE 竞态时按 message id 合并，避免早期帧挡住整段回灌。
   */
  useEffect(() => {
    kidIds.current = new Set();
    setKids([]);
    setKidMsgs({});
    if (!active || !live) return;
    const parent = active;
    sessions
      .children(parent, wsOf ?? dir)
      .then((ks) => {
        if (activeRef.current !== parent) return;
        setKids(ks);
        for (const k of ks) {
          kidIds.current.add(k.id);
          const kid = k.id;
          sessions
            .messages(kid, k.directory ?? wsOf ?? dir)
            .then((ms) =>
              setKidMsgs((prev) => {
                if (activeRef.current !== parent) return prev;
                return { ...prev, [kid]: mergeMessages(prev[kid] ?? [], ms) };
              }),
            )
            .catch(() => {});
        }
      })
      .catch(() => {
        if (activeRef.current === parent) setKids([]);
      });
  }, [active, wsOf, dir, live]);

  /** 子会话在创建时才有 id，接到 session.created 就得立刻放行它后续的帧 */
  const noteKid = useCallback((s: Session) => {
    if (!s?.id) return;
    kidIds.current.add(s.id);
    setKids((prev) => (prev.some((x) => x.id === s.id) ? prev : [...prev, s]));
  }, []);
  const noteKidRef = useRef(noteKid);
  noteKidRef.current = noteKid;

  useEffect(() => {
    if (!active || !live) {
      setMsgs([]);
      setTodos([]);
      setTurnTodos({});
      turnKeyRef.current = null;
      return;
    }
    const sid = active;
    let alive = true;
    setErr(null);
    setToast(null);
    sessions
      .messages(sid, wsOf ?? dir)
      .then((ms) => {
        if (alive && activeRef.current === sid) setMsgs(ms);
      })
      .catch((e) => {
        if (alive && activeRef.current === sid) setErr(String(e));
      });
    // 清单是内核侧的会话状态，重开会话直接读它，不用去翻历史里那几张 todowrite 卡
    sessions
      .todos(sid, wsOf ?? dir)
      .then((ts) => {
        if (alive && activeRef.current === sid) setTodos(ts);
      })
      .catch(() => {
        if (alive && activeRef.current === sid) setTodos([]);
      });
    return () => {
      alive = false;
    };
  }, [active, wsOf, dir, live]);

  /**
   * 时间线上最后一条用户消息 = 正在跑的那轮；todo.updated 没有轮次信息，
   * 按这个认领快照。带上 sessionID 一起记：切会话后消息还没重拉完的空窗里，
   * 新会话的帧不能记到旧会话那轮名下。
   */
  useEffect(() => {
    let last: Message | undefined;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role === "user") {
        last = msgs[i];
        break;
      }
    }
    turnKeyRef.current = last ? { sid: last.info.sessionID, id: last.info.id } : null;
  }, [msgs]);

  // 换工作区后旧会话不属于新目录；若有 pending 跨区目标，留给下面的 effect 打开
  useEffect(() => {
    if (!pending.current) setActive(null);
    setBusySet(new Set());
    setRetry(null);
    setAlert(null);
    setDelAsk(null);
    setFileView(null);
    setSessionDiffs([]);
    setAttachments([]);
  }, [dir]);

  // 切换会话时截图不要跟着漂过去，避免把 A 会话的图误发到 B
  useEffect(() => {
    setAttachments([]);
  }, [active]);

  useEffect(() => {
    setFileView(null);
  }, [active]);

  /** 跨工作区点开：等 projectDir 落到目标会话目录、且列表到手后再选中 */
  useEffect(() => {
    const want = pending.current;
    if (!want) return;
    const s = list.find((x) => x.id === want);
    if (!s) return;
    if (s.directory && !sameDir(s.directory, dir)) return;
    pending.current = null;
    setActive(want);
  }, [list, dir]);

  /** 这些待决项算不算"我这边的"：父会话自己的，或者它派出去的子会话的 */
  const mineSid = useCallback(
    (sid: string) => sid === active || kidIds.current.has(sid),
    [active],
  );

  /** 待决的授权与问题都是内核侧的队列，一律只留"我这边的"（父 + 子会话） */
  const reloadPending = useCallback(() => {
    permissions
      .list(dir)
      .then((q) => setPerms(q.filter((p) => mineSid(p.sessionID))))
      .catch(() => setPerms([]));
    questions
      .list(dir)
      .then((q) => setAsks(q.filter((x) => mineSid(x.sessionID))))
      .catch(() => setAsks([]));
  }, [dir, mineSid]);

  /**
   * 两个队列一起重取：切会话、切目录、children 到货都要。子会话是切会话之后才异步取回来的，
   * 它那边的待决项得等 children 到货再筛一遍；只在数量变化时重取，帧走得比这快。
   */
  useEffect(() => {
    if (!live) {
      setPerms([]);
      setAsks([]);
      return;
    }
    reloadPending();
  }, [live, kids.length, reloadPending]);

  /** 断线重连后补拉一次：盲区里丢的帧（消息、待决、todo、diff、busy、子任务）只能这样找回 */
  const resync = useCallback(() => {
    reloadList();
    reloadPending();
    const sid = activeRef.current;
    const d = wsOfRef.current ?? dirRef.current;
    sessions
      .status(d)
      .then((map) => {
        const next = new Set<string>();
        let retryInfo: { sid: string; attempt: number; message: string } | null = null;
        for (const [id, st] of Object.entries(map ?? {})) {
          const t = st?.type ?? "";
          if (t && t !== "idle") next.add(id);
          if (t === "retry") {
            retryInfo = {
              sid: id,
              attempt: Number(st?.attempt ?? 1),
              message: String(st?.message ?? "内核正在自动重试"),
            };
          }
        }
        setBusySet(next);
        setRetry(retryInfo);
      })
      .catch(() => {});
    if (!sid) return;
    sessions
      .messages(sid, d)
      .then((ms) => {
        if (activeRef.current === sid) setMsgs(ms);
      })
      .catch(() => {});
    sessions
      .todos(sid, d)
      .then((ts) => {
        if (activeRef.current === sid) setTodos(ts);
      })
      .catch(() => {});
    sessions
      .diff(sid, d)
      .then((diff) => {
        if (activeRef.current !== sid) return;
        setSessionDiffs(Array.isArray(diff) ? diff : []);
      })
      .catch(() => {
        if (activeRef.current === sid) setSessionDiffs([]);
      });
    sessions
      .children(sid, d)
      .then((ks) => {
        if (activeRef.current !== sid) return;
        setKids(ks);
        for (const k of ks) {
          kidIds.current.add(k.id);
          const kid = k.id;
          sessions
            .messages(kid, k.directory ?? d)
            .then((ms) =>
              setKidMsgs((prev) => {
                if (activeRef.current !== sid) return prev;
                return { ...prev, [kid]: mergeMessages(prev[kid] ?? [], ms) };
              }),
            )
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [reloadList, reloadPending]);

  const resyncRef = useRef(resync);
  resyncRef.current = resync;

  /** Rust 侧 SSE 桥的链路状态；从 down 恢复到 open 才补数据（首连不补） */
  useEffect(() => {
    const stop = listen<{ state?: string }>("kernel-bridge", ({ payload }) => {
      if (payload?.state === "down") {
        bridgeDown.current = true;
        setBridge("down");
      } else if (payload?.state === "open") {
        const wasDown = bridgeDown.current;
        bridgeDown.current = false;
        setBridge("open");
        if (wasDown) resyncRef.current();
      }
    });
    return () => {
      stop.then((f) => f());
    };
  }, []);

  useEffect(() => {
    /** 帧属于当前会话就进主时间线，属于它派出的子会话就进那张 task 卡 */
    const merge = (sid: string, fn: (m: Message[]) => Message[]) => {
      if (sid === activeRef.current) setMsgs(fn);
      else setKidMsgs((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? []) }));
    };
    /** delta 按动画帧合并，避免每个 token 整树重渲染 */
    const deltaQ: { sid: string; p: Record<string, unknown> }[] = [];
    let deltaRaf = 0;
    const flushDeltas = () => {
      deltaRaf = 0;
      if (!deltaQ.length) return;
      const batch = deltaQ.splice(0, deltaQ.length);
      const bySid = new Map<string, typeof batch>();
      for (const item of batch) {
        const list = bySid.get(item.sid);
        if (list) list.push(item);
        else bySid.set(item.sid, [item]);
      }
      for (const [sid, items] of bySid) {
        merge(sid, (m) => {
          let next = m;
          for (const { p } of items) next = appendDelta(next, p);
          return next;
        });
      }
    };
    const stop = listen<KernelEvent>("kernel-event", ({ payload: ev }) => {
      const p = ev.properties ?? {};
      const sid = String(p.sessionID ?? "");
      const cur = activeRef.current;
      const mine = sid === cur || kidIds.current.has(sid);
      switch (ev.type) {
        case "message.updated":
          if (mine && p.info) merge(sid, (m) => upsertInfo(m, p.info));
          break;
        case "message.part.updated": {
          if (!p.part) break;
          // task 的正文里带着它派出去的那个子会话 id，见到就先登记，别等 children 接口
          if (p.part.tool === "task" && sid === cur) {
            const kid = p.part.state?.metadata?.sessionId;
            if (typeof kid === "string") kidIds.current.add(kid);
          }
          // 内核 26.9.26 两个方向都指望不上：plan_enter 只剩权限键、没有工具注册，
          // plan_exit 真跑一轮回 "Tool plan_exit not found"（官方 TUI 同款监听同样收不到）。
          // 进出规划都靠输入区的「规划」开关，这段只在内核修好 plan_exit 后才可能生效。
          // plan_exit 走不通时是 error 状态，也不会误切。
          if (
            sid === cur &&
            p.part.type === "tool" &&
            p.part.state?.status === "completed" &&
            p.part.tool === "plan_exit" &&
            planSwitch.current !== p.part.id
          ) {
            planSwitch.current = p.part.id;
            chooseAgent("build");
          }
          if (mine) merge(sid, (m) => upsertPart(m, p.part));
          break;
        }
        case "message.part.removed":
          if (mine)
            merge(sid, (m) => m.map((x) => ({ ...x, parts: x.parts.filter((q) => q.id !== p.partID) })));
          break;
        case "message.part.delta":
          if (mine) {
            deltaQ.push({ sid, p });
            if (!deltaRaf) deltaRaf = requestAnimationFrame(flushDeltas);
          }
          break;
        // 整条消息被撤（undo/revert）：不删的话撤回的消息钉在时间线里，重开又没了
        case "message.removed":
          if (mine && p.messageID) merge(sid, (m) => m.filter((x) => x.info.id !== p.messageID));
          break;
        // 子会话在 task 工具执行时才创建，不登记上就永远收不到它后面任何一帧；
        // 顶层新会话（别的窗口/CLI 建的）列表要跟着长出来
        case "session.created": {
          const s = p.info as Session | undefined;
          if (s?.parentID && s.parentID === cur) noteKidRef.current(s);
          else if (s && !s.parentID) reloadListRef.current();
          break;
        }
        // 标题/目录/汇总变化（自动起名也在内）：就地更新，不整表重拉
        case "session.updated": {
          const info = p.info as Session | undefined;
          if (info?.id) {
            setList((l) => l.map((s) => (s.id === info.id ? { ...s, ...info } : s)));
            setKids((ks) => ks.map((k) => (k.id === info.id ? { ...k, ...info } : k)));
          }
          break;
        }
        // 别处删了会话：列表、子任务表、忙状态一起清；删的是当前这条就回空态
        case "session.deleted": {
          const gone = String(p.sessionID ?? (p.info as Session | undefined)?.id ?? "");
          if (!gone) break;
          kidIds.current.delete(gone);
          setKids((ks) => ks.filter((k) => k.id !== gone));
          setKidMsgs((prev) => {
            if (!(gone in prev)) return prev;
            const next = { ...prev };
            delete next[gone];
            return next;
          });
          setBusySet((s) => {
            if (!s.has(gone)) return s;
            const next = new Set(s);
            next.delete(gone);
            return next;
          });
          setRetry((r) => (r?.sid === gone ? null : r));
          setList((l) => l.filter((s) => s.id !== gone));
          if (gone === cur) setActive(null);
          break;
        }
        case "session.status": {
          const st = String(p.status?.type ?? "");
          if (sid) {
            setBusySet((s) => {
              const has = s.has(sid);
              if (st === "idle" ? !has : has) return s;
              const next = new Set(s);
              if (st === "idle") next.delete(sid);
              else next.add(sid);
              return next;
            });
          }
          if (st === "retry") {
            setRetry({
              sid,
              attempt: Number(p.status?.attempt ?? 1),
              message: String(p.status?.message ?? "内核正在自动重试"),
            });
          } else {
            setRetry((r) => (r?.sid === sid ? null : r));
          }
          break;
        }
        case "session.idle":
          // 丢掉未刷的增量，避免 idle 全量替换后再叠一帧旧 delta
          for (let i = deltaQ.length - 1; i >= 0; i--) {
            if (deltaQ[i].sid === sid) deltaQ.splice(i, 1);
          }
          setBusySet((s) => {
            if (!s.has(sid)) return s;
            const next = new Set(s);
            next.delete(sid);
            return next;
          });
          setRetry((r) => (r?.sid === sid ? null : r));
          // 轮次收尾时内核才把 summary.diffs 写进用户消息，重拉一次才有每轮改动
          if (sid === cur) {
            const want = sid;
            sessions
              .messages(want, wsOfRef.current ?? dirRef.current)
              .then((ms) => {
                if (activeRef.current === want) setMsgs(ms);
              })
              .catch(() => {});
            reloadDiffsRef.current();
          }
          break;
        case "session.error":
          if (sid === cur) {
            setErr(p.error?.data?.message ?? p.error?.name ?? "内核返回错误");
          }
          setBusySet((s) => {
            if (!s.has(sid)) return s;
            const next = new Set(s);
            next.delete(sid);
            return next;
          });
          setRetry((r) => (r?.sid === sid ? null : r));
          break;
        // 压缩在时间线上不留别的痕迹，不提示只会觉得"聊着聊着忘事了"
        case "session.compacted":
          if (sid === cur) setToast("上下文已压缩，内核会带着摘要继续");
          break;
        // 改动明细：内核已按轮写入用户消息的 summary.diffs，idle 重拉时自然带上，不再单独接
        // 文件被改（无 sessionID，不冒充精确归属）：让跑着的那轮胶囊脉冲一下即可
        case "file.edited":
          setEditPulse((n) => n + 1);
          break;
        // 内核自查到新版本；升级入口在设置里，这里只提示
        case "installation.update-available":
          setToast(`内核有新版本 ${p.version ?? ""}，可在 设置 → 内核 里升级`);
          break;
        // 危险命令检测：全局告警，带上命令原文
        case "bash.dangerous.command.detected":
          setAlert({
            text: String(p.message ?? "内核检测到危险命令"),
            cmd: String(p.command ?? ""),
          });
          break;
        // 排队、限流这类运营提示走 toast 广播，不接就只剩"处理中"
        case "tui.toast.show": {
          const msg = String(p.message ?? "");
          // 内核每次启动都广播这条进度，用户处理不了，只会压住输入框
          if (!/^Initializing MCP server/i.test(msg)) setToast(p.message ?? p.title ?? null);
          break;
        }
        // 待办清单：内核整体覆盖，收到就整份替换，并给当前轮留一份快照
        case "todo.updated":
          if (p.sessionID === cur && Array.isArray(p.todos)) {
            const next = p.todos as Todo[];
            setTodos(next);
            const k = turnKeyRef.current;
            if (k && k.sid === p.sessionID) setTurnTodos((prev) => ({ ...prev, [k.id]: next }));
          }
          break;
        // 授权请求：不接住就只能看着"内核处理中"卡死；子会话自己发起的也一样卡，一并摊到父会话来
        case "permission.asked":
          if (mine && p.id)
            setPerms((q) => (q.some((x) => x.id === p.id) ? q : [...q, p as PermissionRequest]));
          break;
        case "permission.replied":
        case "permission.updated": {
          const id = p.requestID ?? p.id ?? p.permissionID;
          if (mine && id) setPerms((q) => q.filter((x) => x.id !== id));
          break;
        }
        // 反问：properties 就是 QuestionRequest 原样，不接住就只能对着 JSON 卡片发呆
        case "question.asked":
          if (mine && p.id)
            setAsks((q) => (q.some((x) => x.id === p.id) ? q : [...q, p as QuestionRequest]));
          break;
        case "question.replied":
        case "question.rejected": {
          const id = p.requestID ?? p.id;
          if (mine && id) setAsks((q) => q.filter((x) => x.id !== id));
          break;
        }
      }
    });
    return () => {
      if (deltaRaf) cancelAnimationFrame(deltaRaf);
      if (deltaQ.length) flushDeltas();
      stop.then((f) => f());
    };
  }, []);

  /** 把自绘滚动条的滑块尺寸和位置对齐到当前视口；内容不够长时直接藏掉 */
  function syncBar() {
    const el = thread.current;
    const wrap = bar.current;
    const th = barThumb.current;
    if (!el || !wrap || !th) return false;
    const track = el.clientHeight - 12;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 2 || track <= 32) {
      wrap.classList.remove("on");
      return false;
    }
    const h = Math.max(32, Math.round((el.clientHeight / el.scrollHeight) * track));
    th.style.height = `${h}px`;
    th.style.transform = `translateY(${Math.round((el.scrollTop / max) * (track - h))}px)`;
    return true;
  }

  function flashBar() {
    if (!syncBar()) return;
    const wrap = bar.current;
    if (!wrap) return;
    wrap.classList.add("on");
    if (barTimer.current) window.clearTimeout(barTimer.current);
    barTimer.current = window.setTimeout(() => {
      if (!barDrag.current) wrap.classList.remove("on");
    }, 900);
  }

  const onScroll = () => {
    const el = thread.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    flashBar();
  };

  function barDown(e: ReactPointerEvent<HTMLDivElement>) {
    const el = thread.current;
    const wrap = bar.current;
    const th = barThumb.current;
    if (!el || !wrap || !th) return;
    const track = wrap.clientHeight;
    const h = th.offsetHeight;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 2 || track <= h) return;
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const box = wrap.getBoundingClientRect();
    const top = Math.max(0, Math.min(track - h, e.clientY - box.top - h / 2));
    el.scrollTop = (top / (track - h)) * max;
    barDrag.current = { y: e.clientY, top: el.scrollTop, k: max / (track - h) };
    if (barTimer.current) window.clearTimeout(barTimer.current);
    wrap.classList.add("on");
  }

  function barMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = barDrag.current;
    const el = thread.current;
    if (!drag || !el) return;
    el.scrollTop = drag.top + (e.clientY - drag.y) * drag.k;
  }

  function barUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!barDrag.current) return;
    barDrag.current = null;
    const wrap = bar.current;
    if (wrap?.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
    flashBar();
  }

  useEffect(() => {
    syncBar();
  }, [msgs, kidMsgs, active, busy, filesOpen]);

  useEffect(() => {
    const onResize = () => syncBar();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (barTimer.current) window.clearTimeout(barTimer.current);
    };
  }, []);

  useEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, kidMsgs]);

  useEffect(() => {
    stick.current = true;
    setRailHit(null);
    setTip(null);
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active]);

  function jumpTo(id: string) {
    setRailHit(id);
    document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** 悬浮预览：跟随刻度条的位置，用 absolute 挂在 .body 上，不受滚动容器裁剪 */
  function showTip(el: HTMLElement, text: string) {
    const box = body.current;
    if (!box) return;
    const b = box.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    setTip({ text, top: t.top - b.top + t.height / 2 });
  }

  /**
   * 内核自动起名插件偶发 AI_NoOutputGeneratedError，会把标题停在「新会话」。
   * 壳侧在首轮后隔几秒补一次标题；若内核随后自己起好了就不再覆盖。
   */
  function scheduleTitleFallback(sid: string, title: string, where: string) {
    for (const wait of [2500, 7000, 15000]) {
      window.setTimeout(async () => {
        try {
          const cur = await sessions.get(sid, where);
          if (cur.title && !DEFAULT_TITLES.has(cur.title.trim())) return;
          const updated = await sessions.update(sid, title, where);
          setList((l) => l.map((s) => (s.id === sid ? { ...s, ...updated } : s)));
        } catch {
          // 内核重启、工作区切换或会话已删：放弃这次兜底
          return;
        }
      }, wait);
    }
  }

  /** 粘贴后立刻在 Rust 侧跑 Vision OCR；不阻塞缩略图出现 */
  function startOcr(a: Attachment) {
    const job = invoke<string>("ocr_image", { dataUrl: a.url })
      .then((raw) => {
        const text = raw.trim();
        setAttachments((list) =>
          list.map((x) =>
            x.id === a.id ? { ...x, ocr: { state: text ? "done" : "empty", text } } : x,
          ),
        );
        return text;
      })
      .catch((e) => {
        setAttachments((list) =>
          list.map((x) =>
            x.id === a.id ? { ...x, ocr: { state: "error", error: String(e) } } : x,
          ),
        );
        return "";
      })
      .finally(() => {
        ocrJobs.current.delete(a.id);
      });
    ocrJobs.current.set(a.id, job);
  }

  /** 粘贴/拖入的截图先进输入区，发送时按模型能力选 file part 或 OCR 文字 */
  async function addImages(files: File[]) {
    const room = IMAGE_MAX_COUNT - attachments.length;
    if (room <= 0) {
      setErr(`最多添加 ${IMAGE_MAX_COUNT} 张图片`);
      return;
    }
    const take = files.slice(0, room);
    const tooBig = take.filter((f) => f.size > IMAGE_MAX_BYTES);
    if (tooBig.length) {
      setErr(`单张图片不能超过 ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
    }
    const ok = take.filter((f) => f.size <= IMAGE_MAX_BYTES);
    if (!ok.length) return;
    try {
      const loaded = await Promise.all(ok.map(readImage));
      setAttachments((prev) => [...prev, ...loaded].slice(0, IMAGE_MAX_COUNT));
      setErr(null);
      for (const a of loaded) startOcr(a);
    } catch (e) {
      setErr(String(e));
    }
  }

  function onPasteImages(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (!files.length) return;
    // 有图片就不要把 path/文本形式再插进 textarea；纯文本粘贴保持浏览器默认行为
    e.preventDefault();
    void addImages(files);
  }

  async function send() {
    if (sending.current || readOnly || busy || perms.length > 0 || asks.length > 0) return;
    const raw = input.trim();
    const imgs = attachments;
    if (!raw && !imgs.length) {
      setErr("输入为空");
      return;
    }
    // 一次回车只发一条：IME 提交候选词和真正发送会连着派发两个 Enter keydown，
    // 两个处理函数拿到的是同一次渲染的 input 闭包，setInput 挡不住第二次
    sending.current = true;
    setErr(null);
    setToast(null);
    try {
      const vision = visionReady;
      // 模型不能看图时，等粘贴时启动的本机 OCR 落地；一个字都没读到就不发空图
      const ocrTexts =
        imgs.length && !vision
          ? await Promise.all(
              imgs.map((a) => ocrJobs.current.get(a.id) ?? Promise.resolve(a.ocr?.text ?? "")),
            )
          : [];
      const ocrBlock = ocrTexts
        .map((t, i) => (t ? `【图片 ${i + 1} 的本地 OCR 文字】\n${t}` : ""))
        .filter(Boolean)
        .join("\n\n");
      if (imgs.length && !vision && !ocrBlock) {
        setErr(
          "当前模型不支持看图，本机 OCR 也没有从截图里识别到文字；换一个支持视觉的模型，或先把文字复制进输入框。",
        );
        return;
      }
      // 侧栏标题用原始输入：命令模板展开后是几百字，标题栏放不下
      const text = expandSlash(raw, cmds);
      const promptText =
        !vision && ocrBlock ? (text ? `${text}\n\n${ocrBlock}` : ocrBlock) : text;
      const parts: unknown[] = [];
      if (promptText) parts.push({ type: "text", text: promptText });
      if (vision) {
        for (const a of imgs) {
          parts.push({ type: "file", mime: a.mime, url: a.url, filename: a.name });
        }
      }
      setInput("");
      setAttachments([]);
      setDismissed(null);
      let id = active;
      const title = imageTitle(raw, imgs.length);
      if (!id) {
        const s = await sessions.create(title, dir);
        id = s.id;
        setActive(id);
        reloadList();
      }
      // 先标 busy：prompt 返回前 SSE 可能已 idle，事后再 add 会卡在 Stop
      setBusySet((s) => new Set(s).add(id));
      try {
        await sessions.prompt(id, parts, dir, model, agent);
        stick.current = true;
      } catch (e) {
        setBusySet((s) => {
          if (!s.has(id!)) return s;
          const next = new Set(s);
          next.delete(id!);
          return next;
        });
        throw e;
      }
      // 当前标题还是默认值就补一条；已有好标题（含内核自动生成）的不动
      if (!activeSess || DEFAULT_TITLES.has(activeSess.title.trim())) {
        scheduleTitleFallback(id, title, dir);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      sending.current = false;
    }
  }

  /** 重试 = 把最后一条用户消息原样再发一次，不用重新打字 */
  async function retryTurn() {
    const id = active;
    if (!retryParts || !id || sending.current || busy || perms.length > 0 || asks.length > 0) return;
    sending.current = true;
    setErr(null);
    setToast(null);
    // 先标 busy：prompt 返回前 SSE 可能已 idle，事后再 add 会卡在 Stop
    setBusySet((s) => new Set(s).add(id));
    try {
      await sessions.prompt(id, retryParts, dir, model, agent);
      stick.current = true;
    } catch (e) {
      setBusySet((s) => {
        if (!s.has(id)) return s;
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      setErr(String(e));
    } finally {
      sending.current = false;
    }
  }

  const retryBtn = canRetry ? (
    <button
      className="retry"
      onClick={() => void retryTurn()}
      title="把这一轮的输入原样再发一次"
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
      重试
    </button>
  ) : null;

  async function createSession() {
    try {
      const s = await sessions.create("新会话", dir);
      setActive(s.id);
      reloadList();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function removeSession(id: string) {
    try {
      await sessions.remove(id, dir);
      if (id === active) setActive(null);
      reloadList();
    } catch (e) {
      setErr(String(e));
    }
  }

  /** 第一次点删除只进入待确认（几秒后自动收回），第二次才是真删 */
  function armDelete(id: string) {
    setDelAsk(id);
    if (delTimer.current) window.clearTimeout(delTimer.current);
    delTimer.current = window.setTimeout(() => setDelAsk(null), 4000);
  }

  function confirmDelete(id: string) {
    setDelAsk(null);
    if (delTimer.current) window.clearTimeout(delTimer.current);
    void removeSession(id);
  }

  async function answer(p: PermissionRequest, reply: "once" | "always" | "reject") {
    setErr(null);
    try {
      await permissions.reply(p.id, reply, dir);
      setPerms((q) => q.filter((x) => x.id !== p.id));
    } catch (e) {
      setErr(String(e));
    }
  }

  /** answers 按 questions 同序，每项是选中的 label 数组（自己写的那句也并进同一项） */
  async function answerQuestion(q: QuestionRequest, answers: string[][]) {
    setErr(null);
    try {
      await questions.reply(q.id, answers, dir);
      setAsks((a) => a.filter((x) => x.id !== q.id));
    } catch (e) {
      setErr(String(e));
    }
  }

  async function rejectQuestion(q: QuestionRequest) {
    setErr(null);
    try {
      await questions.reject(q.id, dir);
      setAsks((a) => a.filter((x) => x.id !== q.id));
    } catch (e) {
      setErr(String(e));
    }
  }

  const copy = useCallback(async (text: string) => {
    setErr(null);
    try {
      await navigator.clipboard.writeText(text);
      setToast("已复制到剪贴板");
    } catch (e) {
      setErr(`复制失败：${e}`);
    }
  }, []);

  const policy = matchPolicy(rules, bashMode);

  async function applyPolicy(id: string) {
    const p = POLICIES.find((x) => x.id === id);
    if (!p || !rules) return;
    setErr(null);
    try {
      // bash 只认 /permission/bash/mode，global 规则集里没有它，两次写缺一不可
      await permissionConfig.setBashMode(p.mode, dir);
      const allow = allowedSet(p, rules);
      const next: PermRule[] = rules.map((r) => ({
        ...r,
        action: allow.has(r.permission) ? "allow" : "ask",
      }));
      await permissionConfig.setRules(next, dir);
      setRules(next);
      setBashMode(p.mode);
      setToast(`授权策略已切到「${p.label}」`);
    } catch (e) {
      setErr(String(e));
    }
  }

  const ofWs = (p: string) => list.filter((s) => sameDir(s.directory, p));
  const turns = msgs.filter((m) => m.info.role === "user");
  const lastRea = lastReasoning(msgs);
  const tot = totals(msgs);
  /** 每轮小结的底账：切轮、数步、给每步拉一行摘要，详见 turnsOf */
  const { stat: turnStat, owner: turnOf } = turnsOf(msgs, busy);
  /** 全完成的旧清单不该在新一轮里继续悬浮，等内核写新清单再出现 */
  const openTodos = todos.some((t) => t.status !== "completed" && t.status !== "cancelled");

  /** 父会话里那条 task 工具记录只给一个子会话 id，过程全在子会话的帧上 */
  const kidOf = (p: Part) =>
    p.type === "tool" && p.tool === "task" ? kidMsgs[kidSid(p)] : undefined;

  /**
   * 待决项是子会话发来的时候，卡片上得说是谁在问——否则看起来像主任务在拦你。
   * 子会话在 children 到货前标题还未知，那时退回显示 id，别把来源吞掉。
   */
  const kidFrom = (sid: string) => {
    if (sid === active) return null;
    const kid = kids.find((k) => k.id === sid);
    return (
      <p className="from">
        来自子任务 <span className="who">{kid?.title || sid}</span>
        {kid && (
          <button className="link" onClick={() => setActive(kid.id)}>
            切过去看
          </button>
        )}
      </p>
    );
  };

  const tok = slashToken(input);
  const palette = tok === null || dismissed === tok ? [] : slashMatches(input, cmds);

  useEffect(() => setHi(0), [tok]);

  function accept(c: CommandInfo) {
    setInput(`/${c.name} `);
    setHi(0);
  }

  /** 面板开着的时候方向键/Tab/Enter 都归它，关着才回到发送语义 */
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (palette.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHi((h) => (h + 1) % palette.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHi((h) => (h - 1 + palette.length) % palette.length);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(tok);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        // 输入法拼词里的 Tab/Enter 不是补全指令
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        accept(palette[hi] ?? palette[0]);
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    // 输入法还在拼词，这个 Enter 是提交候选词，不是发送
    if (e.nativeEvent.isComposing) return;
    if (busy || perms.length > 0 || asks.length > 0) return;
    void send();
  }

  /**
   * 切工作区 = 重启内核。先把上一个工作区的界面清空再等，
   * 否则这几秒里看到的是旧对话，很容易当成没生效。
   */
  function clearView() {
    setActive(null);
    setMsgs([]);
    setPerms([]);
    setBusySet(new Set());
    setRetry(null);
    setTip(null);
  }

  /**
   * opencode.db 全项目共用，读消息不需要切区，所以别的区的会话直接只读预览；
   * 只有要发新消息才需要 restart 到那个工作区。
   * 忙不忙由 busySet 按会话判定，切过去自然看到那条会话自己的状态，不用在这里清。
   */
  function openSession(p: string, id: string) {
    if (sameDir(p, projectDir)) {
      setActive(id);
      return;
    }
    setPerms([]);
    setActive(id);
  }

  function switchTo(p: string, then: string | null = null) {
    if (sameDir(p, projectDir)) {
      setActive(then);
      return;
    }
    pending.current = then;
    clearView();
    onSwitchDir(p);
  }

  function dropWs(p: string) {
    if (sameDir(p, projectDir)) {
      pending.current = null;
      clearView();
    }
    onDropDir(p);
  }

  function toggleFiles() {
    setFilesOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(FILES_KEY, next ? "1" : "0");
      } catch {
        // 隐私模式/配额满了也不影响本次显示
      }
      return next;
    });
  }

  /** 文件大窗只读当前工作区的文件；跨区会话的改动请先切过去。计划文件由 files.rs 单独限定根目录 */
  function openWorkspaceFile(f: OpenFile) {
    if (!f.plan && relInRoot(dir, f.abs) === null) {
      setToast("这个文件不在当前工作区，切到对应工作区后再查看");
      return;
    }
    setFileView(f);
  }

  function openDiffFile(d: FileDiff) {
    const rel = relInRoot(dir, d.file);
    if (rel === null) {
      setToast("该改动属于其他工作区，切过去后再查看");
      return;
    }
    setFileView({ rel, abs: d.file, tab: "diff" });
  }

  /** 原生右键菜单已被全局压掉，工作区与会话的菜单在这里自绘 */
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuBox = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!menuBox.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  function openMenu(e: ReactMouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
  }

  function wsMenu(p: string, cur: boolean): MenuItem[] {
    return [
      ...(cur ? [] : [{ label: "切换到此工作区", run: () => switchTo(p) }]),
      {
        label: "在访达中显示",
        run: () => void revealItemInDir(p).catch((e) => setErr(String(e))),
      },
      { label: "从列表移除", danger: true, run: () => dropWs(p) },
    ];
  }

  function sessMenu(p: string, id: string, cur: boolean): MenuItem[] {
    return cur
      ? [{ label: "删除会话", danger: true, run: () => armDelete(id) }]
      : [{ label: "切到该工作区并打开", run: () => switchTo(p, id) }];
  }

  const wsCap = wsShown ?? SIDE_PAGE;
  const wsHead = projects.slice(0, wsCap);
  // 当前工作区如果落在折叠区，单独补一行，不必把中间全部摊开
  const wsPinned = wsHead.some((p) => sameDir(p, projectDir))
    ? undefined
    : projects.find((p) => sameDir(p, projectDir));
  const visibleProjects = wsPinned ? [...wsHead, wsPinned] : wsHead;
  const wsOpen = new Set(visibleProjects);
  const wsRest = projects.filter((p) => !wsOpen.has(p)).length;
  const wsExpanded = wsCap > SIDE_PAGE;

  return (
    <div className="shell2">
      <aside className="side">
        {/* 标题栏已沉浸（titleBarStyle Overlay），这条空带子就是拖窗口的把手，红绿灯压在它上面 */}
        <div className="drag" data-tauri-drag-region="deep">
          <span className="wtitle">{APP_TITLE}</span>
          {ver ? <span className="wver">{ver}</span> : null}
        </div>
        <div className="newbox">
          <button className="primary" onClick={createSession} disabled={!live}>
            + 新建会话
          </button>
        </div>
        <div className="wsbox">
          <header>
            <span className="muted small">工作区</span>
            <button className="ico-btn" onClick={onAddDir} title="添加工作区" aria-label="添加工作区">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 3.2v9.6M3.2 8h9.6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </header>
          <ul className="wslist" data-tauri-drag-region="deep">
            {visibleProjects.map((p) => {
              const cur = sameDir(p, projectDir);
              const items = ofWs(p);
              const cap = sessShown[p] ?? SIDE_PAGE;
              const head = items.slice(0, cap);
              // 当前打开的那条如果落在折叠区，单独补一行，不必把中间全部摊开
              const pinned = head.some((s) => s.id === active)
                ? undefined
                : items.find((s) => s.id === active);
              const visible = pinned ? [...head, pinned] : head;
              const shown = new Set(visible.map((s) => s.id));
              const rest = items.filter((s) => !shown.has(s.id)).length;
              const expanded = cap > SIDE_PAGE;
              return (
                <li key={p} className={`ws ${cur ? "on" : ""}`}>
                  <div
                    className="wsrow"
                    onContextMenu={(e) => openMenu(e, wsMenu(p, cur))}
                  >
                    <button
                      className="wsname"
                      onClick={() => switchTo(p)}
                      title={cur ? p : `切到 ${p}`}
                    >
                      <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
                        <path
                          d="M1.5 4.3A1.5 1.5 0 0 1 3 2.8h2.9l1.4 1.6H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13.4H3a1.5 1.5 0 0 1-1.5-1.5z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.2"
                        />
                      </svg>
                      {baseName(p)}
                    </button>
                    {!cur && (
                      <button
                        className="x"
                        onClick={() => dropWs(p)}
                        title="从列表移除（不删除文件夹）"
                        aria-label="从列表移除该工作区（不删除文件夹）"
                      >
                        ×
                      </button>
                    )}
                  </div>
                  <ul className="sess">
                    {visible.map((s) => (
                      <li
                        key={s.id}
                        className={s.id === active ? "on" : ""}
                        onContextMenu={(e) => openMenu(e, sessMenu(p, s.id, cur))}
                      >
                        <button
                          className="link"
                          onClick={() => openSession(p, s.id)}
                          title={
                            s.parentID
                              ? `子任务会话 · ${s.id}`
                              : cur
                                ? s.id
                                : `只读预览 · ${s.id}`
                          }
                        >
                          {s.parentID ? `↳ ${s.title || s.id}` : s.title || s.id}
                        </button>
                        {cur &&
                          (delAsk === s.id ? (
                            <>
                              <button
                                className="x armed danger"
                                onClick={() => confirmDelete(s.id)}
                                title="确认删除这条会话"
                              >
                                删
                              </button>
                              <button
                                className="x armed"
                                onClick={() => setDelAsk(null)}
                                title="取消"
                              >
                                ×
                              </button>
                            </>
                          ) : (
                            <button
                              className="x"
                              onClick={() => armDelete(s.id)}
                              title="删除会话"
                              aria-label="删除会话"
                            >
                              ×
                            </button>
                          ))}
                      </li>
                    ))}
                    {(rest > 0 || expanded) && (
                      <li className="ops">
                        {rest > 0 && (
                          <button
                            className="link more"
                            onClick={() =>
                              setSessShown((prev) => ({ ...prev, [p]: cap + SIDE_PAGE }))
                            }
                          >
                            加载更多（{rest}）
                          </button>
                        )}
                        {expanded && (
                          <button
                            className="link more"
                            onClick={() =>
                              setSessShown((prev) => {
                                const next = { ...prev };
                                delete next[p];
                                return next;
                              })
                            }
                          >
                            收起
                          </button>
                        )}
                      </li>
                    )}
                    {!items.length && <li className="muted pad">暂无会话</li>}
                  </ul>
                </li>
              );
            })}
            {(wsRest > 0 || wsExpanded) && (
              <li className="ops">
                {wsRest > 0 && (
                  <button
                    className="more"
                    onClick={() => setWsShown(wsCap + SIDE_PAGE)}
                  >
                    加载更多（{wsRest}）
                  </button>
                )}
                {wsExpanded && (
                  <button className="more" onClick={() => setWsShown(null)}>
                    收起
                  </button>
                )}
              </li>
            )}
          </ul>
        </div>
        <footer>
          <button className="ico-btn" onClick={onOpenSettings} title="设置" aria-label="设置">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        </footer>
      </aside>

      <div className="main">
        <header className="bar" data-tauri-drag-region="deep">
          <span className={`dot ${live ? "ok" : ""}`} />
          <span className="muted">
            {live ? `内核在线 · ${status?.version}` : "内核未运行"}
          </span>
          {!!active && (tot.input || tot.output) && (
            <span
              className="stat"
              title={`${turns.length} 轮对话 · ${tot.steps} 次助手回复 · 输入是各步累计（每步都会重发上下文）`}
            >
              累计 · 输入 {fmtNum(tot.input)} · 输出 {fmtNum(tot.output)}
              {tot.reasoning ? ` · 思考 ${fmtNum(tot.reasoning)}` : ""}
              {tot.peak ? ` · 峰值上下文 ${fmtNum(tot.peak)}` : ""}
              {tot.cost ? ` · 成本 ${fmtNum(tot.cost, 4)}` : ""}
              {tot.ms ? ` · ${fmtDur(tot.ms)}` : ""}
            </span>
          )}
          <button
            className="ico-btn"
            onClick={() => void (live ? onStop() : onStart())}
            disabled={kernelBusy}
            title={live ? "停止内核" : "启动内核"}
            aria-label={live ? "停止内核" : "启动内核"}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 2.4v5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <path
                d="M5.1 4.7a4.2 4.2 0 1 0 5.8 0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            className={`filesbtn ${filesOpen ? "on" : ""}`}
            onClick={toggleFiles}
            title={`${filesOpen ? "收起" : "打开"}资源管理器${
              sessionDiffs.length ? ` · 当前会话 ${sessionDiffs.length} 个文件有改动` : ""
            }`}
            aria-label={filesOpen ? "收起资源管理器" : "打开资源管理器"}
            aria-pressed={filesOpen}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M1.5 4.3A1.5 1.5 0 0 1 3 2.8h2.9l1.4 1.6H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13.4H3a1.5 1.5 0 0 1-1.5-1.5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
          </button>
        </header>

        {bridge === "down" && (
          <p className="hint bridge">
            事件流中断，正在自动重连…重连后会自动补齐期间的数据
          </p>
        )}

        <div className={`body ${turns.length > 1 ? "hasrail" : ""}`} ref={body}>
          <section className="thread" ref={thread} onScroll={onScroll}>
            {!!kids.length && (
              <details className="fold kids">
                <summary>
                  子任务 {kids.length} 个
                  <span className="muted small"> · task 工具派出的独立会话</span>
                </summary>
                <ul>
                  {kids.map((k) => (
                    <li key={k.id}>
                      <button
                        className="link"
                        onClick={() => setActive(k.id)}
                        title={`子任务会话 · ${k.id}`}
                      >
                        {k.title || k.id}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {msgs.map((m, mi) => {
              // 这一轮的最后一条（再往下就是新的用户消息）后面挂这轮的小结胶囊
              const ends = mi === msgs.length - 1 || msgs[mi + 1].info.role === "user";
              const isLast = mi === msgs.length - 1;
              const turnRunning = isLast && busy;
              const tk = ends ? turnOf[mi] : "";
              const st = tk ? turnStat[tk] : undefined;
              // 最新一轮优先用事件快照（比分片里的 todowrite 新），历史轮用 part 还原
              const turnTodo = turnTodos[tk]?.length
                ? turnTodos[tk]
                : isLast && todos.length
                  ? todos
                  : st?.todos;
              return (
                <Fragment key={m.info.id}>
                  <article id={`m-${m.info.id}`} className={`msg ${m.info.role}`}>
                    <header>{label(m.info)}</header>
                    {m.info.error && (
                      <p className="error inline">
                        {m.info.error.data?.message ?? m.info.error.name}
                        {isLast && retryBtn}
                      </p>
                    )}
                    {m.parts.map((p) => (
                      <Block
                        key={p.id}
                        part={p}
                        onCopy={copy}
                        autoOpen={p.id === lastRea}
                        kid={kidOf(p)}
                      />
                    ))}
                    {m.info.role === "assistant" && usage(m.info) && (
                      <footer className="muted small">{usage(m.info)}</footer>
                    )}
                  </article>
                  {st && (
                    <>
                      <TurnSum
                        running={turnRunning}
                        pulse={editPulse}
                        steps={st.steps}
                        tools={st.tools}
                        diffs={st.diffs}
                        list={st.list}
                        onJump={jumpTo}
                        onOpenFile={openDiffFile}
                      />
                      {!turnRunning && <TurnTodo todos={turnTodo} />}
                    </>
                  )}
                </Fragment>
              );
            })}
            {busy && (
              <BusyHint
                waitingPerm={perms.length > 0}
                waitingAsk={asks.length > 0}
                retry={retry && retry.sid === active ? retry : null}
                activity={activityOf(msgs, (sid) => kidMsgs[sid])}
              />
            )}
            {!msgs.length && !busy && active && <p className="muted">等待内核回复…</p>}
          </section>

          {busy && openTodos && <TodoFly todos={todos} pulse={editPulse} />}

          {turns.length > 1 && (
            <nav className="rail" aria-label="轮次导航" onMouseLeave={() => setTip(null)}>
              <div className="railinner">
                {turns.map((m, i) => (
                  <button
                    key={m.info.id}
                    className={railHit === m.info.id ? "on" : ""}
                    onClick={() => jumpTo(m.info.id)}
                    onMouseEnter={(e) => showTip(e.currentTarget, `${i + 1} · ${turnText(m, 160)}`)}
                    onFocus={(e) => showTip(e.currentTarget, `${i + 1} · ${turnText(m, 160)}`)}
                    aria-label={`跳到第 ${i + 1} 轮`}
                  />
                ))}
              </div>
            </nav>
          )}
          <div
            className="threadbar"
            ref={bar}
            onPointerDown={barDown}
            onPointerMove={barMove}
            onPointerUp={barUp}
            onPointerCancel={barUp}
            aria-hidden="true"
          >
            <div className="threadthumb" ref={barThumb} />
          </div>
          {tip && (
            <div className="tip" style={{ top: tip.top }}>
              {tip.text}
            </div>
          )}
        </div>

        <div className="composer">
          <div className="pending">
            {asks.map((q) => (
              <QuestionCard
                key={q.id}
                q={q}
                from={kidFrom(q.sessionID)}
                onAnswer={(a) => void answerQuestion(q, a)}
                onReject={() => void rejectQuestion(q)}
              />
            ))}
            {perms.map((p) => (
              <div className="ask" key={p.id}>
                {kidFrom(p.sessionID)}
                <header>
                  <b>{PERM_CN[p.permission] ?? p.permission}</b>
                  <span>请求执行授权</span>
                </header>
                <ul className="pat">
                  {p.patterns.slice(0, 12).map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                  {p.patterns.length > 12 && <li className="muted">…共 {p.patterns.length} 条</li>}
                </ul>
                <div className="row">
                  <button className="primary" onClick={() => void answer(p, "once")}>
                    允许一次
                  </button>
                  {!!p.always?.length && (
                    <button onClick={() => void answer(p, "always")}>始终允许</button>
                  )}
                  <button onClick={() => void answer(p, "reject")}>拒绝</button>
                  <span className="grow" />
                  <span className="muted small">想少弹几次？右下角切「自动审批」</span>
                </div>
              </div>
            ))}
          </div>
          {alert && (
            <p className="hint alertbar">
              <span className="grow">
                {alert.text}
                {alert.cmd && <code>{alert.cmd}</code>}
              </span>
              <button onClick={() => setAlert(null)}>知道了</button>
            </p>
          )}
          {toast && (
            <p className="hint toast">
              <span className="grow">{toast}</span>
              <button onClick={() => setToast(null)}>知道了</button>
            </p>
          )}
          {readOnly && (
            <p className="hint robar">
              <span className="grow">
                {isChild
                  ? "子任务会话 · task 派出去的独立会话，只能看不能接着发"
                  : wsOf
                    ? `只读预览 · 这条会话属于「${baseName(wsOf)}」`
                    : "只读预览"}
              </span>
              {!isChild && wsOf && (
                <button onClick={() => switchTo(wsOf, active)}>切过去继续对话</button>
              )}
            </p>
          )}
          {!!palette.length && (
            <ul className="slash" onMouseDown={(e) => e.preventDefault()}>
              {palette.map((c, i) => (
                <li key={c.name}>
                  <button
                    className={i === hi ? "on" : ""}
                    onClick={() => accept(c)}
                    onMouseEnter={() => setHi(i)}
                    title={c.description ?? ""}
                  >
                    <b>/{c.name}</b>
                    <span className="desc">{c.description}</span>
                    {c.subtask && <span className="tag">子任务</span>}
                  </button>
                </li>
              ))}
              <li className="muted keys">
                <span className="grow">↑↓ 选择 · Tab/Enter 补全 · Esc 收起</span>
                <span>{cmds.length} 条命令</span>
              </li>
            </ul>
          )}
          {!!attachments.length && (
            <div className="attachrow" aria-label="待发送的图片">
              {attachments.map((a) => (
                <div className="attach" key={a.id}>
                  <img src={a.url} alt={a.name} title={`${a.name} · ${imgSize(a.size)}`} />
                  <span
                    className={`ocrbadge ${a.ocr?.state ?? "pending"}`}
                    title={
                      a.ocr?.state === "done"
                        ? a.ocr.text
                        : a.ocr?.state === "error"
                          ? a.ocr.error
                          : "本机 Vision OCR"
                    }
                  >
                    {ocrLabel(a.ocr)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                    title="移除这张图片"
                    aria-label={`移除 ${a.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
              <span className="muted small">
                {visionReady
                  ? "截图会随消息直接发给模型"
                  : "当前模型不能看图，发送时用本机 OCR 提取文字"}
              </span>
            </div>
          )}
          <textarea
            value={input}
            disabled={readOnly}
            placeholder={
              readOnly
                ? isChild
                  ? "子任务会话只读，回到父会话才能继续"
                  : "只读预览，切到该工作区后才能继续对话"
                : live
                  ? "描述要做的改动，可粘贴截图，/ 唤起命令，Enter 发送"
                  : "先启动内核"
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPasteImages}
          />
          <div className="row">
            <div className="ctrls">
              <button
                type="button"
                className={`modebtn ${agent === "plan" ? "on" : ""}`}
                aria-pressed={agent === "plan"}
                disabled={agent === null || !agentList.some((a) => a.name === "plan")}
                title={
                  agent === "plan"
                    ? "规划模式已开启：只能读代码、写计划文件，改不了业务代码。点这里退出规划。"
                    : "规划模式：先出计划、你确认后再动手。内核不会自己进规划模式，要在这里点。"
                }
                onClick={() => chooseAgent(agent === "plan" ? prevAgent.current : "plan")}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M3 2.6h6.4L13 6.1v7.3H3z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M5.3 6.6h5.4M5.3 9h3.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                </svg>
                规划
              </button>
              <ChipSelect
                className="agent"
                value={agent ?? ""}
                options={agentList.map((a) => ({
                  value: a.name,
                  label: `${AGENT_CN[a.name] ?? a.name} · ${a.name}`,
                  hint: AGENT_DESC_CN[a.name],
                }))}
                placeholder="agent 加载中"
                disabled={!agentList.length}
                title={
                  (agent ? AGENT_DESC_CN[agent] : undefined) ??
                  "本轮由哪个 agent 执行；规划（plan）禁用改文件工具"
                }
                onChange={chooseAgent}
              />
              <ChipSelect
                className="policy"
                value={policy}
                options={[
                  ...POLICIES.map((p) => ({ value: p.id, label: p.label, hint: p.hint })),
                  ...(policy === "custom" && rules
                    ? [{ value: "custom", label: "自定义", hint: "当前规则和三种预设都不一致" }]
                    : []),
                ]}
                placeholder="授权策略加载中"
                disabled={!rules}
                title={POLICIES.find((p) => p.id === policy)?.hint ?? "当前策略与三种预设都不一致"}
                onChange={(v) => void applyPolicy(v)}
              />
              <ChipSelect
                className="model"
                align="right"
                value={model ? `${model.providerID}/${model.modelID}` : ""}
                options={modelOptions}
                placeholder="无可用模型"
                disabled={!models.length}
                title="选择模型"
                onChange={(v) => {
                  // modelID 本身可含 /，只在第一个斜杠处分提供商
                  const i = v.indexOf("/");
                  if (i <= 0) return;
                  const next = { providerID: v.slice(0, i), modelID: v.slice(i + 1) };
                  setModel(next);
                  localStorage.setItem(MODEL_KEY, v);
                }}
              />
              {err && !lastErr && (
                <span className="error inline">
                  {err}
                  {retryBtn}
                </span>
              )}
            </div>
            <span className="grow" />
            {busy ? (
              <button
                className="send stop"
                onClick={() => active && sessions.abort(active, dir).catch((e) => setErr(String(e)))}
                title="停止"
                aria-label="停止"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.7" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                className="send"
                onClick={send}
                disabled={!live || readOnly}
                title="发送（Enter）"
                aria-label="发送"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M8 12.6V3.8M4.3 7.2 8 3.5l3.7 3.7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {filesOpen && (
        <FilePanel
          root={dir}
          session={activeSess}
          diffs={sessionDiffs}
          pulse={editPulse}
          onOpenFile={openWorkspaceFile}
          onRefreshDiffs={reloadDiffs}
          onClose={toggleFiles}
        />
      )}

      {fileView && (
        <FileViewer
          root={dir}
          file={fileView}
          startTab={fileView.tab}
          diffs={sessionDiffs}
          pulse={editPulse}
          onClose={() => setFileView(null)}
        />
      )}

      {menu && (
        <div
          className="ctx"
          ref={menuBox}
          style={{
            left: Math.min(menu.x, window.innerWidth - 172),
            top: Math.min(menu.y, window.innerHeight - (menu.items.length + 1) * 30),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.items.map((it) => (
            <button
              key={it.label}
              className={it.danger ? "danger" : ""}
              onClick={() => {
                setMenu(null);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type ChipOption = { value: string; label: string; hint?: string; group?: string; prov?: string };

/**
 * 原生 select 的展开层归系统画，改不了样式；换成自绘 listbox。
 * 支持点击外部/Esc 收起、上下键移动、Enter 选中，菜单向上弹。
 */
export function ChipSelect({
  value,
  options,
  placeholder,
  disabled,
  title,
  className,
  align = "left",
  onChange,
}: {
  value: string;
  options: ChipOption[];
  placeholder: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  align?: "left" | "right";
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const box = useRef<HTMLDivElement | null>(null);
  const cur = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function openMenu() {
    const i = options.findIndex((o) => o.value === value);
    setHi(i < 0 ? 0 : i);
    setOpen(true);
  }

  function pick(v: string) {
    setOpen(false);
    if (v !== value) onChange(v);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHi((h) => (Math.max(h, 0) + step + options.length) % options.length);
    } else if (open && e.key === "Enter") {
      e.preventDefault();
      const o = options[hi];
      if (o) pick(o.value);
    }
  }

  return (
    <div className={`chipsel ${align === "right" ? "right" : ""} ${className ?? ""}`} ref={box}>
      <button
        type="button"
        className={`chip ${open ? "open" : ""}`}
        disabled={disabled || !options.length}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="chiptx">{cur?.label ?? placeholder}</span>
        <svg className="chchev" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M3 4.7l3 3 3-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="chipmenu" role="listbox" aria-label={title}>
          {options.map((o, i) => (
            <Fragment key={o.value}>
              {o.group && o.group !== options[i - 1]?.group && (
                <div className="chipgroup">{o.group}</div>
              )}
              {o.prov && <div className="chipgroup sub">{o.prov}</div>}
              <button
                type="button"
                role="option"
              aria-selected={o.value === value}
              key={o.value}
              className={`${o.value === value ? "on" : ""} ${i === hi ? "hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(o.value)}
            >
              <span className="chiptext">
                <span className="lbl">{o.label}</span>
                {o.hint && <span className="sub">{o.hint}</span>}
              </span>
              {o.value === value && (
                <svg className="ck" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M3.6 8.3l3 3 5.8-6.4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** 右侧轮次导航的标题：取该轮用户输入的第一段真实文本 */
function turnText(m: Message, max = 24): string {
  const t = m.parts.find((p) => p.type === "text" && !((p as any).synthetic))?.text;
  const s = t?.replace(/\s+/g, " ").trim() ?? "";
  return s ? `${s.slice(0, max)}${s.length > max ? "…" : ""}` : "（空）";
}

const PERM_CN: Record<string, string> = {
  bash: "命令",
  edit: "改文件",
  write: "写文件",
  read: "读文件",
  glob: "查找文件",
  grep: "搜索",
  webfetch: "联网抓取",
  browser: "浏览器",
  task: "子任务",
};

/** 内核出厂默认就允许这两项，三种策略都留着，免得"每次询问"比默认还啰嗦 */
const ALWAYS_ALLOWED = ["websearch", "external_directory_read"];

type Policy = {
  id: string;
  label: string;
  hint: string;
  mode: BashMode;
  /** "*" 表示全部放行，其余是在内核默认之上额外自动允许的权限 */
  extra: string[];
};

const POLICIES: Policy[] = [
  {
    id: "ask",
    label: "每次询问",
    hint: "执行命令、改文件、访问网络前逐项确认",
    mode: "always_ask",
    extra: [],
  },
  {
    id: "auto",
    label: "自动审批",
    hint: "工作区内改文件直接放行；命令走内核沙箱，只在检测到风险时询问",
    mode: "sandbox",
    extra: ["edit", "write"],
  },
  {
    id: "full",
    label: "完全访问",
    hint: "不再询问，可自由访问文件、终端和网络",
    mode: "always_allow",
    extra: ["*"],
  },
];

const allowedSet = (p: Policy, rules: PermRule[]) =>
  new Set(p.extra.includes("*") ? rules.map((r) => r.permission) : [...ALWAYS_ALLOWED, ...p.extra]);

function matchPolicy(rules: PermRule[] | null, mode: BashMode | null): string {
  if (!rules || !mode) return "custom";
  for (const p of POLICIES) {
    const allow = allowedSet(p, rules);
    if (
      p.mode === mode &&
      rules.every((r) => r.action === (allow.has(r.permission) ? "allow" : "ask"))
    )
      return p.id;
  }
  return "custom";
}

function label(info: MessageInfo): string {
  if (info.role === "user") return "你";
  // 内核把每条回复实际用的 agent 记在 info.agent，切了 plan 却看不出就是白切
  const ag = info.agent && info.agent !== "build" ? ` · ${info.agent}` : "";
  const mid = info.model?.modelID ?? info.modelID;
  return mid ? `助手${ag} · ${mid}` : `助手${ag}`;
}

/** 只留人类需要的数字：step-finish / snapshot 这类内核内部标记不再单独占行 */
function usage(info: MessageInfo): string {
  const t = info.tokens ?? {};
  const n = (x: unknown) => (typeof x === "number" && x > 0 ? x : 0);
  const inp = n(t.input);
  const out = n(t.output);
  const reas = n(t.reasoning);
  const cost = n(info.cost);
  const bits: string[] = [];
  if (inp) bits.push(`输入 ${fmtNum(inp)}`);
  if (out) bits.push(`输出 ${fmtNum(out)}`);
  if (reas) bits.push(`思考 ${fmtNum(reas)}`);
  if (cost) bits.push(`成本 ${fmtNum(cost, 4)}`);
  const secs = info.time?.completed
    ? Math.max(0, Math.round((info.time.completed - info.time.created) / 100) / 10)
    : 0;
  if (secs > 0) bits.push(`${secs}s`);
  // 流式过程中 token 全 0，这行只会变成噪音
  return bits.length > 1 ? bits.join(" · ") : "";
}

/**
 * 会话级累计。注意 `tokens.input` 是每一步的整段上下文（每步都会重发），
 * 所以"累计输入"是计费口径而不是工作量；真正的工作量看输出，上下文压力看峰值。
 */
function totals(msgs: Message[]) {
  const sum = { input: 0, output: 0, reasoning: 0, cost: 0, ms: 0, steps: 0, peak: 0 };
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue;
    const t = m.info.tokens ?? {};
    const n = (x: unknown) => (typeof x === "number" && x > 0 ? x : 0);
    sum.input += n(t.input);
    sum.output += n(t.output);
    sum.reasoning += n(t.reasoning);
    sum.cost += n(m.info.cost);
    sum.peak = Math.max(sum.peak, n(t.total), n(t.input) + n(t.cache?.read));
    if (m.info.time?.completed && m.info.time?.created)
      sum.ms += Math.max(0, m.info.time.completed - m.info.time.created);
    sum.steps++;
  }
  return sum;
}

const fmtNum = (n: number, frac = 0) =>
  n.toLocaleString("zh-CN", { maximumFractionDigits: frac });

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
};

/** 只有最新一段思考自动展开，否则一轮十几段思考能把正文顶出屏 */
function lastReasoning(msgs: Message[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const parts = msgs[i].parts;
    for (let j = parts.length - 1; j >= 0; j--) if (parts[j].type === "reasoning") return parts[j].id;
  }
  return null;
}

/** 处理中要说明此刻在干什么：只有"内核处理中"四个字的时候，用户无从判断是排队还是卡死 */
/** task 工具的正文要等子会话跑完才有，中途能拿到的只有 metadata.sessionId */
const kidSid = (p: Part) => String((p.state as any)?.metadata?.sessionId ?? "");

/**
 * 底栏那句"内核处理中"唯一能说的就是最后一步在干什么。
 * task 卡住的时候父会话自己没有任何新帧，所以要顺着子会话再往下看一层。
 */
function activityOf(
  msgs: Message[],
  sub?: (sid: string) => Message[] | undefined,
): string {
  const last = [...msgs].reverse().find((m) => m.info.role === "assistant");
  const p = last?.parts[last.parts.length - 1];
  if (!last) return "排队中";
  if (!p) return "等待内核开始";
  if (p.type === "tool") {
    const st = p.state;
    if (st?.status === "running" || st?.status === "pending") {
      const head = toolHead(p);
      const label = `执行 ${p.tool ?? "工具"}${head ? ` · ${head}` : ""}`;
      const inner = p.tool === "task" ? sub?.(kidSid(p)) : undefined;
      return inner?.length ? `${label} · ${activityOf(inner, sub)}` : label;
    }
    return "生成回复";
  }
  if (p.type === "reasoning") return "思考中";
  if (p.type === "text") return "输出中";
  return "生成回复";
}

/** 处理中秒数放在叶子里，避免每秒拖整棵 Chat 重绘 */
function BusyHint({
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
        : `内核处理中 ${elapsed}s · ${activity}`;
  return (
    <p className="hint busy">
      <span className="pulse" />
      {text}
    </p>
  );
}

const Block = memo(function Block({
  part,
  onCopy,
  autoOpen,
  kid,
}: {
  part: Part;
  onCopy: (t: string) => void;
  autoOpen: boolean;
  kid?: Message[];
}) {
  switch (part.type) {
    case "text":
      // 内核会往用户消息里塞 synthetic 文本（如语言提示），不属于对话内容
      if ((part as any).synthetic || part.metadata?.synthetic) return null;
      return <pre className="text">{part.text}</pre>;
    case "reasoning":
      return <ReasoningFold part={part} autoOpen={autoOpen} />;
    case "tool":
      return <ToolCard part={part} onCopy={onCopy} kid={kid} />;
    case "file": {
      const url = String(part.url ?? "");
      const name = part.filename ?? "图片附件";
      // 图片走 data URL 进消息；直接摊 url 会把整段 base64 当正文显示
      if (
        (String(part.mime ?? "").startsWith("image/") || url.startsWith("data:image/")) &&
        (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("http"))
      ) {
        return <img className="partimg" src={url} alt={name} title={name} />;
      }
      return <p className="hint">附件：{name && name !== "图片附件" ? name : url}</p>;
    }
    // @提及的 agent：不渲染的话提名就在时间线上凭空消失
    case "agent": {
      const nm = String((part as any).name ?? "");
      return nm ? <p className="hint">@ {nm}</p> : null;
    }
    // /命令派出的子任务：prompt 就是它的全部输入，折起来可查
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
    // 压缩点：上下文被折叠的位置，留一条分隔线，回看时能解释"后面怎么变短了"
    case "compaction": {
      const c = part as any;
      return (
        <p className="hint compaction">
          {c.auto ? "上下文已自动压缩" : "上下文已压缩"}
          {c.overflow ? "（超出模型窗口）" : ""}
        </p>
      );
    }
    // 自动重试（限流/网络）：不显示就只能看到"处理中"干等
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
    // step-start / step-finish / snapshot：内核内部标记，不渲染
    default:
      return null;
  }
});

/** 思考过程：最新一段跟着流式输出展开，旧的自动收起，手动开合过就以手动为准 */
function ReasoningFold({ part, autoOpen }: { part: Part; autoOpen: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? autoOpen;
  const secs = dur(part.time);
  return (
    <details className="fold" open={open}>
      <summary onClick={() => setManual(!open)}>
        思考过程{secs && <span className="muted"> · {secs}</span>}
      </summary>
      <pre className="text muted scroll">{part.text}</pre>
    </details>
  );
}

/** 内核反问：把 header/question/options 摊成可点的选项，而不是一个 JSON 折叠卡 */
function QuestionCard({
  q,
  from,
  onAnswer,
  onReject,
}: {
  q: QuestionRequest;
  from?: ReactNode;
  onAnswer: (answers: string[][]) => void;
  onReject: () => void;
}) {
  const [picked, setPicked] = useState<string[][]>(() => q.questions.map(() => []));
  const [free, setFree] = useState<string[]>(() => q.questions.map(() => ""));
  const many = q.questions.length > 1;

  function pick(i: number, label: string) {
    setPicked((prev) =>
      prev.map((row, j) => {
        if (j !== i) return row;
        if (!q.questions[i].multiple) return row[0] === label ? [] : [label];
        return row.includes(label) ? row.filter((x) => x !== label) : [...row, label];
      }),
    );
  }

  const answers = q.questions.map((info, i) => {
    const t = free[i].trim();
    return t && info.custom !== false ? [...picked[i], t] : picked[i];
  });
  const ready = answers.every((a) => a.length);

  return (
    <div className="ask q">
      {from}
      <header>
        <b>需要你决定</b>
        <span>{many ? `${q.questions.length} 个问题，一次答完` : "选一项，内核按你的选择继续"}</span>
      </header>
      {q.questions.map((info, i) => {
        const shown = picked[i];
        return (
          <div className="qone" key={i}>
            <p className="qtext">
              {many && <span className="qno">{i + 1}</span>}
              <span>{info.header || info.question}</span>
              {info.multiple && <span className="tag">可多选</span>}
            </p>
            {info.header && info.question !== info.header && (
              <p className="muted small">{info.question}</p>
            )}
            <ul className={info.multiple ? "qopts multi" : "qopts"}>
              {info.options.map((o) => (
                <li key={o.label}>
                  <button
                    className={shown.includes(o.label) ? "on" : ""}
                    onClick={() => pick(i, o.label)}
                  >
                    <span className="box" />
                    <span className="qlabel">{o.label}</span>
                    {o.description && <span className="qdesc">{o.description}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {info.custom !== false && (
              <input
                className="qfree"
                value={free[i]}
                placeholder="或者自己写一个答案"
                onChange={(e) =>
                  setFree((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                }
              />
            )}
          </div>
        );
      })}
      <div className="row">
        <button className="primary" disabled={!ready} onClick={() => onAnswer(answers)}>
          提交回答
        </button>
        <button onClick={onReject}>不回答</button>
        <span className="grow" />
        {!ready && <span className="muted small">每个问题至少选一项</span>}
      </div>
    </div>
  );
}

/**
 * 一行状态回显（"Wrote file successfully."）没什么可复制的，只有真正的代码/文件内容才给角标，
 * 否则每条工具消息上都挂一个按钮，等于没有。
 */
const worthCopy = (t: string) => t.includes("\n") || t.length >= 120;

/** 工具块的复制角标：悬浮或键盘聚焦才显形，挂在 wrapper 上不随块内滚动跑掉 */
function Copyable({
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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
    </div>
  );
}

const STATE_CN: Record<string, string> = {
  pending: "等待中",
  running: "执行中",
  completed: "完成",
  error: "失败",
};

/** 工具状态角标：ToolCard 与 KidLog 共用一套配色与文案 */
function StatusChip({ status }: { status: string }) {
  return <span className={`st ${status}`}>{STATE_CN[status] ?? status}</span>;
}

/** 改动清单里的状态字母（git 风格） */
const FSTATUS_CN: Record<string, string> = { added: "A", deleted: "D", modified: "M" };

const dur = (t?: { start?: number; end?: number }) =>
  t?.start && t?.end && t.end >= t.start ? `${((t.end - t.start) / 1000).toFixed(1)}s` : "";

/** 这些工具的入参本身就写在标题行里，再摊一份 JSON 只会把正文挤成一堵墙 */
const SELF_EXPLANATORY = new Set([
  "read",
  "list",
  "grep",
  "glob",
  "edit",
  "write",
  "bash",
  "webfetch",
  // 反问的选项已经在下方摊成卡片了，卡片里再 dump 一遍 questions JSON 只会挡路
  "question",
  // 待办清单有专门的排版，见 TodoList
  "todowrite",
]);

const baseName = (p: unknown) => {
  const s = String(p ?? "");
  return s.replace(/\/+$/, "").split("/").pop() || s;
};

/** 标题行取最能说明"在干什么"的那个字段：bash 用它的 description，读写用文件名，检索用 pattern */
function toolHead(part: Part): string {
  const s = part.state as any;
  const i = (s?.input ?? {}) as Record<string, any>;
  const title = String(s?.title ?? "").replace(/\s+/g, " ").trim();
  const qs = i.questions as any[] | undefined;
  const td = i.todos as any[] | undefined;
  const raw =
    part.tool === "bash"
      ? (i.description ?? title ?? i.command)
      : part.tool === "read" || part.tool === "edit" || part.tool === "write"
        ? baseName(i.filePath ?? i.path ?? title)
        : part.tool === "grep" || part.tool === "glob"
          ? i.pattern
          : part.tool === "webfetch"
            ? i.url
            : part.tool === "question" && qs?.length
              ? `${qs[0].header ?? qs[0].question}${qs.length > 1 ? ` 等 ${qs.length} 个问题` : ""}`
              : part.tool === "todowrite" && td?.length
                ? `${td.length} 项待办`
                : title;
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

/**
 * 内核的 `output` 外面套了 `<path>/<type>/<content>` 这类给模型看的包装，
 * `metadata.preview` 才是同一份内容的人读版，直接摊 output 会满屏标签。
 */
function toolResult(part: Part): { text: string; truncated: boolean } {
  const s = part.state as any;
  const meta = s?.metadata ?? {};
  const preview = typeof meta.preview === "string" ? meta.preview : "";
  return {
    text: preview.trim() ? preview : String(s?.output ?? ""),
    truncated: !!meta.truncated,
  };
}

function ToolCard({
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
  const args = (s as any)?.input as Record<string, any> | undefined;
  const cmd = part.tool === "bash" ? String(args?.command ?? "") : "";
  const json =
    !cmd && args && !SELF_EXPLANATORY.has(part.tool ?? "") && Object.keys(args).length
      ? JSON.stringify(args, null, 2)
      : "";
  const { text: result, truncated } = toolResult(part);
  const err = status === "error" ? String((s as any)?.error ?? "") : "";
  const head = toolHead(part);
  /** `todowrite` 的 input 与 output 是同一份清单，摊成清单看，两边都不再 dump */
  const todos =
    part.tool === "todowrite"
      ? (args?.todos as Todo[] | undefined)
      : part.tool === "todoread"
        ? parseTodos((s as any)?.output)
        : undefined;
  // 执行中自动展开，跑完自动收起；用户手动开合过就以他为准
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? status !== "completed";
  return (
    <details className="fold tool" open={open}>
      <summary onClick={() => setManual(!open)}>
        <b>{part.tool ?? "工具"}</b>
        {head && <span className="arg">{head}</span>}
        <StatusChip status={status} />
      </summary>
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
        <KidLog
          msgs={kid}
          running={status === "pending" || status === "running"}
        />
      ) : null}
      {err && <pre className="code err">{err}</pre>}
      {!err && !todos && result && (
        <Copyable text={result} onCopy={onCopy}>
          <pre className="code out">{result}</pre>
        </Copyable>
      )}
      {!err && !todos && truncated && <p className="hint">输出已被内核截断</p>}
    </details>
  );
}

/** 待办清单：状态用符号 + 颜色双通道，只靠颜色在深色模式下分不出来 */
const TODO_CN: Record<string, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "完成",
  cancelled: "已取消",
};

const TODO_MARK: Record<string, string> = {
  in_progress: "▶",
  completed: "✓",
  cancelled: "✕",
};

/** `todoread`（内核默认 deny，放开就会用到）把清单放在 output 的 JSON 字符串里；解不出来就照旧摊原文 */
function parseTodos(raw: unknown): Todo[] | undefined {
  try {
    const v = JSON.parse(String(raw ?? ""));
    return Array.isArray(v) && v.every((x) => typeof x?.content === "string") ? (v as Todo[]) : undefined;
  } catch {
    return undefined;
  }
}

/** 一行进度。取消单独列出来，免得它被算进"已完成"里看着像做完了 */
function todoProg(todos: Todo[]): string {
  const done = todos.filter((t) => t.status === "completed").length;
  const gone = todos.filter((t) => t.status === "cancelled").length;
  return done + gone === 0
    ? `${todos.length} 项待办`
    : `已完成 ${done} / ${todos.length}${gone ? ` · 取消 ${gone}` : ""}`;
}

function TodoRows({ todos }: { todos: Todo[] }) {
  return (
    <ol className="todoRows">
      {todos.map((t, i) => (
        <li key={i} className={t.status}>
          <span className="mk" aria-hidden="true">
            {TODO_MARK[t.status] ?? "○"}
          </span>
          <span className="tx">{t.content}</span>
          {t.priority === "high" && <span className="tag">高优</span>}
          <span className="muted small st-cn">{TODO_CN[t.status] ?? t.status}</span>
        </li>
      ))}
    </ol>
  );
}

type TurnStat = {
  steps: number;
  tools: number;
  diffs: FileDiff[];
  /** 每一步一行的摘要，胶囊展开时列出来 */
  list: { id: string; label: string }[];
  /** 重开会话时事件快照没了，从这一轮的 todowrite part 还原清单 */
  todos: Todo[];
};

/** `todowrite` 的入参就是整份清单；`todoread` 则把 JSON 放在 output 里 */
function todosOfPart(part: Part): Todo[] | undefined {
  if (part.type !== "tool" || (part.tool !== "todowrite" && part.tool !== "todoread")) return undefined;
  const s = part.state as any;
  const input = s?.input?.todos;
  if (Array.isArray(input) && input.every((x: any) => typeof x?.content === "string")) {
    return input as Todo[];
  }
  return part.tool === "todoread" ? parseTodos(s?.output) : undefined;
}

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * 一步（一条助手消息）的一行摘要。跑着的那步报"现在在干什么"（盯最新一个 part），
 * 跑完的那步报整步要点：优先旁白文本，其次第一个工具，再退到子任务/思考。
 */
function stepLabel(m: Message, running: boolean): string {
  const tools = m.parts.filter((p) => p.type === "tool");
  const text = m.parts
    .filter((p) => p.type === "text" && !(p as any).synthetic)
    .map((p) => String((p as any).text ?? ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (running) {
    const p = m.parts[m.parts.length - 1];
    if (p?.type === "tool") {
      const head = toolHead(p);
      return clip(`执行 ${p.tool ?? "工具"}${head ? ` · ${head}` : ""}`);
    }
    if (p?.type === "reasoning") return "思考中…";
    if (p?.type === "subtask") return clip(`子任务 · ${String((p as any).description ?? "").trim()}`);
    if (text) return clip(text);
    return "等待模型响应…";
  }
  if (text) return clip(text);
  if (tools.length) return clip(toolHead(tools[0]));
  const sub = m.parts.find((p) => p.type === "subtask");
  if (sub) return clip(`子任务 · ${String((sub as any).description ?? (sub as any).agent ?? "").trim()}`);
  if (m.parts.some((p) => p.type === "reasoning")) return "思考";
  return "（空）";
}

/**
 * 以用户消息切轮：统计每轮的助手步数、工具次数、改动明细（取该用户消息上的 summary.diffs，
 * 内核按轮写入；session.diff 是全轮累计口径，不用），并给每一步拉一行摘要。
 * 正在跑的那轮最后一步的摘要按"现在在干什么"实时算，时间线每来一帧就跟着刷新。
 */
function turnsOf(msgs: Message[], busy: boolean): { stat: Record<string, TurnStat>; owner: string[] } {
  const stat: Record<string, TurnStat> = {};
  const owner: string[] = [];
  const stepMsgs: Record<string, Message[]> = {};
  let cur = "";
  msgs.forEach((m) => {
    if (m.info.role === "user") {
      cur = m.info.id;
      const d = (m.info as any).summary?.diffs;
      stat[cur] = {
        steps: 0,
        tools: 0,
        diffs: Array.isArray(d) ? (d as FileDiff[]) : [],
        list: [],
        todos: [],
      };
      stepMsgs[cur] = [];
    }
    owner.push(cur);
    const s = stat[cur];
    if (s && m.info.role !== "user") {
      if (m.info.role === "assistant") {
        s.steps += 1;
        stepMsgs[cur].push(m);
      }
      for (const p of m.parts) {
        const t = todosOfPart(p);
        if (t) s.todos = t;
      }
      // subtask 是 task 工具的另一种呈现形态，同源，两边都算才不漏"派活"这步
      s.tools += m.parts.filter((p) => p.type === "tool" || p.type === "subtask").length;
    }
  });
  const runKey = busy && owner.length ? owner[owner.length - 1] : "";
  for (const k of Object.keys(stat)) {
    const arr = stepMsgs[k];
    stat[k].list = arr.map((m, i) => ({
      id: m.info.id,
      label: stepLabel(m, k === runKey && i === arr.length - 1),
    }));
  }
  return { stat, owner };
}

/**
 * 一轮对话的执行小结：只报步骤和文件改动，待办清单单独由 TurnTodo 挂在轮末。
 * 收起就一行「✓ 步骤 N / N · F 个文件已修改 +a -d」，展开看每一步做了什么。
 */
function TurnSum({
  running,
  pulse,
  steps,
  tools,
  diffs,
  list,
  onJump,
  onOpenFile,
}: {
  running: boolean;
  pulse: number;
  steps: number;
  tools: number;
  diffs: FileDiff[];
  list: { id: string; label: string }[];
  onJump?: (id: string) => void;
  onOpenFile?: (d: FileDiff) => void;
}) {
  if (!running && !tools && !diffs.length) return null;
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
        <span>{running ? (steps ? `正在执行 · ${steps} 步` : "正在执行…") : `步骤 ${steps} / ${steps}`}</span>
        {!!diffs.length && (
          <span className="muted">
            · {diffs.length} 个文件已修改
            {(add > 0 || del > 0) && (
              <>
                {" "}
                <span className="add">+{add}</span> <span className="del">-{del}</span>
              </>
            )}
          </span>
        )}
      </summary>
      {!!list.length && (
        <ol className="steplist">
          {list.map((s, i) => (
            <li key={s.id} className={running && i === list.length - 1 ? "now" : ""}>
              <span className="no">{i + 1}</span>
              <button className="tx" onClick={() => onJump?.(s.id)} title="跳到这条消息">
                {s.label}
              </button>
              {running && i === list.length - 1 && <span className="pulse-dot" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      )}
      {!!diffs.length && (
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
      )}
    </details>
  );
}

const doneCount = (todos: Todo[]) =>
  todos.filter((t) => t.status === "completed" || t.status === "cancelled").length;

/**
 * 轮末待办：与步骤胶囊分开，收在该轮最底部。跑着的时候不在这里出现，
 * 由 TodoFly 悬浮展示；一轮结束后才落到这里，回看时按轮归档。
 */
function TurnTodo({ todos }: { todos?: Todo[] }) {
  if (!todos?.length) return null;
  const done = doneCount(todos);
  const all = done === todos.length;
  const doing = todos.find((t) => t.status === "in_progress");
  return (
    <details className="fold turnTodo">
      <summary>
        <span className={all ? "ck" : "pin"} aria-hidden="true">
          {all ? "✓" : "☐"}
        </span>
        <span>待办 {done} / {todos.length}</span>
        {!all && doing && <span className="muted"> · {doing.content}</span>}
      </summary>
      <TodoRows todos={todos} />
    </details>
  );
}

/** 运行中的悬浮清单：绝对定位在对话区右上角，不随消息滚走，可折叠 */
function TodoFly({ todos, pulse }: { todos: Todo[]; pulse: number }) {
  const [fold, setFold] = useState(false);
  if (!todos.length) return null;
  const done = doneCount(todos);
  return (
    <aside className={`todofly ${fold ? "folded" : ""}`} aria-label="运行中的待办清单">
      <button
        type="button"
        className="tfhead"
        onClick={() => setFold((v) => !v)}
        aria-expanded={!fold}
        title={fold ? "展开待办清单" : "收起待办清单"}
      >
        <span className="pulse-dot" key={pulse} aria-hidden="true" />
        <b>待办清单</b>
        <span className="tfprog">
          {done}/{todos.length}
        </span>
        <span className="grow" />
        <span className="tfchev" aria-hidden="true">
          {fold ? "▸" : "▾"}
        </span>
      </button>
      {!fold && <TodoRows todos={todos} />}
    </aside>
  );
}

/**
 * 子任务（explore/build 等 subagent）的实时进展。内核把它的每一次检索、每一次读文件
 * 都作为独立会话的 tool part 推出来，接住了才不是一句"执行 task"干等几十分钟。
 */
function KidLog({ msgs, running }: { msgs: Message[]; running: boolean }) {
  const steps = msgs.flatMap((m) => m.parts).filter((p) => p.type === "tool");
  const replies = msgs.filter((m) => m.info.role === "assistant");
  if (!running && !steps.length) return null;
  // 子 agent 每步前面都会自己播报一句，跟着这句走比只看工具名清楚
  const last = replies[replies.length - 1];
  const narr = running && last ? turnText(last, 90) : "";
  return (
    <div className="kidlog">
      <p className="muted small">
        {running
          ? `进展 · ${activityOf(msgs)}${narr && narr !== "（空）" ? ` · ${narr}` : ""}`
          : `共 ${steps.length} 步 · ${replies.length} 次回复`}
      </p>
      {!!steps.length && (
        <ol>
          {steps.map((p) => {
            const st = p.state?.status ?? "pending";
            const head = toolHead(p);
            return (
              <li key={p.id}>
                <StatusChip status={st} />
                <b>{p.tool ?? "工具"}</b>
                {head && <span className="arg">{head}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
