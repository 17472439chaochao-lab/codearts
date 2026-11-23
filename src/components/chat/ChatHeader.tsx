import { IS_WINDOWS, type KernelStatus } from "../../App";
import { BranchPicker, type GitState } from "../../GitBranch";
import type { FileDiff, Session, VcsInfo } from "../../kernelApi";

export type ChatHeaderProps = {
  live: boolean;
  status: KernelStatus | null;
  activeSess?: Session;
  gitState: GitState | null;
  branch: VcsInfo | null;
  wsDir: string;
  busySet: Set<string>;
  kernelBusy: boolean;
  filesOpen: boolean;
  sessionDiffs: FileDiff[];
  bridge: "open" | "down";
  bridgeMsg: string | null;
  busy: boolean;
  onBranchSwitched: (st: GitState) => void;
  onStart: () => Promise<void>;
  onStop: () => Promise<void>;
  onQuickOpen: () => void;
  onToggleFiles: () => void;
  onRedoUndo: () => void;
};

export function ChatHeader({
  live,
  status,
  activeSess,
  gitState,
  branch,
  wsDir,
  busySet,
  kernelBusy,
  filesOpen,
  sessionDiffs,
  bridge,
  bridgeMsg,
  busy,
  onBranchSwitched,
  onStart,
  onStop,
  onQuickOpen,
  onToggleFiles,
  onRedoUndo,
}: ChatHeaderProps) {
  return (
    <>
      <header className="bar" data-tauri-drag-region="deep">
        <span className={`dot ${live ? "ok" : ""}`} />
        <span className="muted">
          {live ? `内核在线 · ${status?.version}` : "内核未运行"}
        </span>
        {(gitState?.repo || branch?.branch) && (
          <BranchPicker
            dir={wsDir}
            name={
              gitState?.repo
                ? (gitState.current ?? (gitState.head ? `(${gitState.head})` : "无分支"))
                : (branch?.branch ?? "")
            }
            blocked={
              busySet.size
                ? "还有会话在运行，等这一轮结束再切分支（避免切到一半文件被换掉）"
                : null
            }
            onSwitched={onBranchSwitched}
          />
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
          className="ico-btn"
          onClick={onQuickOpen}
          disabled={!live}
          title={`按文件名打开文件（${IS_WINDOWS ? "Ctrl+P" : "⌘P"}）`}
          aria-label="按文件名打开文件"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path
              d="M20 20l-3.6-3.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <button
          className={`filesbtn ${filesOpen ? "on" : ""}`}
          onClick={onToggleFiles}
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
        <p className="hint bridge" title={bridgeMsg ?? undefined}>
          事件流中断，正在自动重连…重连后会自动补齐期间的数据
        </p>
      )}

      {activeSess?.revert && (
        <p className="hint revertbar">
          <span className="grow">已撤销到这条之前：后面的回复和文件改动都跟着退回了</span>
          {!busy && (
            <button onClick={onRedoUndo} title="把撤掉的这段历史和文件快照放回来">
              恢复撤销
            </button>
          )}
        </p>
      )}
    </>
  );
}
