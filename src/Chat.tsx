import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  agents,
  api,
  commands,
  normalizeProviders,
  permissionConfig,
  permissions,
  sessions,
  type AgentInfo,
  type BashMode,
  type CommandInfo,
  type KernelEvent,
  type Message,
  type MessageInfo,
  type ModelInfo,
  type ModelRef,
  type Part,
  type PermRule,
  type PermissionRequest,
  type Session,
  type ToolState,
} from "./kernelApi";
import { APP_TITLE, type KernelStatus } from "./App";

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

/** 上次用的模型：内核 /provider 的 default 每次重启都可能变，用户的选择要自己记住 */
const MODEL_KEY = "codearts.model";
const AGENT_KEY = "codearts.agent";

/** 内核用来起标题、做摘要、压缩上下文的内部 agent，选它们当主对话只会得到一句废话 */
const INTERNAL_AGENTS = new Set(["title", "summary", "compaction"]);

const AGENT_CN: Record<string, string> = {
  build: "执行",
  plan: "规划",
  "docgen-agent": "文档",
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

  const [list, setList] = useState<Session[]>([]);
  const [active, setActive] = useState<string | null>(null);
  /** 跨工作区点会话：先换目录重启内核，回到工作区后再打开这一条 */
  const pending = useRef<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [perms, setPerms] = useState<PermissionRequest[]>([]);
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
  const [tip, setTip] = useState<{ text: string; top: number } | null>(null);
  const [cmds, setCmds] = useState<CommandInfo[]>([]);
  const [agentList, setAgentList] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [hi, setHi] = useState(0);
  /** Esc 关掉的候选项所属的 /token，继续打字（token 变了）会重新弹。必须是 state，用 ref 的话按 Esc 不重渲染，面板会赖着不走 */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [kids, setKids] = useState<Session[]>([]);

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

  useEffect(reloadList, [reloadList, live]);

  useEffect(() => {
    if (!live) return;
    setModels([]);
    api<any>("GET", "/provider", undefined, dir)
      .then((root) => {
        const { models, default: def } = normalizeProviders(root);
        setModels(models);
        const saved = localStorage.getItem(MODEL_KEY);
        const remembered = models.find(
          (m) => `${m.providerID}/${m.modelID}` === saved,
        );
        setModel(
          (prev) =>
            prev ??
            (remembered
              ? { providerID: remembered.providerID, modelID: remembered.modelID }
              : (def ?? models[0] ?? null)),
        );
      })
      // 假凭据/排队时 /provider 会 500，静默失败只会留下一个空的模型下拉框
      .catch((e) => setErr(`模型列表获取失败：${e}`));
  }, [live, dir]);

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
  const isChild = !!activeSess?.parentID;
  const readOnly = !!active && (isChild || (!!wsOf && !sameDir(wsOf, dir)));

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
        setAgent(chosen.name);
      })
      .catch(() => setAgentList([]));
  }, [live, dir]);

  useEffect(() => {
    setKids([]);
    if (!active || !live) return;
    sessions
      .children(active, wsOf ?? dir)
      .then(setKids)
      .catch(() => setKids([]));
  }, [active, wsOf, dir, live]);

  useEffect(() => {
    if (!active || !live) {
      setMsgs([]);
      return;
    }
    setErr(null);
    setToast(null);
    sessions
      .messages(active, wsOf ?? dir)
      .then(setMsgs)
      .catch((e) => setErr(String(e)));
  }, [active, wsOf, dir, live]);

  // 换工作区后旧会话不属于新目录，必须回到空态
  useEffect(() => {
    setActive(null);
    setBusy(false);
  }, [dir]);

  /** 跨工作区点开：新目录的会话列表到手后再选中那一条 */
  useEffect(() => {
    const want = pending.current;
    if (!want) return;
    if (list.some((s) => s.id === want)) {
      pending.current = null;
      setActive(want);
    }
  }, [list]);

  const reloadPerms = useCallback(() => {
    permissions
      .list(dir)
      .then((q) => setPerms(q.filter((p) => p.sessionID === active)))
      .catch(() => setPerms([]));
  }, [dir, active]);

  useEffect(() => {
    if (!live) {
      setPerms([]);
      return;
    }
    reloadPerms();
  }, [live, reloadPerms]);

  useEffect(() => {
    const stop = listen<KernelEvent>("kernel-event", ({ payload: ev }) => {
      const p = ev.properties ?? {};
      switch (ev.type) {
        case "message.updated":
          if (p.sessionID === active && p.info) setMsgs((m) => upsertInfo(m, p.info));
          break;
        case "message.part.updated":
          if (p.sessionID === active && p.part) setMsgs((m) => upsertPart(m, p.part));
          break;
        case "message.part.removed":
          if (p.sessionID === active)
            setMsgs((m) =>
              m.map((x) => ({ ...x, parts: x.parts.filter((q) => q.id !== p.partID) })),
            );
          break;
        case "message.part.delta":
          if (p.sessionID === active) setMsgs((m) => appendDelta(m, p));
          break;
        case "session.status":
          if (p.sessionID === active) setBusy(p.status?.type !== "idle");
          break;
        case "session.idle":
          if (p.sessionID === active) setBusy(false);
          break;
        case "session.error":
          if (p.sessionID === active) {
            setBusy(false);
            setErr(p.error?.data?.message ?? p.error?.name ?? "内核返回错误");
          }
          break;
        // 排队、限流这类运营提示走 toast 广播，不接就只剩"处理中"
        case "tui.toast.show": {
          const msg = String(p.message ?? "");
          // 内核每次启动都广播这条进度，用户处理不了，只会压住输入框
          if (!/^Initializing MCP server/i.test(msg)) setToast(p.message ?? p.title ?? null);
          break;
        }
        // 授权请求：不接住就只能看着"内核处理中"卡死
        case "permission.asked":
          if (p.sessionID === active && p.id)
            setPerms((q) => (q.some((x) => x.id === p.id) ? q : [...q, p as PermissionRequest]));
          break;
        case "permission.replied":
        case "permission.updated": {
          const id = p.requestID ?? p.id ?? p.permissionID;
          if (p.sessionID === active && id) setPerms((q) => q.filter((x) => x.id !== id));
          break;
        }
      }
    });
    return () => {
      stop.then((f) => f());
    };
  }, [active]);

  const onScroll = () => {
    const el = thread.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useEffect(() => {
    const el = thread.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // 处理中的秒数自己数：排队阶段内核一个字节都不发，没有这个数字就只能靠猜
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [busy]);

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

  async function send() {
    if (sending.current || readOnly) return;
    const raw = input.trim();
    if (!raw) {
      setErr("输入为空");
      return;
    }
    // 侧栏标题用原始输入：命令模板展开后是几百字，标题栏放不下
    const text = expandSlash(raw, cmds);
    setErr(null);
    setToast(null);
    // 一次回车只发一条：IME 提交候选词和真正发送会连着派发两个 Enter keydown，
    // 两个处理函数拿到的是同一次渲染的 input 闭包，setInput 挡不住第二次
    sending.current = true;
    setInput("");
    setDismissed(null);
    try {
      let id = active;
      if (!id) {
        const s = await sessions.create(raw.slice(0, 40), dir);
        id = s.id;
        setActive(id);
        reloadList();
      }
      await sessions.prompt(id, [{ type: "text", text }], dir, model, agent);
      setBusy(true);
      stick.current = true;
    } catch (e) {
      setErr(String(e));
    } finally {
      sending.current = false;
    }
  }

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

  async function answer(p: PermissionRequest, reply: "once" | "always" | "reject") {
    setErr(null);
    try {
      await permissions.reply(p.id, reply, dir);
      setPerms((q) => q.filter((x) => x.id !== p.id));
    } catch (e) {
      setErr(String(e));
    }
  }

  async function copy(text: string) {
    setErr(null);
    try {
      await navigator.clipboard.writeText(text);
      setToast("已复制到剪贴板");
    } catch (e) {
      setErr(`复制失败：${e}`);
    }
  }

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

  const name = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
  const ofWs = (p: string) => list.filter((s) => sameDir(s.directory, p));
  const turns = msgs.filter((m) => m.info.role === "user");
  const lastRea = lastReasoning(msgs);
  const tot = totals(msgs);

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
    setBusy(false);
    setTip(null);
  }

  /**
   * opencode.db 全项目共用，读消息不需要切区，所以别的区的会话直接只读预览；
   * 只有要发新消息才需要 restart 到那个工作区。
   */
  function openSession(p: string, id: string) {
    if (sameDir(p, projectDir)) {
      setActive(id);
      return;
    }
    setPerms([]);
    setBusy(false);
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
      ? [{ label: "删除会话", danger: true, run: () => void removeSession(id) }]
      : [{ label: "切到该工作区并打开", run: () => switchTo(p, id) }];
  }

  return (
    <div className="shell2">
      <aside className="side">
        {/* 标题栏已沉浸（titleBarStyle Overlay），这条空带子就是拖窗口的把手，红绿灯压在它上面 */}
        <div className="drag" data-tauri-drag-region="deep">
          <span className="wtitle">{APP_TITLE}</span>
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
            {projects.map((p) => {
              const cur = sameDir(p, projectDir);
              const items = ofWs(p);
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
                      {name(p)}
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
                    {items.map((s) => (
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
                        {cur && (
                          <button
                            className="x"
                            onClick={() => removeSession(s.id)}
                            title="删除会话"
                            aria-label="删除会话"
                          >
                            ×
                          </button>
                        )}
                      </li>
                    ))}
                    {!items.length && <li className="muted pad">暂无会话</li>}
                  </ul>
                </li>
              );
            })}
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
          {live ? (
            <button onClick={() => void onStop()} disabled={kernelBusy}>
              停止内核
            </button>
          ) : (
            <button onClick={() => void onStart()} disabled={kernelBusy}>
              启动内核
            </button>
          )}
        </header>

        <div className="body" ref={body}>
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
            {msgs.map((m) => (
              <article key={m.info.id} id={`m-${m.info.id}`} className={`msg ${m.info.role}`}>
                <header>{label(m.info)}</header>
                {m.info.error && (
                  <p className="error inline">
                    {m.info.error.data?.message ?? m.info.error.name}
                  </p>
                )}
                {m.parts.map((p) => (
                  <Block key={p.id} part={p} onCopy={copy} autoOpen={p.id === lastRea} />
                ))}
                {m.info.role === "assistant" && usage(m.info) && (
                  <footer className="muted small">{usage(m.info)}</footer>
                )}
              </article>
            ))}
            {busy && (
              <p className="hint busy">
                <span className="pulse" />
                {perms.length
                  ? "等待你在下方授权…"
                  : `内核处理中 ${elapsed}s · ${activityOf(msgs)}`}
              </p>
            )}
            {!msgs.length && !busy && active && <p className="muted">等待内核回复…</p>}
          </section>

          {turns.length > 1 && (
            <nav className="rail" aria-label="轮次导航" onMouseLeave={() => setTip(null)}>
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
            </nav>
          )}
          {tip && (
            <div className="tip" style={{ top: tip.top }}>
              {tip.text}
            </div>
          )}
        </div>

        <div className="composer">
          {perms.map((p) => (
            <div className="ask" key={p.id}>
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
                    ? `只读预览 · 这条会话属于「${name(wsOf)}」`
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
          <textarea
            value={input}
            disabled={readOnly}
            placeholder={
              readOnly
                ? isChild
                  ? "子任务会话只读，回到父会话才能继续"
                  : "只读预览，切到该工作区后才能继续对话"
                : live
                  ? "描述要做的改动，/ 唤起命令，Enter 发送"
                  : "先启动内核"
            }
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="row">
            {busy ? (
              <button
                onClick={() => active && sessions.abort(active, dir).catch((e) => setErr(String(e)))}
              >
                停止
              </button>
            ) : (
              <button onClick={send} disabled={!live || readOnly}>
                发送
              </button>
            )}
            <span className="grow" />
            <select
              className="chip agent"
              value={agent ?? ""}
              disabled={!agentList.length}
              title={
                agentList.find((a) => a.name === agent)?.description ??
                "本轮由哪个 agent 执行；规划（plan）禁用改文件工具"
              }
              onChange={(e) => {
                setAgent(e.target.value);
                localStorage.setItem(AGENT_KEY, e.target.value);
              }}
            >
              {!agentList.length && <option value="">agent 加载中</option>}
              {agentList.map((a) => (
                <option key={a.name} value={a.name}>
                  {AGENT_CN[a.name] ?? a.name} · {a.name}
                </option>
              ))}
            </select>
            <select
              className="chip policy"
              value={policy}
              disabled={!rules}
              title={POLICIES.find((p) => p.id === policy)?.hint ?? "当前策略与三种预设都不一致"}
              onChange={(e) => void applyPolicy(e.target.value)}
            >
              {!rules && <option value="custom">授权策略加载中</option>}
              {POLICIES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              {policy === "custom" && !!rules && <option value="custom">自定义</option>}
            </select>
            <select
              className="chip model"
              value={model ? `${model.providerID}/${model.modelID}` : ""}
              disabled={!models.length}
              onChange={(e) => {
                const [providerID, modelID] = e.target.value.split("/");
                setModel({ providerID, modelID });
              }}
            >
              {!models.length && <option value="">无可用模型</option>}
              {models.map((m) => (
                <option
                  key={`${m.providerID}/${m.modelID}`}
                  value={`${m.providerID}/${m.modelID}`}
                >
                  {m.name}
                  {m.context ? ` · ${Math.round(m.context / 1024)}K` : ""}
                </option>
              ))}
            </select>
            {err && <span className="error inline">{err}</span>}
          </div>
        </div>
      </div>

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
function activityOf(msgs: Message[]): string {
  const last = [...msgs].reverse().find((m) => m.info.role === "assistant");
  const p = last?.parts[last.parts.length - 1];
  if (!last) return "排队中";
  if (!p) return "等待内核开始";
  if (p.type === "tool") {
    const st = p.state;
    if (st?.status === "running" || st?.status === "pending") {
      const head = toolHead(p);
      return `执行 ${p.tool ?? "工具"}${head ? ` · ${head}` : ""}`;
    }
    return "生成回复";
  }
  if (p.type === "reasoning") return "思考中";
  if (p.type === "text") return "输出中";
  return "生成回复";
}

function Block({
  part,
  onCopy,
  autoOpen,
}: {
  part: Part;
  onCopy: (t: string) => void;
  autoOpen: boolean;
}) {
  switch (part.type) {
    case "text":
      // 内核会往用户消息里塞 synthetic 文本（如语言提示），不属于对话内容
      if ((part as any).synthetic || part.metadata?.synthetic) return null;
      return <pre className="text">{part.text}</pre>;
    case "reasoning":
      return <ReasoningFold part={part} autoOpen={autoOpen} />;
    case "tool":
      return <ToolCard part={part} onCopy={onCopy} />;
    case "file":
      return <p className="hint">附件：{part.filename ?? part.url}</p>;
    case "patch": {
      const files = (part as any).files;
      if (!Array.isArray(files) || !files.length) return null;
      return <p className="hint">改动 {files.length} 个文件</p>;
    }
    // step-start / step-finish / snapshot / agent / subtask / compaction：不渲染
    default:
      return null;
  }
}

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
  const raw =
    part.tool === "bash"
      ? (i.description ?? title ?? i.command)
      : part.tool === "read" || part.tool === "edit" || part.tool === "write"
        ? baseName(i.filePath ?? i.path ?? title)
        : part.tool === "grep" || part.tool === "glob"
          ? i.pattern
          : part.tool === "webfetch"
            ? i.url
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

function ToolCard({ part, onCopy }: { part: Part; onCopy: (t: string) => void }) {
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
  // 执行中自动展开，跑完自动收起；用户手动开合过就以他为准
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? status !== "completed";
  return (
    <details className="fold tool" open={open}>
      <summary onClick={() => setManual(!open)}>
        <b>{part.tool ?? "工具"}</b>
        {head && <span className="arg">{head}</span>}
        <span className={`st ${status}`}>{STATE_CN[status] ?? status}</span>
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
      {err && <pre className="code err">{err}</pre>}
      {!err && result && (
        <Copyable text={result} onCopy={onCopy}>
          <pre className="code out">{result}</pre>
        </Copyable>
      )}
      {!err && truncated && <p className="hint">输出已被内核截断</p>}
    </details>
  );
}
