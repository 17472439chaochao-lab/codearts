import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  agents,
  api,
  commands,
  exportMarkdown,
  isSyntheticPart,
  normalizeProviders,
  permissionConfig,
  permissions,
  questions,
  sessions,
  vcs,
  type AgentInfo,
  type BashMode,
  type CommandInfo,
  type FileDiff,
  type KernelEvent,
  type Message,
  type ModelInfo,
  type ModelRef,
  type Part,
  type PermRule,
  type PermissionRequest,
  type QuestionRequest,
  type Session,
  type Todo,
  type VcsInfo,
} from "./kernelApi";
import { APP_TITLE, useAppVersion, type KernelStatus } from "./App";
import { FilePanel, FileViewer, QuickOpen, relInRoot, type OpenFile } from "./Files";
import type { GitState } from "./GitBranch";
import { exportName, sessionMarkdown } from "./sessionExport";
import { getNotifyPrefs } from "./notify";
import { applyMessageEvents, MESSAGE_EVENTS, reconcileMessages, recordSnapshotEvent, type SnapshotChanges } from "./messageState";
import { ConversationWindow } from "./ConversationWindow";
import { sameDir } from "./workspaceUtils";
import { slashToken, slashMatches, expandSlash } from "./slashCommands";
import { type ChipOption } from "./components/ChipSelect";
export { ChipSelect, type ChipOption } from "./components/ChipSelect";
import {
  type Attachment,
  type QueuedPrompt,
  type MenuItem,
  type Menu,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  DEFAULT_TITLES,
  imageTitle,
  readImage,
} from "./chatTypes";
import { POLICIES, matchPolicy, allowedSet } from "./policyUtils";
import { ContextMenu } from "./components/chat/ContextMenu";
import { TurnRail } from "./components/chat/TurnRail";
import { Sidebar } from "./components/chat/Sidebar";
import { StatsModal } from "./components/StatsModal";
import { ChatHeader } from "./components/chat/ChatHeader";
import { PermBar } from "./components/chat/PermBar";
import { ChatInput } from "./components/chat/ChatInput";
import { TodoFly } from "./components/chat/TodoView";
import { toolHead } from "./components/chat/ToolViews";
import {
  TurnRow,
  BusyHint,
  turnsOf,
  estimateTurnHeight,
  fmtNum,
  fmtSpan,
  type TurnRowData,
  type TurnStat,
  type TurnGroups,
} from "./components/chat/TurnViews";

type Props = {
  projectDir: string;
  projects: string[];
  status: KernelStatus | null;
  busy: boolean;
  keepAwake: boolean;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onAddDir: () => void;
  onSwitchDir: (dir: string) => void;
  onDropDir: (dir: string) => void;
  /** 设置页同步过第三方模型：免重启的那条路不换端口，靠这个计数触发重拉 */
  provTick: number;
  onOpenSettings: () => void;
};



/** 上次用的模型：内核 /provider 的 default 每次重启都可能变，用户的选择要自己记住 */
export const MODEL_KEY = "codearts.model";
export const AGENT_KEY = "codearts.agent";
/** 文件栏默认展开；用户收起一次之后记住 */
export const FILES_KEY = "codearts.filesPanel";
/** 置顶的会话 id（localStorage）。置顶排在各自工作区的最前面，跨工作区共用一份 */
const PIN_KEY = "codearts.pins";

/** 规划轮的回复短于这么多字符就不当计划存盘（真计划是千字级，「确认无误」这种不算） */
const MIN_PLAN_CHARS = 120;
/** 改动快照带前后全文，agent 连续改文件时别每 0.7 秒就重取一次，至少隔这么久 */
const DIFF_MIN_GAP_MS = 2500;

/** 内核用来起标题、做摘要、压缩上下文的内部 agent，选它们当主对话只会得到一句废话 */
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"]);

export default function Chat({
  projectDir,
  projects,
  status,
  busy: kernelBusy,
  keepAwake,
  onStart,
  onStop,
  onAddDir,
  onSwitchDir,
  onDropDir,
  provTick,
  onOpenSettings,
}: Props) {
  const live = status?.healthy ?? false;
  const dir = projectDir;
  const ver = useAppVersion();

  const [list, setList] = useState<Session[]>([]);
  const [active, setActive] = useState<string | null>(null);
  /** 侧栏过滤框：按标题和会话 id 过滤，输入时临时展开所有匹配（不受 SIDE_PAGE 限制） */
  const [query, setQuery] = useState("");
  /** 置顶集合：置顶的会话在各自工作区里排最前 */
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(PIN_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  /** 每个工作区已展开的会话条数；缺省按 SIDE_PAGE（工作区本身不再折叠） */
  const [sessShown, setSessShown] = useState<Record<string, number>>({});
  /** 异步回填对比用：listener / fetch 完成时 active 可能已变 */
  const activeRef = useRef<string | null>(null);
  activeRef.current = active;
  /** 界面当前工作区；监听器与 resync 都是常驻闭包，取值走 ref */
  const dirRef = useRef(dir);
  dirRef.current = dir;
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
  /**
   * 阻止休眠：设置开着、且确实有会话在跑才握断言，全空闲立刻松。
   * 只在翻转时发一次 invoke，免得每个 busy 事件都去动子进程。
   */
  const wakeHeld = useRef(false);
  useEffect(() => {
    const want = keepAwake && busySet.size > 0;
    if (want === wakeHeld.current) return;
    wakeHeld.current = want;
    invoke("no_sleep_set", { hold: want }).catch(() => {});
  }, [keepAwake, busySet]);
  useEffect(
    () => () => {
      if (!wakeHeld.current) return;
      wakeHeld.current = false;
      invoke("no_sleep_set", { hold: false }).catch(() => {});
    },
    [],
  );
  /** 内核自动重试（限流/网络）时的详情；只在它所属的会话上显示 */
  const [retry, setRetry] = useState<{ sid: string; attempt: number; message: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** 内核检测到危险命令（无 sessionID，全局提示），单独一条红色告警栏 */
  const [alert, setAlert] = useState<{ text: string; cmd: string } | null>(null);
  /** 事件流链路状态：断线期间帧会丢，重连后要补拉一次数据 */
  const [bridge, setBridge] = useState<"open" | "down">("open");
  /** 最近一次断线原因：横幅不展开，但鼠标悬停能看，出问题时可截图定位 */
  const [bridgeMsg, setBridgeMsg] = useState<string | null>(null);
  const bridgeDown = useRef(false);
  /** file.edited 的脉冲：让正在跑的那轮小结胶囊跳动一下 */
  const [editPulse, setEditPulse] = useState(0);
  /** 标题兜底计时器：按会话 id 归堆，卸载或删会话时统一撤销 */
  const titleTimers = useRef(new Map<string, number[]>());
  /** 各会话的消息排队列表：忙时排队，空闲后自动顺延发送 */
  const [sessionQueues, setSessionQueues] = useState<Record<string, QueuedPrompt[]>>({});
  const sessionQueuesRef = useRef(sessionQueues);
  sessionQueuesRef.current = sessionQueues;
  const processNextInQueueRef = useRef<(sid: string) => void>(() => {});
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
  /** 内核的 question 工具在等人选项：不接住就只能看着一张 JSON 卡片卡在"执行中" */
  const [asks, setAsks] = useState<QuestionRequest[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const modelsRef = useRef<ModelInfo[]>([]);
  modelsRef.current = models;
  const [model, setModel] = useState<ModelRef | null>(null);
  const modelRef = useRef<ModelRef | null>(null);
  modelRef.current = model;
  const [rules, setRules] = useState<PermRule[] | null>(null);
  const [bashMode, setBashMode] = useState<BashMode | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  // 用户往上翻的时候不能再被拽回底部
  const stick = useRef(true);
  const [following, setFollowing] = useState(true);
  const scrollDirection = useRef<"up" | "down" | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const followFrame = useRef(0);
  const setFollow = useCallback((value: boolean) => {
    stick.current = value;
    setFollowing(value);
  }, []);
  const followLatest = useCallback(() => {
    setFollow(true);
    scrollDirection.current = null;
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [setFollow]);
  const sending = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const [railHit, setRailHit] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const barThumb = useRef<HTMLDivElement>(null);
  const barTimer = useRef<number | null>(null);
  const barDrag = useRef<{ y: number; top: number; k: number } | null>(null);
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
  const messageStore = useRef(new Map<string, Message[]>());
  const messageEpoch = useRef(0);
  const messageRequests = useRef(new Map<string, number>());
  const messagePending = useRef(new Map<string, SnapshotChanges>());
  const messageRepairs = useRef(new Map<string, { timer: number; run: () => void }>());
  const messageSettled = useRef(new Map<string, (messages: Message[]) => void>());
  const delayMessageRepair = useCallback((sid: string) => {
    const repair = messageRepairs.current.get(sid);
    if (!repair) return;
    window.clearTimeout(repair.timer);
    repair.timer = window.setTimeout(() => {
      messageRepairs.current.delete(sid);
      repair.run();
    }, 200);
  }, []);
  const flushMessages = useRef(() => {});
  const updateMessages = useCallback((sid: string, next: Message[]) => {
    if (messageStore.current.get(sid) === next) return;
    messageStore.current.set(sid, next);
    if (sid === activeRef.current) setMsgs(next);
    else setKidMsgs((prev) => ({ ...prev, [sid]: next }));
  }, []);
  const readMessages = useCallback(async (sid: string, directory: string, settled?: (messages: Message[]) => void): Promise<Message[] | undefined> => {
    flushMessages.current();
    window.clearTimeout(messageRepairs.current.get(sid)?.timer);
    messageRepairs.current.delete(sid);
    if (settled) messageSettled.current.set(sid, settled);
    const epoch = messageEpoch.current;
    const request = (messageRequests.current.get(sid) ?? 0) + 1;
    messageRequests.current.set(sid, request);
    const baseline = messageStore.current.get(sid) ?? [];
    const changes: SnapshotChanges = { dirty: false, messages: new Set(), parts: new Set() };
    messagePending.current.set(sid, changes);
    let snapshot: Message[];
    try {
      snapshot = await sessions.messages(sid, directory);
    } finally {
      if (messagePending.current.get(sid) === changes) messagePending.current.delete(sid);
    }
    if (epoch !== messageEpoch.current || request !== messageRequests.current.get(sid)) return;
    flushMessages.current();
    const next = reconcileMessages(messageStore.current.get(sid) ?? [], snapshot, baseline, changes);
    updateMessages(sid, next);
    if (changes.dirty) {
      // HTTP 快照与 SSE 没有共同序号；等输出间隙再取权威快照，不按文字猜测重叠部分。
      messageRepairs.current.set(sid, { timer: 0, run: () => { void readMessages(sid, directory).catch(() => {}); } });
      delayMessageRepair(sid);
      return;
    }
    const onSettled = messageSettled.current.get(sid);
    messageSettled.current.delete(sid);
    onSettled?.(next);
    return next;
  }, [updateMessages, delayMessageRepair]);
  useLayoutEffect(() => {
    messageEpoch.current++;
    messageStore.current.clear();
    messageRequests.current.clear();
    messagePending.current.clear();
    messageSettled.current.clear();
    for (const repair of messageRepairs.current.values()) window.clearTimeout(repair.timer);
    messageRepairs.current.clear();
    kidIds.current.clear();
    setMsgs([]);
    setKidMsgs({});
    setTurnTodos({});
    setTodos([]);
    return () => {
      messageEpoch.current++;
      for (const repair of messageRepairs.current.values()) window.clearTimeout(repair.timer);
      messageRepairs.current.clear();
      messagePending.current.clear();
      messageSettled.current.clear();
    };
  }, [active, live]);
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
  /** ⌘P 快捷打开浮层 */
  const [quickOpen, setQuickOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  /** 当前工作区的 Git 分支；内核 /vcs 在非 git 目录回空对象，那时不显示 */
  const [branch, setBranch] = useState<VcsInfo | null>(null);
  /** 分支列表 / 游离 HEAD / 未提交改动数，由壳侧的 git 命令读取 */
  const [gitState, setGitState] = useState<GitState | null>(null);
  /** 窗口重新获得焦点就重读一次分支：用户可能在终端里 checkout 过 */
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    const onFocus = () => setFocusTick((t) => t + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

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
  /** 通知里要写会话标题：监听器是常驻闭包，取值走 ref */
  const listRef = useRef(list);
  listRef.current = list;

  /**
   * 后台会话跑完给一条 macOS 通知：多工作区切走之后，不提示就只能靠记性等结果。
   * 弹不弹由「设置 → 通知」里的偏好决定（总开关、只在窗口不在前台时提醒、
   * 子任务是否也提醒、是否带提示音）。
   * 系统权限只主动申请一次；之后每次都用 isPermissionGranted 复查——
   * 用户中途在系统设置里打开了权限，下一次就能正常弹出来。
   */
  const askedPermission = useRef(false);
  /**
   * 进入过运行态的会话：只有它们收尾才值得弹通知。
   * 别的客户端（TUI / 另一个壳）在同一条事件流里也会发 idle，不拦就会乱弹。
   */
  const runSeen = useRef<Set<string>>(new Set());
  const notifyDone = useCallback(async (sid: string) => {
    const prefs = getNotifyPrefs();
    if (!prefs.enabled) return;
    if (kidIds.current.has(sid) && !prefs.subagents) return;
    if (prefs.onlyWhenAway && sid === activeRef.current && document.hasFocus()) return;
    try {
      let ok = await isPermissionGranted();
      if (!ok && !askedPermission.current) {
        askedPermission.current = true;
        ok = (await requestPermission()) === "granted";
      }
      if (!ok) return;
      const title = listRef.current.find((s) => s.id === sid)?.title || "会话";
      sendNotification({
        title: `${APP_TITLE} · 会话已完成`,
        body: title,
        ...(prefs.sound ? { sound: "Ping" } : {}),
      });
    } catch {
      // 没有通知权限或不是签名构建：静默跳过，不打扰主流程
    }
  }, []);
  const notifyRef = useRef(notifyDone);
  notifyRef.current = notifyDone;

  // 内核不在线时不发：api_request 的 ensure_running 会顺手再 start()，
  // 两个启动互相顶掉 boot 代数，结果报"内核启动被取消"
  useEffect(() => {
    if (live) reloadList();
  }, [reloadList, live]);

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
      // 但内核刚拉起那几秒的连接失败是瞬时的，缓一下再报，免得切个区闪一条红字
      .catch((e) => {
        rejectTimer = window.setTimeout(() => {
          if (alive) setErr(`模型列表获取失败：${e}`);
        }, 1500);
      });
    return () => {
      alive = false;
      window.clearTimeout(rejectTimer);
    };
  }, [live, dir, status?.port, provTick]);

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
   * 会话属于哪个工作区，一律以内核的 session.directory 为准。
   * 切区不再重启内核，后台会话随时可能属于别的区；写路径拿错目录时内核不报错，
   * reply 之类会对着空队列静默成功（契约文档 §11），所以每处都要显式带上归属区。
   */
  const dirOf = useCallback(
    (sid?: string | null): string => {
      if (!sid) return dir;
      const s = list.find((x) => x.id === sid) ?? kids.find((x) => x.id === sid);
      if (s?.directory) return s.directory;
      // 子会话的 payload 有时不带 directory，退回父会话的区
      const parent = s?.parentID ? list.find((x) => x.id === s.parentID) : undefined;
      return parent?.directory ?? dir;
    },
    [list, kids, dir],
  );
  const dirOfRef = useRef(dirOf);
  dirOfRef.current = dirOf;
  /**
   * 内核每条会话都带真实 directory 和 parentID，归属与子任务标记直接读它。
   * 注意 `GET /session` 也会列出 task 派出去的子会话，所以只读判定靠 parentID，
   * 不靠"是不是从子任务折叠里点进来的"。
   */
  const activeSess = list.find((s) => s.id === active) ?? null;
  /** 当前会话归属的区；没打开会话时为 null，读写都退回界面当前区 */
  const wsOf = active ? dirOf(active) : null;
  /**
   * 界面右侧一切（资源管理器、快速打开、文件大窗、分支）都跟着会话所在的区走。
   * 免重启切区之后跨区会话是能直接对话的，右侧还钉在界面当前区就会出现
   * "点在别的区的会话、翻的却是原来那个区的文件"这种错位。
   */
  const wsDir = wsOf ?? dir;
  const wsOfRef = useRef(wsOf);
  wsOfRef.current = wsOf;
  // 子会话可能还没进 list（noteKid 先到），activeSess 找不到时也要按子会话处理
  const isChild = !!activeSess?.parentID || kids.some((k) => k.id === active);
  /** 跨工作区也能直接对话：只有子会话（只读展示）才禁编辑 */
  const readOnly = !!active && isChild;
  const busy = !!active && busySet.has(active);

  // 换到别的区的会话时，底下那个文件大窗已经不属于这个根了，直接关掉，别让它继续按新根去解析旧相对路径
  useEffect(() => {
    setFileView(null);
  }, [wsDir]);

  // 分支是工作区的属性：换区、点开别的区的会话、内核上下线、每轮起停各取一次
  // （内核现读 git，很便宜）。壳侧的 git_branches 顺带给出游离 HEAD 与未提交改动数。
  useEffect(() => {
    if (!live || !wsDir) {
      setBranch(null);
      setGitState(null);
      return;
    }
    let alive = true;
    vcs
      .info(wsDir)
      .then((r) => {
        if (alive) setBranch(r);
      })
      .catch(() => {
        // 拿不到就不显示分支，别在顶栏挂个错误条
        if (alive) setBranch(null);
      });
    invoke<GitState>("git_branches", { directory: wsDir })
      .then((st) => {
        if (alive) setGitState(st);
      })
      .catch(() => {
        // 顶栏有 /vcs 的分支名就够用了，git 读不到时只是不给切
        if (alive) setGitState(null);
      });
    return () => {
      alive = false;
    };
  }, [wsDir, live, busy, focusTick]);

  /** 切完分支：顶栏跟着换名字，文件树与 diff 按新分支重读 */
  function onBranchSwitched(st: GitState) {
    setGitState(st);
    setBranch((b) => ({ ...(b ?? {}), branch: st.current ?? undefined }));
    setEditPulse((v) => v + 1);
    setToast(st.current ? `已切到分支 ${st.current}` : `已切到游离 HEAD ${st.head ?? ""}`.trim());
  }

  /** ⌘P 快捷打开；内核没起来时不接管，免得按一下就把它拉起来 */
  useEffect(() => {
    if (!live) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.isComposing) return;
      if (e.key.toLowerCase() === "p" && !e.shiftKey) {
        e.preventDefault();
        setQuickOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live]);
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
        // 内核塞的提示（如语言说明）不算用户输入，重发时不能带回去
        if (isSyntheticPart(p)) return [];
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
  /** 上次重取改动的时间 */
  const diffsAt = useRef(0);

  useEffect(() => {
    setSessionDiffs([]);
    diffsAt.current = Date.now();
    reloadDiffs();
  }, [reloadDiffs]);

  // file.edited 可能一轮里来几十次，收拢成一次重取；diff 带前后全文，
  // 所以再加下限间隔，只在最后一轮 idle 时补一次精确结果
  useEffect(() => {
    if (!editPulse) return;
    const wait = Math.max(700, DIFF_MIN_GAP_MS - (Date.now() - diffsAt.current));
    const t = window.setTimeout(() => {
      diffsAt.current = Date.now();
      reloadDiffs();
    }, wait);
    return () => window.clearTimeout(t);
  }, [editPulse, reloadDiffs]);

  /**
   * agent 与斜杠命令都是工作区相关的：/agent 会带上这个项目 .codearts 里定义的
   * 角色，/command 也是。跨区对话时这一轮跑在会话自己那个实例里，所以取它的区。
   */
  useEffect(() => {
    if (!live) {
      setCmds([]);
      setAgentList([]);
      return;
    }
    const d = wsOf ?? dir;
    commands
      .list(d)
      .then(setCmds)
      .catch(() => setCmds([]));
    agents
      .list(d)
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
  }, [live, dir, wsOf, chooseAgent]);

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
    const epoch = messageEpoch.current;
    sessions
      .children(parent, wsOf ?? dir)
      .then((ks) => {
        if (activeRef.current !== parent || messageEpoch.current !== epoch) return;
        setKids(ks);
        for (const k of ks) {
          kidIds.current.add(k.id);
          const kid = k.id;
          void readMessages(kid, k.directory ?? wsOf ?? dir).catch(() => {});
        }
      })
      .catch(() => {
        if (activeRef.current === parent && messageEpoch.current === epoch) setKids([]);
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
    readMessages(sid, wsOf ?? dir)
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

  // 换工作区只是换界面在看哪个区：不属于新区的会话先收起，跨区点开的那条继续开着。
  // 忙状态不能清——后台会话还在它自己的实例里出活。
  useEffect(() => {
    setActive((cur) => (cur && sameDir(dirOfRef.current(cur), dir) ? cur : null));
    setRetry(null);
    setAlert(null);
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

  /** 这些待决项算不算"我这边的"：父会话自己的，或者它派出去的子会话的 */
  const mineSid = useCallback(
    (sid: string) => sid === active || kidIds.current.has(sid),
    [active],
  );

  /** 当前活跃会话对应的待决项，与后台会话解耦 */
  const activePerms = useMemo(
    () => perms.filter((p) => mineSid(p.sessionID)),
    [perms, mineSid],
  );
  const activeAsks = useMemo(
    () => asks.filter((x) => mineSid(x.sessionID)),
    [asks, mineSid],
  );

  /** 侧栏展示各会话待决授权/反问的数量，后台会话也能被及时发现 */
  const pendingCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of perms) {
      if (p.sessionID) counts[p.sessionID] = (counts[p.sessionID] ?? 0) + 1;
    }
    for (const a of asks) {
      if (a.sessionID) counts[a.sessionID] = (counts[a.sessionID] ?? 0) + 1;
    }
    return counts;
  }, [perms, asks]);

  /** 待决授权与问题全量拉取，保证后台会话的授权请求不丢失 */
  const reloadPending = useCallback(() => {
    const ws = projects.length ? projects : [dir];
    Promise.all(ws.map((w) => permissions.list(w).catch(() => []))).then((allP) => {
      setPerms(allP.flat());
    });
    Promise.all(ws.map((w) => questions.list(w).catch(() => []))).then((allQ) => {
      setAsks(allQ.flat());
    });
  }, [projects, dir]);

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
    const epoch = messageEpoch.current;
    const d = wsOfRef.current ?? dirRef.current;
    // 运行态也按目录分实例，后台会话在别的区，逐个区取回来才能拼出完整的忙集合
    const ws = projects.length ? projects : [dirRef.current];
    Promise.all(ws.map((p) => sessions.status(p).catch(() => ({}))))
      .then((maps) => {
        const next = new Set<string>();
        let retryInfo: { sid: string; attempt: number; message: string } | null = null;
        for (const map of maps) {
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
        }
        setBusySet(next);
        // 断线期间的收尾不补通知，但重连时仍在跑的会话要算进来
        runSeen.current = new Set(next);
        setRetry(retryInfo);
      })
      .catch(() => {});
    if (!sid) return;
    void readMessages(sid, d).catch(() => {});
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
        if (activeRef.current !== sid || messageEpoch.current !== epoch) return;
        setKids(ks);
        for (const k of ks) {
          kidIds.current.add(k.id);
          const kid = k.id;
          void readMessages(kid, k.directory ?? d).catch(() => {});
        }
      })
      .catch(() => {});
  }, [reloadList, reloadPending, wsKey]);

  const resyncRef = useRef(resync);
  resyncRef.current = resync;

  /** Rust 侧 SSE 桥的链路状态；从 down 恢复到 open 才补数据（首连不补） */
  useEffect(() => {
    const stop = listen<{ state?: string; message?: string }>("kernel-bridge", ({ payload }) => {
      if (payload?.state === "down") {
        bridgeDown.current = true;
        setBridge("down");
        setBridgeMsg(payload.message ?? null);
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

  /**
   * 内核的 plan agent 只把计划当聊天文本输出、从不写文件（实测 26.9.26：规划一整轮
   * 只有 read/bash/grep/question，`.opencode/plans` 连目录都没建），所以资源管理器
   * 「计划」页签永远空。规划轮收尾时由壳子代它落盘一份，谁更完整由 files.rs 判定。
   */
  const persistPlan = useCallback(async (sid: string, ms: Message[]) => {
    let final: Message | undefined;
    for (let i = ms.length - 1; i >= 0 && final === undefined; i--) {
      const m = ms[i];
      // 只认本轮（最后一条用户消息之后）的规划回复，之前几轮的旧计划不重复存
      if (m.info.role === "user") break;
      if (m.info.role === "assistant" && m.info.agent === "plan") final = m;
    }
    if (!final) return;
    const text = final.parts
      .filter((p) => p.type === "text" && !isSyntheticPart(p))
      .map((p) => p.text ?? "")
      .join("\n\n")
      .trim();
    // 短确认语（「好的，就按计划来」）不值得单立一份文件
    if (text.length < MIN_PLAN_CHARS) return;
    const d = dirOfRef.current(sid);
    try {
      const s = await sessions.get(sid, d);
      const path: string = await invoke("plan_save", {
        directory: s.directory ?? d,
        title: s.title,
        created: s.time.created,
        content: text,
      });
      // 计划页签靠 file.edited 的脉冲刷新，内核这次没发，自己来一下
      setEditPulse((n) => n + 1);
      setToast(`计划已保存到 ${path.split(/[\\/]+/).pop()}`);
    } catch (e) {
      setToast(`计划保存失败：${String(e)}`);
    }
  }, []);
  const persistPlanRef = useRef(persistPlan);
  persistPlanRef.current = persistPlan;

  useEffect(() => {
    const queue: { sid: string; event: KernelEvent; epoch: number }[] = [];
    let timer = 0;
    const flush = () => {
      window.clearTimeout(timer);
      timer = 0;
      const bySid = new Map<string, KernelEvent[]>();
      for (const item of queue.splice(0)) {
        if (item.epoch !== messageEpoch.current) continue;
        const events = bySid.get(item.sid) ?? [];
        events.push(item.event);
        bySid.set(item.sid, events);
      }
      for (const [sid, events] of bySid) {
        updateMessages(sid, applyMessageEvents(messageStore.current.get(sid) ?? [], events));
      }
    };
    flushMessages.current = flush;
    const stop = listen<KernelEvent>("kernel-event", ({ payload: ev }) => {
      const p = ev.properties ?? {};
      const sid = String(p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID ?? "");
      const cur = activeRef.current;
      const mine = sid === cur || kidIds.current.has(sid);
      // 全量与增量必须共用有序队列，不能让延迟的 delta 跑到最终快照后面。
      if (mine && MESSAGE_EVENTS.has(ev.type)) {
        const pending = messagePending.current.get(sid);
        if (pending) recordSnapshotEvent(pending, ev);
        delayMessageRepair(sid);
        queue.push({ sid, event: ev, epoch: messageEpoch.current });
        if (!timer) timer = window.setTimeout(flush, 50);
      }
      switch (ev.type) {
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
          break;
        }
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
          for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].sid === gone) queue.splice(i, 1);
          }
          messageRequests.current.delete(gone);
          messagePending.current.delete(gone);
          messageSettled.current.delete(gone);
          window.clearTimeout(messageRepairs.current.get(gone)?.timer);
          messageRepairs.current.delete(gone);
          messageStore.current.delete(gone);
          kidIds.current.delete(gone);
          runSeen.current.delete(gone);
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
          if (st === "idle") {
            flush();
            if (sid) processNextInQueueRef.current(sid);
          }
          if (sid) {
            const wasRunning = runSeen.current.delete(sid);
            if (st && st !== "idle") runSeen.current.add(sid);
            setBusySet((s) => {
              const has = s.has(sid);
              if (st === "idle" ? !has : has) return s;
              const next = new Set(s);
              if (st === "idle") next.delete(sid);
              else next.add(sid);
              return next;
            });
            // 有内核只发 status 不发 session.idle；两路都收尾，标记保证只弹一次
            if (st === "idle" && wasRunning) void notifyRef.current(sid);
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
          flush();
          setBusySet((s) => {
            if (!s.has(sid)) return s;
            const next = new Set(s);
            next.delete(sid);
            return next;
          });
          setRetry((r) => (r?.sid === sid ? null : r));
          if (sid) processNextInQueueRef.current(sid);
          // 轮次收尾时内核才把 summary.diffs 写进用户消息，重拉一次才有每轮改动
          if (sid === cur) {
            const want = sid;
            void readMessages(want, wsOfRef.current ?? dirRef.current, (ms) => {
              void persistPlanRef.current(want, ms);
            }).catch(() => {});
            reloadDiffsRef.current();
          }
          // 当前会话也要提醒：窗口在后台时人根本看不到它跑完了。
          // 弹不弹由「仅当窗口不在前台时提醒」和子任务开关在 notifyDone 里决定。
          if (sid && runSeen.current.delete(sid)) void notifyRef.current(sid);
          break;
        case "session.error":
          flush();
          if (sid === cur) {
            setErr(p.error?.data?.message ?? p.error?.name ?? "内核返回错误");
          }
          // 出错不弹「会话已完成」，清掉标记免得下一次 idle 误报
          if (sid) runSeen.current.delete(sid);
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
          if (sid === cur) {
            const sel = modelRef.current;
            const m = modelsRef.current.find(
              (x) => x.providerID === sel?.providerID && x.modelID === sel?.modelID,
            );
            const ctx = m?.context;
            setToast(
              ctx
                ? `上下文已压缩（当前模型按 ${Math.round(ctx / 1024)}K 窗口配置；如果模型实际更大，去 设置 → 模型 把上下文改大）`
                : "上下文已压缩，内核会带着摘要继续",
            );
          }
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
        // 授权请求：全局接住记账，侧栏点亮待审批角标，切会话也不会卡死
        case "permission.asked":
          if (p.id)
            setPerms((q) => (q.some((x) => x.id === p.id) ? q : [...q, p as PermissionRequest]));
          break;
        case "permission.replied":
        case "permission.updated": {
          const id = p.requestID ?? p.id ?? p.permissionID;
          if (id) setPerms((q) => q.filter((x) => x.id !== id));
          break;
        }
        // 反问：properties 就是 QuestionRequest 原样，全局接住
        case "question.asked":
          if (p.id)
            setAsks((q) => (q.some((x) => x.id === p.id) ? q : [...q, p as QuestionRequest]));
          break;
        case "question.replied":
        case "question.rejected": {
          const id = p.requestID ?? p.id;
          if (id) setAsks((q) => q.filter((x) => x.id !== id));
          break;
        }
      }
    });
    return () => {
      window.clearTimeout(timer);
      queue.length = 0;
      flushMessages.current = () => {};
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
    if (el) {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      // 触控板轻扫会先产生几像素的位移；离开底部一段距离才暂停跟随，避免提示频繁闪现。
      if (gap <= 2) setFollow(true);
      else if (scrollDirection.current === "up" && gap > 80) setFollow(false);
    }
    scrollDirection.current = null;
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
    setFollow(false);
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

  useLayoutEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, kidMsgs, busy]);

  useEffect(() => {
    const el = thread.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(followFrame.current);
      followFrame.current = requestAnimationFrame(() => {
        if (stick.current) el.scrollTop = el.scrollHeight;
        syncBar();
      });
    });
    observer.observe(inner);
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(followFrame.current);
    };
  }, []);

  useLayoutEffect(() => {
    followLatest();
    setRailHit(null);
  }, [active, followLatest]);

  const jumpTo = useCallback((id: string) => {
    setFollow(false);
    setRailHit(id);
    document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: "instant", block: "start" });
  }, [setFollow]);

  function cancelTitleFallback(sid: string) {
    const ids = titleTimers.current.get(sid);
    if (!ids) return;
    for (const t of ids) window.clearTimeout(t);
    titleTimers.current.delete(sid);
  }

  function scheduleTitleFallback(sid: string, title: string, where: string) {
    cancelTitleFallback(sid);
    const ids: number[] = [];
    for (const wait of [2500, 7000, 15000]) {
      ids.push(
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
        }, wait),
      );
    }
    titleTimers.current.set(sid, ids);
  }

  // 卸载时把没跑完的兜底计时器清掉，别在已拆掉的界面上 setState
  useEffect(() => {
    const timers = titleTimers;
    return () => {
      for (const ids of timers.current.values()) {
        for (const t of ids) window.clearTimeout(t);
      }
      timers.current.clear();
    };
  }, []);

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

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length) {
      void addImages(files);
    }
  }

  /**
   * 判定可重发的瞬时错误：
   * 1. 传输层/连接异常（网络闪断、超时、连接重置）；
   * 2. 内核后置任务锁/状态未就绪（SyncEvent 记忆更新缺 sessionID、目录未就绪、409 忙碌冲突、锁竞争等）；
   * 遇到这类瞬时错误自动重发，避免用户第二次请求时因后台后置任务未收尾而报红错。
   */
  function isPromptTransportError(e: unknown): boolean {
    const text = String((e as { message?: unknown })?.message ?? e ?? "");
    return /Session not found|会话不存在|SyncEvent\.run|"sessionID" required|error sending request|connection (refused|reset|closed)|timed out|ECONN|busy|conflict|locked|in progress|still processing|HTTP 409|HTTP 500|HTTP 502|HTTP 503|HTTP 504/i.test(
      text,
    );
  }

  /** 内核入口级的瞬时失败最多补发三次；间隔递增，给目录实例/记忆注入/后置起名充分时间 */
  async function promptWithRetry(
    id: string,
    parts: unknown[],
    target: string | null,
    model: ModelRef | null,
    agent: string | null,
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await sessions.prompt(id, parts, target, model, agent);
      } catch (e) {
        if (attempt >= 2 || !isPromptTransportError(e)) throw e;
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
  }

  /** 异步消费排队消息 */
  const sendQueued = useCallback(
    async (item: QueuedPrompt) => {
      const { id, raw, imgs, model: itemModel, agent: itemAgent, target } = item;
      try {
        const ocrTexts = imgs.length
          ? await Promise.all(
              imgs.map((a) => ocrJobs.current.get(a.id) ?? Promise.resolve(a.ocr?.text ?? "")),
            )
          : [];
        const ocrBlock = ocrTexts
          .map((t, i) => (t ? (imgs.length > 1 ? `--- 截图 ${i + 1} ---\n${t}` : t) : ""))
          .filter(Boolean)
          .join("\n\n");
        const text = expandSlash(raw, cmds).trim();
        const parts: unknown[] = [];
        if (text) {
          parts.push({ type: "text", text });
        } else if (!ocrBlock) {
          parts.push({ type: "text", text: "" });
        }
        if (ocrBlock) {
          parts.push({
            type: "text",
            text: `【附图内容】\n${ocrBlock}`,
            synthetic: true,
            metadata: { synthetic: true },
          });
        }
        cancelTitleFallback(id);
        setBusySet((s) => new Set(s).add(id));
        runSeen.current.add(id);
        await promptWithRetry(id, parts, target, itemModel, itemAgent);
        if (activeRef.current === id) setFollow(true);
      } catch (e) {
        runSeen.current.delete(id);
        setBusySet((s) => {
          if (!s.has(id)) return s;
          const next = new Set(s);
          next.delete(id);
          return next;
        });
        if (activeRef.current === id) setErr(`排队任务发送失败：${String(e)}`);
      }
    },
    [cmds, promptWithRetry, setFollow],
  );

  const processNextInQueue = useCallback(
    (sid: string) => {
      const queue = sessionQueuesRef.current[sid];
      if (!queue || !queue.length) return;
      const nextItem = queue[0];
      setSessionQueues((prev) => {
        const list = prev[sid] ?? [];
        const rest = list.slice(1);
        if (!rest.length) {
          const copy = { ...prev };
          delete copy[sid];
          return copy;
        }
        return { ...prev, [sid]: rest };
      });
      void sendQueued(nextItem);
    },
    [sendQueued],
  );
  processNextInQueueRef.current = processNextInQueue;

  /** 将当前输入放入排队队列，等上一轮收尾后自动发 */
  function enqueueCurrent() {
    const raw = input.trim();
    const imgs = attachments;
    if (!raw && !imgs.length) return;
    const sid = active;
    if (!sid) return;
    const item: QueuedPrompt = {
      id: sid,
      raw,
      imgs,
      model,
      agent,
      target: dirOf(sid),
    };
    setSessionQueues((prev) => ({
      ...prev,
      [sid]: [...(prev[sid] ?? []), item],
    }));
    setInput("");
    setAttachments([]);
    setToast("已加入排队：当前任务完成后将自动发送");
  }

  /** 取消排队队列中的某一项 */
  function cancelQueue(sid: string, index: number) {
    setSessionQueues((prev) => {
      const list = prev[sid] ?? [];
      const next = list.filter((_, i) => i !== index);
      if (!next.length) {
        const copy = { ...prev };
        delete copy[sid];
        return copy;
      }
      return { ...prev, [sid]: next };
    });
  }

  /** 打断并发送：会话正在出活时，先中止当前轮，再立即提交新输入 */
  async function interruptAndSend() {
    const id = active;
    if (!id || sending.current || readOnly || activePerms.length > 0 || activeAsks.length > 0) return;
    const raw = input.trim();
    const imgs = attachments;
    if (!raw && !imgs.length) {
      setErr("输入为空");
      return;
    }
    if (busySet.has(id)) {
      try {
        await sessions.abort(id, dirOf(id));
      } catch {}
      await new Promise((r) => setTimeout(r, 260));
    }
    await send();
  }

  async function send() {
    if (sending.current || readOnly || busy || activePerms.length > 0 || activeAsks.length > 0) return;
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
    // `!` 开头先于模型链路：只跑一条命令把输出带进上下文，别把它当 prompt 发出去
    if (!imgs.length && !readOnly && raw.startsWith("!")) {
      const cmd = raw.slice(1).trim();
      if (cmd) {
        try {
          await runShell(cmd);
        } finally {
          sending.current = false;
        }
        return;
      }
    }
    try {
      const ocrTexts = imgs.length
        ? await Promise.all(
            imgs.map((a) => ocrJobs.current.get(a.id) ?? Promise.resolve(a.ocr?.text ?? "")),
          )
        : [];
      const ocrBlock = ocrTexts
        .map((t, i) => (t ? (imgs.length > 1 ? `--- 截图 ${i + 1} ---\n${t}` : t) : ""))
        .filter(Boolean)
        .join("\n\n");
      if (imgs.length && !ocrBlock) {
        setErr("未能从截图中识别到有效文字，请直接把文字或代码复制进输入框。");
        return;
      }
      // 侧栏标题用原始输入：命令模板展开后是几百字，标题栏放不下
      const text = expandSlash(raw, cmds).trim();
      const parts: unknown[] = [];
      if (text) {
        parts.push({ type: "text", text });
      } else if (!ocrBlock) {
        parts.push({ type: "text", text: "" });
      }
      if (ocrBlock) {
        parts.push({
          type: "text",
          text: `【附图内容】\n${ocrBlock}`,
          synthetic: true,
          metadata: { synthetic: true },
        });
      }
      setInput("");
      setAttachments([]);
      setDismissed(null);
      let id = active;
      const title = imageTitle(raw, imgs.length);
      let target: string;
      if (!id) {
        const s = await sessions.create(title, dir);
        id = s.id;
        target = s.directory ?? dir;
        setActive(id);
        reloadList();
      } else {
        target = dirOf(id);
        // 主动取消前序标题定时器，避免与本轮并发写产生锁冲突
        cancelTitleFallback(id);
      }
      // 先标 busy：prompt 返回前 SSE 可能已 idle，事后再 add 会卡在 Stop
      setBusySet((s) => new Set(s).add(id));
      runSeen.current.add(id);
      try {
        // 新建会话后目录实例可能还没登记完，prompt 偶发 404/连接被打断；
        // 这类错误内核没接下这一轮，稍等补发就能过，不必让用户手动点重试
        await promptWithRetry(id, parts, target, model, agent);
        setFollow(true);
      } catch (e) {
        runSeen.current.delete(id);
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
        scheduleTitleFallback(id, title, target);
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
    if (!retryParts || !id || sending.current || busy || activePerms.length > 0 || activeAsks.length > 0) return;
    sending.current = true;
    setErr(null);
    setToast(null);
    cancelTitleFallback(id);
    // 先标 busy：prompt 返回前 SSE 可能已 idle，事后再 add 会卡在 Stop
    setBusySet((s) => new Set(s).add(id));
    runSeen.current.add(id);
    try {
      await promptWithRetry(id, retryParts, dirOf(id), model, agent);
      setFollow(true);
    } catch (e) {
      runSeen.current.delete(id);
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

  /** 侧栏的 × 与右键菜单都走这里，直接删；不再有「点两下才删」的二次确认 */
  async function removeSession(id: string) {
    try {
      cancelTitleFallback(id);
      await sessions.remove(id, dirOf(id));
      if (id === active) setActive(null);
      reloadList();
    } catch (e) {
      setErr(String(e));
    }
  }

  /** 生命周期接口都返回整条会话，就地并回侧栏列表，不必重拉全部工作区 */
  function mergeSession(s: Session) {
    if (!s?.id) return;
    setList((l) =>
      l.some((x) => x.id === s.id) ? l.map((x) => (x.id === s.id ? { ...x, ...s } : x)) : [s, ...l],
    );
  }

  /** 置顶集合存在本地：置顶是"我怎么看这个列表"的偏好，不该写进内核的会话数据 */
  function togglePin(id: string) {
    setPins((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [id, ...cur];
      try {
        localStorage.setItem(PIN_KEY, JSON.stringify(next));
      } catch {
        // 存不下只影响下次启动，本次排序照旧
      }
      return next;
    });
  }

  /**
   * 导出 Markdown：内容是壳侧按消息拼的（内核没有导出接口），
   * 路径交给系统保存对话框，写盘由 Rust 侧负责（绝对路径 + 8MB 上限）。
   */
  async function exportSession(id: string) {
    try {
      const where = dirOf(id);
      const s = list.find((x) => x.id === id) ?? (await sessions.get(id, where));
      const ms = await sessions.messages(id, s.directory ?? where);
      const path = await saveDialog({
        defaultPath: exportName(s.title, s.time?.created),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      const out = await exportMarkdown(path, sessionMarkdown(s, ms));
      setToast(`已导出到 ${out}`);
    } catch (e) {
      setErr(String(e));
    }
  }

  /** 分叉 = 复制整段历史另开一条，之后的改动不回头影响原会话 */
  async function forkSession(id: string) {
    try {
      const from = dirOf(id);
      const s = await sessions.fork(id, from);
      // 分叉出来的会话必然还在原实例里，内核没带 directory 就按原区补齐。
      // 只并一次：先补再并原始响应会把 directory 又按 null 覆盖回去
      mergeSession({ ...s, directory: s.directory ?? from });
      // 分叉完直接切到新那条：切会话会清空 toast，所以这里不弹提示，跳转本身就是回执
      setActive(s.id);
    } catch (e) {
      setErr(String(e));
    }
  }

  /**
   * 撤销 = 原生 TUI 的 /undo：这条用户消息起的历史摘掉，工作区文件按快照一起回滚。
   * 内核会逐条发 message.removed，时间线自己瘦下去；被打的那句填回输入框，改完能直接重发。
   */
  async function revertTo(messageID: string) {
    const id = active;
    if (!id || readOnly || busy) return;
    const src = msgs.find((m) => m.info.id === messageID);
    try {
      mergeSession(await sessions.revert(id, messageID, dirOf(id)));
      const text = src?.parts
        .filter((p) => p.type === "text" && !isSyntheticPart(p))
        .map((p) => p.text ?? "")
        .join("\n\n")
        .trim();
      const noImage = (src?.parts ?? []).some((p) => p.type === "file");
      // 框里已经另打了字就别覆盖掉，撤销只负责把历史退回去
      const filled = !!text && !input.trim();
      if (filled) setInput(text);
      setToast(
        filled
          ? `已撤销这一轮，原话填回输入框${noImage ? "（截图没带回来，要原样重发用重试）" : ""}`
          : "已撤销这一轮",
      );
    } catch (e) {
      setErr(String(e));
    }
  }

  /** 恢复撤销 = /redo：把刚摘掉的那段历史和文件快照整个放回来 */
  async function redoUndo() {
    const id = active;
    if (!id || busy) return;
    try {
      mergeSession(await sessions.unrevert(id, dirOf(id)));
      // 恢复是批量写回，内核不一定逐条补发帧，直接重拉一次最稳
      resync();
      setToast("已恢复撤销的内容");
    } catch (e) {
      setErr(String(e));
    }
  }

  /** 只摘掉这一条消息，不回滚文件——连文件一起退回去请用撤销 */
  async function removeMessage(messageID: string) {
    const id = active;
    if (!id || readOnly || busy) return;
    try {
      await sessions.deleteMessage(id, messageID, dirOf(id));
      resync();
    } catch (e) {
      setErr(String(e));
    }
  }

  /** 生成/更新项目的 AGENTS.md，等价于原生的 /init；内核要一条消息当锚点 */
  async function initAgentsMd() {
    const id = active;
    const anchor = msgs[msgs.length - 1]?.info.id;
    if (!id || !model || !anchor) {
      setErr("生成 AGENTS.md 需要选好模型，并且这条会话里至少已经有一条消息");
      return;
    }
    setErr(null);
    try {
      await sessions.init(id, model, anchor, dirOf(id));
      setFollow(true);
      resync();
    } catch (e) {
      setErr(String(e));
    }
  }

  /**
   * `!` 前缀 = 在项目里跑一条命令，输出直接进上下文、不派模型（原生 TUI 的同名行为）。
   * busy 交给内核的帧驱动，这里不自己标，免得它没发 idle 时永久卡在停止按钮。
   */
  async function runShell(command: string) {
    setInput("");
    setErr(null);
    try {
      let id = active;
      if (!id) {
        const s = await sessions.create(command.slice(0, 40), dir);
        id = s.id;
        setActive(id);
        reloadList();
      }
      await sessions.shell(id, agent ?? "build", command, dirOf(id));
      setFollow(true);
      resync();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function answer(p: PermissionRequest, reply: "once" | "always" | "reject") {
    setErr(null);
    try {
      // 队列按目录分实例：拿错区的 reply 内核回 200 却什么都不做，那张卡会永远挂着
      await permissions.reply(p.id, reply, dirOf(p.sessionID));
      setPerms((q) => q.filter((x) => x.id !== p.id));
    } catch (e) {
      setErr(String(e));
    }
  }

  /** answers 按 questions 同序，每项是选中的 label 数组（自己写的那句也并进同一项） */
  async function answerQuestion(q: QuestionRequest, answers: string[][]) {
    setErr(null);
    try {
      await questions.reply(q.id, answers, dirOf(q.sessionID));
      setAsks((a) => a.filter((x) => x.id !== q.id));
    } catch (e) {
      setErr(String(e));
    }
  }

  async function rejectQuestion(q: QuestionRequest) {
    setErr(null);
    try {
      await questions.reject(q.id, dirOf(q.sessionID));
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
  /** 手动禁止的条目在切策略时必须原样留着，否则用户收紧过的规则会被静默放开 */
  const denyRules = rules?.filter((r) => r.action === "deny") ?? [];

  async function applyPolicy(id: string) {
    const p = POLICIES.find((x) => x.id === id);
    if (!p || !rules) return;
    setErr(null);
    try {
      // bash 只认 /permission/bash/mode，global 规则集里没有它，两次写缺一不可
      await permissionConfig.setBashMode(p.mode, dir);
      const allow = allowedSet(p, rules);
      const next: PermRule[] = rules.map((r) =>
        r.action === "deny" ? r : { ...r, action: allow.has(r.permission) ? "allow" : "ask" },
      );
      await permissionConfig.setRules(next, dir);
      setRules(next);
      setBashMode(p.mode);
      setToast(
        denyRules.length
          ? `授权策略已切到「${p.label}」，保留 ${denyRules.length} 项手动禁止`
          : `授权策略已切到「${p.label}」`,
      );
    } catch (e) {
      setErr(String(e));
    }
  }

  /**
   * 某个工作区要显示哪些会话：先按过滤词筛，再把置顶的按置顶顺序提到前面，
   * 其余保持 `list` 里的时间倒序（sort 是稳定的）。
   */
  /** 会话级汇总只在消息数组变化时重算：悬停、待办刷新等无关渲染不必再扫一遍 */
  const { turns, spend, toolCalls } = useMemo(() => {
    const turns = msgs.filter((m) => m.info.role === "user" && m.info.time.created > 0);
    /** 本会话累计用量：token / 缓存 / 耗时都按助手消息累加，挂在会话末尾 */
    const spend = msgs.reduce(
      (acc, m) => {
        const i = m.info;
        if (i.role !== "assistant") return acc;
        if (typeof i.cost === "number") acc.cost += i.cost;
        const t = (i.tokens ?? {}) as Record<string, unknown>;
        const n = (x: unknown) => (typeof x === "number" ? x : 0);
        acc.in += n(t.input);
        acc.out += n(t.output);
        acc.reasoning += n(t.reasoning);
        const c = (t.cache ?? {}) as Record<string, unknown>;
        acc.cache += n(c.read) + n(c.write);
        if (i.time?.completed) acc.ms += Math.max(0, i.time.completed - i.time.created);
        return acc;
      },
      { cost: 0, in: 0, out: 0, reasoning: 0, cache: 0, ms: 0 },
    );
    const toolCalls = msgs.reduce((n, m) => n + m.parts.filter((p) => p.type === "tool").length, 0);
    return { turns, spend, toolCalls };
  }, [msgs]);

  /** 时间线按轮渲染：一条用户消息 + 这一轮的全部助手步骤合成一段助手回复 */
  const turnRows = useMemo(() => {
    const rows: TurnRowData[] = [];
    for (const m of msgs) {
      if (m.info.time.created === 0) continue;
      if (m.info.role === "user") {
        rows.push({ key: m.info.id, owner: m.info.id, user: m, assistants: [] });
        continue;
      }
      // 压缩摘要（summary=true）是内核喂给下一轮的内部上下文，不是用户想看的回复；
      // 里头还会带上注入的整份记忆索引，摊在时间线上又长又像"记忆被全量吐出来"。
      if ((m.info as { summary?: boolean }).summary) continue;
      const last = rows[rows.length - 1];
      if (last) last.assistants.push(m);
      else rows.push({ key: m.info.id, owner: "", assistants: [m] });
    }
    return rows;
  }, [msgs]);

  /** 每轮小结的底账：切轮、数步、给每步拉一行摘要，详见 turnsOf */
  const turnsCache = useRef<{
    busy: boolean;
    runKey: string;
    stat: Record<string, TurnStat>;
    groups: TurnGroups;
  } | null>(null);
  const { stat: turnStat } = useMemo(() => {
    const r = turnsOf(msgs, busy, turnsCache.current);
    turnsCache.current = { busy, runKey: r.runKey, stat: r.stat, groups: r.groups };
    return r;
  }, [msgs, busy]);
  /** 全完成的旧清单不该在新一轮里继续悬浮，等内核写新清单再出现 */
  const openTodos = todos.some((t) => t.status !== "completed" && t.status !== "cancelled");

  /** 父会话里那条 task 工具记录只给一个子会话 id，过程全在子会话的帧上 */
  const kidOf = useCallback(
    (p: Part) => (p.type === "tool" && p.tool === "task" ? kidMsgs[kidSid(p)] : undefined),
    [kidMsgs],
  );

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
    if (activePerms.length > 0 || activeAsks.length > 0) return;
    if (busy) {
      // 正在跑时按回车：如果输入框有内容，触发打断并插话
      if (input.trim() || attachments.length > 0) {
        void interruptAndSend();
      }
      return;
    }
    void send();
  }

  /**
   * 关掉当前这条会话的视图。忙集合不动：内核按目录分实例，别的区还在跑，
   * 那些状态是侧栏上后台会话的灯，不属于这里。
   */
  function clearView() {
    setActive(null);
    setMsgs([]);
    setRetry(null);
  }

  /**
   * 会话列表、消息、待办、diff 都按 session.directory 直接读，跨区点开不需要切区；
   * 发送也带会话自己的目录，所以预览和继续对话是同一件事。
   */
  function openSession(id: string) {
    setActive(id);
  }

  function switchTo(p: string, then: string | null = null) {
    setActive(then);
    if (!sameDir(p, projectDir)) onSwitchDir(p);
  }

  function dropWs(p: string) {
    if (sameDir(p, projectDir)) clearView();
    onDropDir(p);
  }

  const toggleFiles = useCallback(() => {
    setFilesOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem(FILES_KEY, next ? "1" : "0");
      } catch {
        // 隐私模式/配额满了也不影响本次显示
      }
      return next;
    });
  }, []);

  /** 文件大窗只读它那个区的文件（root 已跟着会话走）；越界的仍然拦掉。计划文件由 files.rs 单独限定根目录 */
  const openWorkspaceFile = useCallback(
    (f: OpenFile) => {
      if (!f.plan && relInRoot(wsDir, f.abs) === null) {
        setToast("这个文件不在当前会话的工作区里，无法在应用内预览");
        return;
      }
      setFileView(f);
    },
    [wsDir],
  );

  const openDiffFile = useCallback(
    (d: FileDiff) => {
      const rel = relInRoot(wsDir, d.file);
      if (rel === null) {
        setToast("这条改动不在当前会话的工作区里，无法在应用内预览");
        return;
      }
      setFileView({ rel, abs: d.file, tab: "diff" });
    },
    [wsDir],
  );

  const closeFileView = useCallback(() => setFileView(null), []);
  const onFileRestored = useCallback(() => {
    reloadDiffs();
    setEditPulse((n) => n + 1);
  }, [reloadDiffs]);
  const closeQuickOpen = useCallback(() => setQuickOpen(false), []);
  const pickQuickFile = useCallback(
    (rel: string) => {
      setQuickOpen(false);
      setFileView({ rel, abs: `${wsDir.replace(/\/+$/, "")}/${rel}`, tab: "preview" });
    },
    [wsDir],
  );

  const [menu, setMenu] = useState<Menu | null>(null);

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
    const s = list.find((x) => x.id === id);
    // 撤销/AGENTS 都要读当前时间线，只有打开着的这条能给出
    const onActive = id === active && !readOnly;
    const lastUser = [...msgs].reverse().find((m) => m.info.role === "user")?.info.id;
    const canWrite = onActive && !busy;
    return [
      { label: pins.includes(id) ? "取消置顶" : "置顶会话", run: () => togglePin(id) },
      ...(cur ? [] : [{ label: "切到该工作区", run: () => switchTo(p) }]),
      ...(onActive && s?.revert
        ? [{ label: "恢复撤销的内容", run: () => void redoUndo() }]
        : canWrite && lastUser
          ? [{ label: "撤销最后一轮", run: () => void revertTo(lastUser) }]
          : []),
      ...(canWrite ? [{ label: "生成 / 更新 AGENTS.md", run: () => void initAgentsMd() }] : []),
      { label: "导出为 Markdown…", run: () => void exportSession(id) },
      { label: "分叉为新会话", run: () => void forkSession(id) },
      { label: "删除会话", danger: true, run: () => void removeSession(id) },
    ];
  }

  /** 右键时间线上的消息：支持选中文字复制、整条消息复制，以及撤销与删除 */
  function msgMenu(m: Message): MenuItem[] {
    const items: MenuItem[] = [];
    const selected = window.getSelection()?.toString() ?? "";
    if (selected.trim()) {
      items.push({
        label: "复制",
        run: () => void copy(selected),
      });
    }

    const fullText = m.parts
      .filter((p) => p.type === "text" && !isSyntheticPart(p))
      .map((p) => p.text ?? "")
      .join("\n\n")
      .trim();
    if (fullText && (!selected.trim() || fullText !== selected.trim())) {
      items.push({
        label: "复制整条消息",
        run: () => void copy(fullText),
      });
    }

    // 撤销与删除属于写操作：跑着、只读或内核未连接时不给操作
    const canMutate = active && !readOnly && !busy && live;
    if (canMutate) {
      if (m.info.role === "user" && !activeSess?.revert) {
        items.push({
          label: "从这里撤销（含文件回滚）",
          run: () => void revertTo(m.info.id),
        });
      }
      items.push({
        label: "只删除这条消息",
        danger: true,
        run: () => void removeMessage(m.info.id),
      });
    }

    return items;
  }

  // 菜单项依赖一堆当前状态，但时间线行是 memo 的：走 ref 取最新实现，回调本身保持稳定
  const openMenuRef = useRef(openMenu);
  openMenuRef.current = openMenu;
  const msgMenuRef = useRef(msgMenu);
  msgMenuRef.current = msgMenu;
  const onMsgMenu = useCallback((e: ReactMouseEvent, m: Message) => {
    openMenuRef.current(e, msgMenuRef.current(m));
  }, []);

  const onThreadMenu = useCallback((e: ReactMouseEvent) => {
    if (e.defaultPrevented) return;
    const selected = window.getSelection()?.toString() ?? "";
    if (selected.trim()) {
      openMenuRef.current(e, [{ label: "复制", run: () => void copy(selected) }]);
    }
  }, [copy]);

  return (
    <div className="shell2">
      <Sidebar
        projects={projects}
        projectDir={projectDir}
        list={list}
        active={active}
        query={query}
        pins={pins}
        sessShown={sessShown}
        busySet={busySet}
        pendingCounts={pendingCounts}
        sessionQueues={sessionQueues}
        ver={ver ?? ""}
        live={live}
        onQueryChange={setQuery}
        onAddDir={onAddDir}
        onSwitchDir={switchTo}
        onDropDir={dropWs}
        onOpenSession={openSession}
        onCreateSession={createSession}
        onRemoveSession={(id) => void removeSession(id)}
        onSetSessShown={setSessShown}
        onOpenSettings={onOpenSettings}
        onOpenStats={() => setStatsOpen(true)}
        onOpenWsMenu={(e, p, cur) => openMenu(e, wsMenu(p, cur))}
        onOpenSessMenu={(e, p, id, cur) => openMenu(e, sessMenu(p, id, cur))}
      />

      <div className="main">
        <ChatHeader
          live={live}
          status={status}
          activeSess={activeSess ?? undefined}
          gitState={gitState}
          branch={branch}
          wsDir={wsDir}
          busySet={busySet}
          kernelBusy={kernelBusy}
          filesOpen={filesOpen}
          sessionDiffs={sessionDiffs}
          bridge={bridge}
          bridgeMsg={bridgeMsg}
          busy={busy}
          onBranchSwitched={onBranchSwitched}
          onStart={onStart}
          onStop={onStop}
          onQuickOpen={() => setQuickOpen(true)}
          onToggleFiles={toggleFiles}
          onRedoUndo={() => void redoUndo()}
        />

        <div className={`body ${turns.length > 1 ? "hasrail" : ""}`} ref={body}>
          <section className="thread" ref={thread} onScroll={onScroll} tabIndex={0} aria-label="会话消息"
            onContextMenu={onThreadMenu}
            onWheel={(e) => {
              scrollDirection.current = e.deltaY < 0 ? "up" : "down";
            }}
            onKeyDown={(e) => {
              if (e.target instanceof HTMLElement && e.target.closest("input, textarea, button, summary, a")) return;
              if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) {
                scrollDirection.current = "up";
              } else if (["ArrowDown", "PageDown", "End", " "].includes(e.key)) {
                scrollDirection.current = "down";
              }
            }}>
            <div className="thread-content" ref={content}>
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
            {turnRows.map((row, ri) => {
              const last = ri === turnRows.length - 1;
              const turnRunning = last && busy;
              const tk = row.owner;
              const st = tk ? turnStat[tk] : undefined;
              // 最新一轮优先用事件快照（比分片里的 todowrite 新），历史轮用 part 还原
              const turnTodo = tk
                ? turnTodos[tk]?.length
                  ? turnTodos[tk]
                  : last && todos.length
                    ? todos
                    : st?.todos
                : undefined;
              const tail = row.assistants[row.assistants.length - 1];
              return (
                <ConversationWindow key={`${active}:${row.key}`} id={row.key} eager={last} estimate={estimateTurnHeight(row)} root={thread} following={stick}>
                <TurnRow
                  user={row.user}
                  assistants={row.assistants}
                  running={turnRunning}
                  pulse={turnRunning ? editPulse : 0}
                  stat={st}
                  todo={turnTodo}
                  retry={last && tail?.info.error ? retryBtn : undefined}
                  onCopy={copy}
                  onMenu={onMsgMenu}
                  onOpenFile={openDiffFile}
                  kidOf={kidOf}
                />
                </ConversationWindow>
              );
            })}
            {busy && (
              <BusyHint
                // 秒表挂在组件内部：不带 key 时从忙的 A 切到忙的 B 会沿用 A 的起点
                key={active ?? "none"}
                waitingPerm={activePerms.length > 0}
                waitingAsk={activeAsks.length > 0}
                retry={retry && retry.sid === active ? retry : null}
                activity={activityOf(msgs, (sid) => kidMsgs[sid])}
              />
            )}
            {!msgs.length && !busy && active && <p className="muted">等待内核回复…</p>}
            {!!active && (spend.in > 0 || spend.out > 0 || spend.cost > 0) && (
              <div className="sessstat">
                <p>
                  本次会话 · {turns.length} 轮 · {msgs.length} 条消息
                  {toolCalls ? ` · ${toolCalls} 次工具调用` : ""}
                </p>
                <p>
                  输入 {fmtNum(spend.in)} · 输出 {fmtNum(spend.out)}
                  {spend.reasoning ? ` · 思考 ${fmtNum(spend.reasoning)}` : ""}
                  {spend.cache ? ` · 缓存 ${fmtNum(spend.cache)}` : ""}
                </p>
                <p>
                  合计 {fmtNum(spend.in + spend.out)} token
                  {spend.cost > 0 ? ` · 成本 ${fmtNum(spend.cost, 4)}` : ""}
                  {spend.ms > 1000 ? ` · 时长 ${fmtSpan(spend.ms / 1000)}` : ""}
                </p>
              </div>
            )}
            </div>
          </section>
          {!following && !!msgs.length && (
            <button className="jump-latest" onClick={followLatest} title="回到最新消息并继续跟随输出">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10m-4-4 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              回到最新
            </button>
          )}

          {busy && openTodos && <TodoFly todos={todos} pulse={editPulse} />}

          <TurnRail turns={turns} railHit={railHit} onJumpTo={jumpTo} />
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
          
        </div>

        <div
          className={`composer ${isDragging ? "dragging" : ""}`}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {isDragging && (
            <div className="drag-overlay" aria-hidden="true">
              <div className="drag-box">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <span>释放图片以添加到输入框</span>
              </div>
            </div>
          )}
          <PermBar
            activeAsks={activeAsks}
            activePerms={activePerms}
            alert={alert}
            toast={toast}
            readOnly={readOnly}
            kidFrom={kidFrom}
            onAnswerQuestion={(q, a) => void answerQuestion(q, a)}
            onRejectQuestion={(q) => void rejectQuestion(q)}
            onAnswerPerm={(p, c) => void answer(p, c)}
            onDismissAlert={() => setAlert(null)}
            onDismissToast={() => setToast(null)}
          />
          <ChatInput
            input={input}
            setInput={setInput}
            live={live}
            readOnly={readOnly}
            busy={busy}
            err={err}
            lastErr={Boolean(lastErr)}
            retryBtn={retryBtn}
            active={active}
            canSend={live && !readOnly && activePerms.length === 0 && activeAsks.length === 0}
            attachments={attachments}
            sessionQueues={sessionQueues}
            palette={palette}
            paletteIndex={hi}
            commandsCount={cmds.length}
            agent={agent}
            agentList={agentList}
            policy={policy}
            rules={rules}
            denyRulesCount={denyRules.length}
            model={model}
            models={models}
            modelOptions={modelOptions}
            onKey={onKey}
            onPasteImages={onPasteImages}
            onRemoveAttachment={(id) => setAttachments((list) => list.filter((x) => x.id !== id))}
            onCancelQueue={cancelQueue}
            onDismissErr={() => setErr(null)}
            onTogglePlan={() => chooseAgent(agent === "plan" ? prevAgent.current : "plan")}
            onChooseAgent={chooseAgent}
            onApplyPolicy={(v) => void applyPolicy(v)}
            onSelectModel={(v) => {
              const i = v.indexOf("/");
              if (i <= 0) return;
              const next = { providerID: v.slice(0, i), modelID: v.slice(i + 1) };
              setModel(next);
              localStorage.setItem(MODEL_KEY, v);
            }}
            onSend={() => void send()}
            onAbort={() => {
              if (active) void sessions.abort(active, dirOf(active)).catch((e) => setErr(String(e)));
            }}
            onEnqueueCurrent={enqueueCurrent}
            onInterruptAndSend={() => void interruptAndSend()}
            onAcceptPalette={accept}
            onSetPaletteIndex={setHi}
            onOpenMenu={openMenu}
            onAddImages={(files) => void addImages(files)}
          />
        </div>
      </div>

      {filesOpen && (
        <FilePanel
          root={wsDir}
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
          root={wsDir}
          file={fileView}
          startTab={fileView.tab}
          diffs={sessionDiffs}
          pulse={editPulse}
          onRestored={onFileRestored}
          onClose={closeFileView}
        />
      )}

      {quickOpen && (
        <QuickOpen root={wsDir} onClose={closeQuickOpen} onPick={pickQuickFile} />
      )}

      {statsOpen && (
        <StatsModal
          currentProject={projectDir}
          activeSessionId={active}
          kernelVersion={status?.version}
          onClose={() => setStatsOpen(false)}
          onSessionImported={reloadList}
        />
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

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
