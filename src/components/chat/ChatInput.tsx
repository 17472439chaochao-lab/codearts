import {
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentInfo, CommandInfo, ModelInfo, ModelRef, PermRule } from "../../kernelApi";
import type { Attachment, MenuItem, QueuedPrompt } from "../../chatTypes";
import { imgSize } from "../../chatTypes";
import { POLICIES } from "../../policyUtils";
import { ChipSelect, type ChipOption } from "../ChipSelect";

export const AGENT_CN: Record<string, string> = {
  build: "执行",
  plan: "规划",
  "docgen-agent": "文档",
};

export const AGENT_DESC_CN: Record<string, string> = {
  build: "默认 agent，按当前授权策略执行工具。",
  plan: "规划模式，禁用所有修改文件的工具。",
  "docgen-agent": "自动完成文档生成任务（docgen、codebase-cli），无需人工交互。",
  explore: "只读探索代码和工作区，不做修改。",
};

export type ChatInputProps = {
  input: string;
  setInput: (val: string) => void;
  live: boolean;
  readOnly: boolean;
  busy: boolean;
  err: string | null;
  lastErr: boolean;
  retryBtn?: ReactNode;
  active: string | null;
  canSend: boolean;
  attachments: Attachment[];
  sessionQueues: Record<string, QueuedPrompt[]>;
  palette: CommandInfo[];
  paletteIndex: number;
  commandsCount: number;
  agent: string | null;
  agentList: AgentInfo[];
  policy: string;
  rules: PermRule[] | null;
  denyRulesCount: number;
  model: ModelRef | null;
  models: ModelInfo[];
  modelOptions: ChipOption[];
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPasteImages: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveAttachment: (id: string) => void;
  onCancelQueue: (sessionId: string, index: number) => void;
  onDismissErr: () => void;
  onTogglePlan: () => void;
  onChooseAgent: (agent: string) => void;
  onApplyPolicy: (policyId: string) => void;
  onSelectModel: (modelVal: string) => void;
  onSend: () => void;
  onAbort: () => void;
  onEnqueueCurrent: () => void;
  onInterruptAndSend: () => void;
  onAcceptPalette: (cmd: CommandInfo) => void;
  onSetPaletteIndex: (index: number) => void;
  onOpenMenu: (e: ReactMouseEvent, items: MenuItem[]) => void;
  onAddImages?: (files: File[]) => void;
};

export function ChatInput({
  input,
  setInput,
  live,
  readOnly,
  busy,
  err,
  lastErr,
  retryBtn,
  active,
  canSend,
  attachments,
  sessionQueues,
  palette,
  paletteIndex,
  commandsCount,
  agent,
  agentList,
  policy,
  rules,
  denyRulesCount,
  model,
  models,
  modelOptions,
  onKey,
  onPasteImages,
  onRemoveAttachment,
  onCancelQueue,
  onDismissErr,
  onTogglePlan,
  onChooseAgent,
  onApplyPolicy,
  onSelectModel,
  onSend,
  onAbort,
  onEnqueueCurrent,
  onInterruptAndSend,
  onAcceptPalette,
  onSetPaletteIndex,
  onOpenMenu,
  onAddImages,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeQueues = active ? sessionQueues[active] ?? [] : [];

  function onTextareaContextMenu(e: ReactMouseEvent<HTMLTextAreaElement>) {
    e.preventDefault();
    e.stopPropagation();
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? input.length;
    const end = textarea?.selectionEnd ?? input.length;
    const selectedText = input.slice(start, end);

    const items: MenuItem[] = [
      {
        label: "粘贴",
        run: async () => {
          try {
            // 1. 优先通过 Tauri 原生命令读取系统剪贴板图片（完美支持 macOS WKWebView 截图粘贴）
            try {
              const dataUrl = await invoke<string | null>("read_clipboard_image");
              if (dataUrl && onAddImages) {
                const res = await fetch(dataUrl);
                const blob = await res.blob();
                const ext = dataUrl.startsWith("data:image/png") ? "png" : "tiff";
                const file = new File([blob], `screenshot-${Date.now()}.${ext}`, {
                  type: blob.type || (ext === "png" ? "image/png" : "image/tiff"),
                });
                onAddImages([file]);
                return;
              }
            } catch {
              // 继续尝试其它途径
            }

            // 2. 尝试标准 Web API 读取图片（Windows Chromium / 支持 navigator.clipboard.read 的环境）
            if (navigator.clipboard?.read) {
              try {
                const clipItems = await navigator.clipboard.read();
                const imgFiles: File[] = [];
                for (const item of clipItems) {
                  for (const type of item.types) {
                    if (type.startsWith("image/")) {
                      const blob = await item.getType(type);
                      imgFiles.push(
                        new File([blob], `paste-${Date.now()}.${type.split("/")[1] || "png"}`, { type }),
                      );
                    }
                  }
                }
                if (imgFiles.length > 0 && onAddImages) {
                  onAddImages(imgFiles);
                  return;
                }
              } catch {
                // 读取图片失败则继续尝试文本
              }
            }

            // 3. 读取剪贴板纯文本
            const text = await navigator.clipboard.readText();
            if (text) {
              const before = input.slice(0, start);
              const after = input.slice(end);
              setInput(before + text + after);
              setTimeout(() => {
                if (textareaRef.current) {
                  textareaRef.current.focus();
                  const pos = start + text.length;
                  textareaRef.current.setSelectionRange(pos, pos);
                }
              }, 0);
            }
          } catch (err) {
            console.warn("读取剪贴板失败:", err);
          }
        },
      },
    ];

    if (selectedText.trim()) {
      items.push({
        label: "复制",
        run: async () => {
          await navigator.clipboard.writeText(selectedText);
        },
      });
      items.push({
        label: "剪切",
        run: async () => {
          await navigator.clipboard.writeText(selectedText);
          const before = input.slice(0, start);
          const after = input.slice(end);
          setInput(before + after);
          setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.focus();
              textareaRef.current.setSelectionRange(start, start);
            }
          }, 0);
        },
      });
    }

    if (input.trim()) {
      items.push({
        label: "清空",
        run: () => {
          setInput("");
          textareaRef.current?.focus();
        },
      });
    }

    onOpenMenu(e, items);
  }

  return (
    <>
      {!!palette.length && (
        <ul className="slash" onMouseDown={(e) => e.preventDefault()}>
          {palette.map((c, i) => (
            <li key={c.name}>
              <button
                className={i === paletteIndex ? "on" : ""}
                onClick={() => onAcceptPalette(c)}
                onMouseEnter={() => onSetPaletteIndex(i)}
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
            <span>{commandsCount} 条命令</span>
          </li>
        </ul>
      )}

      {!!attachments.length && (
        <div className="attachrow" aria-label="待发送的图片">
          {attachments.map((a) => (
            <div className="attach" key={a.id}>
              <img
                src={a.url}
                alt={a.name}
                title={
                  a.ocr?.state === "done"
                    ? `${a.name} · 已提取 ${a.ocr.text?.length ?? 0} 字`
                    : `${a.name} · ${imgSize(a.size)}`
                }
              />
              <button
                type="button"
                className="xbtn"
                onClick={() => onRemoveAttachment(a.id)}
                title="移除这张图片"
                aria-label={`移除 ${a.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {active && activeQueues.length > 0 && (
        <div className="queue-bar">
          <span className="queue-label">
            ⏳ {activeQueues.length} 条消息排队中（将在当前任务完成后自动发送）
          </span>
          <div className="queue-items">
            {activeQueues.map((q, idx) => (
              <span key={idx} className="queue-item">
                <span className="queue-text">
                  {q.raw.length > 20 ? `${q.raw.slice(0, 20)}…` : q.raw || (q.imgs.length ? `[${q.imgs.length} 张图片]` : "消息")}
                </span>
                <button
                  type="button"
                  className="queue-del"
                  onClick={() => onCancelQueue(active, idx)}
                  title="取消此排队消息"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={input}
        disabled={readOnly}
        placeholder={
          readOnly
            ? "子任务会话只读，回到父会话才能继续"
            : live
              ? "描述要做的改动，可粘贴截图，/ 唤起命令，! 直接跑命令，Enter 发送"
              : "先启动内核"
        }
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPasteImages}
        onContextMenu={onTextareaContextMenu}
      />

      {err && !lastErr && (
        <div className="errbar" role="alert">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M8 4.6v4.3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
          </svg>
          <span className="grow">{err}</span>
          {retryBtn}
          <button
            type="button"
            className="x"
            onClick={onDismissErr}
            title="关闭"
            aria-label="关闭错误提示"
          >
            ×
          </button>
        </div>
      )}

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
            onClick={onTogglePlan}
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
            onChange={onChooseAgent}
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
            title={
              (POLICIES.find((p) => p.id === policy)?.hint ??
                "当前策略与三种预设都不一致") +
              (denyRulesCount
                ? `；另有 ${denyRulesCount} 项手动禁止，切换策略时保留`
                : "")
            }
            onChange={onApplyPolicy}
          />
          <ChipSelect
            className="model"
            align="right"
            value={model ? `${model.providerID}/${model.modelID}` : ""}
            options={modelOptions}
            placeholder="无可用模型"
            disabled={!models.length}
            title="选择模型"
            onChange={onSelectModel}
          />
        </div>
        <span className="grow" />
        {busy ? (
          <div className="busy-ops">
            <button
              type="button"
              className="send stop"
              onClick={onAbort}
              title="停止当前任务"
              aria-label="停止当前任务"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.7" fill="currentColor" />
              </svg>
            </button>
            {(input.trim() || attachments.length > 0) && (
              <>
                <button
                  type="button"
                  className="queue-btn"
                  onClick={onEnqueueCurrent}
                  title="加入排队（当前任务完成后自动发送）"
                >
                  排队
                </button>
                <button
                  type="button"
                  className="send steer"
                  onClick={onInterruptAndSend}
                  title="打断并发送（Enter）"
                  aria-label="打断并发送"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M8.5 1.5L2.5 9h5l-1 5.5L13.5 7h-5l1-5.5z" fill="currentColor" />
                  </svg>
                  插单
                </button>
              </>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="send"
            onClick={onSend}
            disabled={!canSend}
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
    </>
  );
}
