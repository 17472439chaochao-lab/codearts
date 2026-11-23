import type { ReactNode } from "react";
import type { PermissionRequest, QuestionRequest } from "../../kernelApi";
import { QuestionCard } from "./QuestionCard";

export const PERM_CN: Record<string, string> = {
  bash: "终端命令",
  read: "读取文件",
  write: "修改或创建文件",
  delete: "删除文件",
  websearch: "联网搜索",
  fetch: "访问外部网络",
  external_directory_read: "读取工作区外目录",
};

export type PermBarProps = {
  activeAsks: QuestionRequest[];
  activePerms: PermissionRequest[];
  alert: { text: string; cmd: string } | null;
  toast: string | null;
  readOnly: boolean;
  kidFrom: (sid: string) => ReactNode;
  onAnswerQuestion: (q: QuestionRequest, answers: string[][]) => void;
  onRejectQuestion: (q: QuestionRequest) => void;
  onAnswerPerm: (p: PermissionRequest, choice: "once" | "always" | "reject") => void;
  onDismissAlert: () => void;
  onDismissToast: () => void;
};

export function PermBar({
  activeAsks,
  activePerms,
  alert,
  toast,
  readOnly,
  kidFrom,
  onAnswerQuestion,
  onRejectQuestion,
  onAnswerPerm,
  onDismissAlert,
  onDismissToast,
}: PermBarProps) {
  return (
    <>
      <div className="pending">
        {activeAsks.map((q) => (
          <QuestionCard
            key={q.id}
            q={q}
            from={kidFrom(q.sessionID)}
            onAnswer={(a) => onAnswerQuestion(q, a)}
            onReject={() => onRejectQuestion(q)}
          />
        ))}
        {activePerms.map((p) => (
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
              <button className="primary" onClick={() => onAnswerPerm(p, "once")}>
                允许一次
              </button>
              {!!p.always?.length && (
                <button onClick={() => onAnswerPerm(p, "always")}>始终允许</button>
              )}
              <button onClick={() => onAnswerPerm(p, "reject")}>拒绝</button>
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
          <button onClick={onDismissAlert}>知道了</button>
        </p>
      )}

      {toast && (
        <p className="hint toast">
          <span className="grow">{toast}</span>
          <button onClick={onDismissToast}>知道了</button>
        </p>
      )}

      {readOnly && (
        <p className="hint robar">
          <span className="grow">
            子任务会话 · task 派出去的独立会话，只能看不能接着发
          </span>
        </p>
      )}
    </>
  );
}
