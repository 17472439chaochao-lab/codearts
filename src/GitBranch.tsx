import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type GitBranch = {
  name: string;
  upstream: string | null;
  current: boolean;
  /** 远程分支对应的本地短名（origin/feat → feat） */
  local: string | null;
};

export type GitState = {
  repo: boolean;
  current: string | null;
  detached: boolean;
  head: string | null;
  /** 已跟踪文件里的未提交改动数（不算未跟踪文件） */
  dirty: number;
  branches: GitBranch[];
  remotes: GitBranch[];
};

/** 远程分支最多展示这么多条：工作区一多，origin/* 能有上百条 */
const REMOTE_LIMIT = 60;

const BranchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M6 3v12M18 9a9 9 0 0 1-9 9"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <circle cx="18" cy="6" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
    <circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
  </svg>
);

const Check = () => (
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
);

/**
 * 顶栏的 Git 分支。内核只提供 `/vcs`（当前分支名），列分支和切分支由壳侧 git 命令完成：
 * 目录仍由 Settings 推导，分支名只接受列表里出现过的值。
 */
export function BranchPicker({
  dir,
  name,
  blocked,
  onSwitched,
}: {
  dir: string;
  /** 显示的当前分支；游离 HEAD 时是 `(abc1234)` */
  name: string;
  /** 非空 = 现在不能切，内容作为原因挂在 title 上 */
  blocked?: string | null;
  onSwitched: (st: GitState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<GitState | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const box = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 会话跑起来就收起面板：这时候分支按钮已经禁用，留个能点的面板在旁边只会误导
  useEffect(() => {
    if (blocked) setOpen(false);
  }, [blocked]);

  // 打开面板时才拉列表：每轮对话起停都会刷新分支状态，没必要每次都跑一遍 git
  useEffect(() => {
    if (!open || !dir) return;
    let live = true;
    setLoading(true);
    setErr(null);
    invoke<GitState>("git_branches", { directory: dir })
      .then((st) => {
        if (live) setState(st);
      })
      .catch((e) => {
        if (live) setErr(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, dir]);

  function toggle() {
    if (blocked) return;
    setOpen((o) => {
      const next = !o;
      if (next) {
        // 每次打开都回到干净状态，避免上次的搜索词/报错赖着
        setQ("");
        setErr(null);
        setCreating(false);
        setNewName("");
        setState(null);
      }
      return next;
    });
  }

  async function pick(target: string, create = false) {
    if (switching) return;
    const label = create ? `+ ${target}` : target;
    setSwitching(label);
    setErr(null);
    try {
      const st = await invoke<GitState>("git_switch", { directory: dir, name: target, create });
      if (!alive.current) return;
      setState(st);
      setOpen(false);
      onSwitched(st);
    } catch (e) {
      if (!alive.current) return;
      setErr(String(e));
      // 失败多半是工作区脏或分支被别处动过，重新拉一次状态再把面板留着
      try {
        const st = await invoke<GitState>("git_branches", { directory: dir });
        if (alive.current) setState(st);
      } catch {
        // 连列表都读不到就只留上面那条错误
      }
    } finally {
      if (alive.current) setSwitching(null);
    }
  }

  const ql = q.trim().toLowerCase();
  const locals = (state?.branches ?? []).filter((b) => !ql || b.name.toLowerCase().includes(ql));
  const remotes = (state?.remotes ?? []).filter((r) => !ql || r.name.toLowerCase().includes(ql));
  const remoteShown = remotes.slice(0, REMOTE_LIMIT);
  const dup = !!newName.trim() && (state?.branches ?? []).some((b) => b.name === newName.trim());
  const currentName = state?.current ?? null;

  function submitNew(e: React.FormEvent) {
    e.preventDefault();
    const v = newName.trim();
    if (!v || dup || switching) return;
    void pick(v, true);
  }

  return (
    <div className="branchsel" ref={box}>
      <button
        type="button"
        className={`branch ${open ? "open" : ""}`}
        onClick={toggle}
        disabled={!!blocked}
        title={blocked ?? `Git 分支 ${name} · 点击切换`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <BranchIcon />
        <span className="btx">{name}</span>
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
        <div
          className="branchmenu"
          role="dialog"
          aria-label="切换 Git 分支"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="bmhead">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={switching ? `正在切到 ${switching}…` : "搜索分支"}
              disabled={!!switching}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const hit = locals.find((b) => !b.current);
                if (hit) void pick(hit.name);
              }}
            />
          </div>

          {state?.detached && (
            <p className="bmnote">
              当前是游离 HEAD{state.head ? `（${state.head}）` : ""}，切到任一分支即可回到正常状态
            </p>
          )}
          {!!state?.dirty && (
            <p className="bmnote warn">
              工作区有 {state.dirty} 个文件未提交，冲突时 git 会拒绝这次切换
            </p>
          )}
          {err && <p className="bmerr">{err}</p>}
          {loading && <p className="bmnote">读取分支…</p>}

          <div className="bmlist">
            {locals.map((b) => (
              <button
                type="button"
                key={b.name}
                className={`bmrow ${b.current ? "on" : ""}`}
                disabled={!!switching || b.current}
                onClick={() => void pick(b.name)}
                title={b.upstream ? `${b.name} → ${b.upstream}` : b.name}
              >
                <span className="bmlbl">{b.name}</span>
                {switching === b.name ? (
                  <span className="bmsub">切换中…</span>
                ) : b.current ? (
                  <Check />
                ) : (
                  b.upstream && <span className="bmsub">{b.upstream}</span>
                )}
              </button>
            ))}

            {remoteShown.length > 0 && (
              <div className="bmgroup">远程 · 切过去会建本地跟踪分支</div>
            )}
            {remoteShown.map((r) => (
              <button
                type="button"
                key={r.name}
                className="bmrow remote"
                disabled={!!switching || (!!r.local && r.local === currentName)}
                onClick={() => void pick(r.name)}
                title={r.name}
              >
                <span className="bmlbl">{r.name}</span>
                {switching === r.name && <span className="bmsub">切换中…</span>}
              </button>
            ))}
            {remotes.length > remoteShown.length && (
              <p className="bmnote">还有 {remotes.length - remoteShown.length} 个远程分支，输入名字可以筛</p>
            )}

            {!loading && !err && !locals.length && !remoteShown.length && (
              <p className="bmnote">{state?.repo === false ? "这个工作区不是 git 仓库" : "没有匹配的分支"}</p>
            )}
          </div>

          <div className="bmfoot">
            {creating ? (
              <form onSubmit={submitNew}>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="新分支名"
                  disabled={!!switching}
                />
                <button type="submit" disabled={!newName.trim() || dup || !!switching}>
                  创建并切换
                </button>
              </form>
            ) : (
              <button type="button" className="bmlink" onClick={() => setCreating(true)}>
                ＋ 从当前分支新建
              </button>
            )}
            {creating && dup && <p className="bmnote warn">同名分支已存在</p>}
          </div>
        </div>
      )}
    </div>
  );
}
