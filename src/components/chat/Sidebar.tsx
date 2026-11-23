import {
  useCallback,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { APP_TITLE } from "../../App";
import { baseName, sameDir } from "../../workspaceUtils";
import type { QueuedPrompt } from "../../chatTypes";
import type { Session } from "../../kernelApi";

const SIDE_PAGE = 3;

/** 自绘滚动条 */
function OverlayBar({ box }: { box: RefObject<HTMLElement | null> }) {
  const bar = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const hideTimer = useRef(0);
  const drag = useRef<{ y: number; top: number; k: number } | null>(null);

  const sync = useCallback(() => {
    const el = box.current;
    const wrap = bar.current;
    const th = thumb.current;
    if (!el || !wrap || !th) return false;
    const track = wrap.clientHeight;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 2 || track <= 32) {
      wrap.classList.remove("on");
      return false;
    }
    const h = Math.max(28, Math.round((el.clientHeight / el.scrollHeight) * track));
    th.style.height = `${h}px`;
    th.style.transform = `translateY(${Math.round((el.scrollTop / max) * (track - h))}px)`;
    return true;
  }, [box]);

  const flash = useCallback(() => {
    if (!sync()) return;
    const wrap = bar.current;
    if (!wrap) return;
    wrap.classList.add("on");
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!drag.current) wrap.classList.remove("on");
    }, 900);
  }, [sync]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.addEventListener("scroll", flash, { passive: true });
    const ro = new ResizeObserver(() => sync());
    ro.observe(el);
    const mo = new MutationObserver(() => sync());
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    sync();
    return () => {
      el.removeEventListener("scroll", flash);
      ro.disconnect();
      mo.disconnect();
      window.clearTimeout(hideTimer.current);
    };
  }, [box, flash, sync]);

  function down(e: ReactPointerEvent<HTMLDivElement>) {
    const el = box.current;
    const wrap = bar.current;
    const th = thumb.current;
    if (!el || !wrap || !th) return;
    const track = wrap.clientHeight;
    const h = th.offsetHeight;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 2 || track <= h) return;
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    const rect = wrap.getBoundingClientRect();
    const top = Math.max(0, Math.min(track - h, e.clientY - rect.top - h / 2));
    el.scrollTop = (top / (track - h)) * max;
    drag.current = { y: e.clientY, top: el.scrollTop, k: max / (track - h) };
    window.clearTimeout(hideTimer.current);
    wrap.classList.add("on");
  }

  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    const el = box.current;
    if (d && el) el.scrollTop = d.top + (e.clientY - d.y) * d.k;
  }

  function up(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null;
    const wrap = bar.current;
    if (wrap?.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
    flash();
  }

  return (
    <div
      className="wsbar"
      ref={bar}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      aria-hidden="true"
    >
      <div className="wsthumb" ref={thumb} />
    </div>
  );
}

export type SidebarProps = {
  projects: string[];
  projectDir: string;
  list: Session[];
  active: string | null;
  query: string;
  pins: string[];
  sessShown: Record<string, number>;
  busySet: Set<string>;
  pendingCounts: Record<string, number>;
  sessionQueues: Record<string, QueuedPrompt[]>;
  ver: string;
  live: boolean;
  onQueryChange: (q: string) => void;
  onAddDir: () => void;
  onSwitchDir: (dir: string) => void;
  onDropDir: (dir: string) => void;
  onOpenSession: (id: string) => void;
  onCreateSession: () => void;
  onRemoveSession: (id: string) => void;
  onSetSessShown: (updater: (prev: Record<string, number>) => Record<string, number>) => void;
  onOpenSettings: () => void;
  onOpenStats?: () => void;
  onOpenWsMenu: (e: ReactMouseEvent, p: string, cur: boolean) => void;
  onOpenSessMenu: (e: ReactMouseEvent, p: string, id: string, cur: boolean) => void;
};

export function Sidebar({
  projects,
  projectDir,
  list,
  active,
  query,
  pins,
  sessShown,
  busySet,
  pendingCounts,
  sessionQueues,
  ver,
  live,
  onQueryChange,
  onAddDir,
  onSwitchDir,
  onDropDir,
  onOpenSession,
  onCreateSession,
  onRemoveSession,
  onSetSessShown,
  onOpenSettings,
  onOpenStats,
  onOpenWsMenu,
  onOpenSessMenu,
}: SidebarProps) {
  const wsList = useRef<HTMLUListElement>(null);
  const kw = query.trim().toLowerCase();

  const ofWs = useCallback(
    (ws: string) => {
      const all = list.filter((s) => sameDir(s.directory ?? "", ws));
      const filtered = kw ? all.filter((s) => (s.title || s.id).toLowerCase().includes(kw)) : all;
      const rank = (id: string) => (pins.includes(id) ? 0 : 1);
      return [...filtered].sort((a, b) => rank(a.id) - rank(b.id));
    },
    [list, kw, pins],
  );

  return (
    <aside className="side">
      <div className="drag" data-tauri-drag-region="deep">
        <span className="wtitle">{APP_TITLE}</span>
        {ver ? <span className="wver">{ver}</span> : null}
      </div>
      <div className="newbox">
        <button className="primary" onClick={onCreateSession} disabled={!live}>
          + 新建会话
        </button>
      </div>
      <div className="sessfind">
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
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onQueryChange("");
          }}
          placeholder="搜索会话"
          aria-label="按标题搜索会话"
          spellCheck={false}
        />
        {query && (
          <button className="x" onClick={() => onQueryChange("")} title="清空" aria-label="清空搜索">
            ×
          </button>
        )}
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
        <div className="wslistwrap">
          <ul className="wslist" data-tauri-drag-region="deep" ref={wsList}>
            {projects.map((p) => {
              const cur = sameDir(p, projectDir);
              const items = ofWs(p);
              const cap = kw ? items.length : (sessShown[p] ?? SIDE_PAGE);
              const head = items.slice(0, cap);
              const pinned = head.some((s) => s.id === active)
                ? undefined
                : items.find((s) => s.id === active);
              const visible = pinned ? [...head, pinned] : head;
              const shown = new Set(visible.map((s) => s.id));
              const rest = items.filter((s) => !shown.has(s.id)).length;
              const expanded = cap > SIDE_PAGE;
              return (
                <li key={p} className={`ws ${cur ? "on" : ""}`}>
                  <div className="wsrow" onContextMenu={(e) => onOpenWsMenu(e, p, cur)}>
                    <button
                      className="wsname"
                      onClick={() => onSwitchDir(p)}
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
                        onClick={() => onDropDir(p)}
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
                        onContextMenu={(e) => onOpenSessMenu(e, p, s.id, cur)}
                      >
                        <button
                          className="link"
                          onClick={() => onOpenSession(s.id)}
                          title={s.parentID ? `子任务会话 · ${s.id}` : s.id}
                        >
                          {pins.includes(s.id) && (
                            <span className="pin" aria-label="已置顶" title="已置顶">
                              ★
                            </span>
                          )}
                          {busySet.has(s.id) && (
                            <span className="sess-busy-dot" title="任务执行中" aria-label="执行中" />
                          )}
                          {s.parentID ? `↳ ${s.title || s.id}` : s.title || s.id}
                          {(pendingCounts[s.id] ?? 0) > 0 && (
                            <span
                              className="sess-badge warn"
                              title={`${pendingCounts[s.id]} 个待确认权限或提问`}
                            >
                              !{pendingCounts[s.id]}
                            </span>
                          )}
                          {(sessionQueues[s.id]?.length ?? 0) > 0 && (
                            <span className="sess-badge queue" title="有排队待发送的消息">
                              排队
                            </span>
                          )}
                        </button>
                        <button
                          className="x"
                          onClick={() => void onRemoveSession(s.id)}
                          title="删除会话"
                          aria-label="删除会话"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                    {(rest > 0 || expanded) && (
                      <li className="ops">
                        {rest > 0 && (
                          <button
                            className="link more"
                            onClick={() =>
                              onSetSessShown((prev) => ({ ...prev, [p]: cap + SIDE_PAGE }))
                            }
                          >
                            加载更多（{rest}）
                          </button>
                        )}
                        {expanded && (
                          <button
                            className="link more"
                            onClick={() =>
                              onSetSessShown((prev) => {
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
                    {!items.length && (
                      <li className="muted pad">{kw ? "没有匹配的会话" : "暂无会话"}</li>
                    )}
                  </ul>
                </li>
              );
            })}
          </ul>
          <OverlayBar box={wsList} />
        </div>
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
        {onOpenStats && (
          <button
            className="ico-btn stats-btn"
            onClick={onOpenStats}
            title="用量统计与工程度量"
            aria-label="用量统计"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M18 20V10M12 20V4M6 20v-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </footer>
    </aside>
  );
}
