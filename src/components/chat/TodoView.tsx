import { memo, useState } from "react";
import type { Todo } from "../../kernelApi";

export const TODO_CN: Record<string, string> = {
  pending: "待办",
  in_progress: "进行中",
  completed: "完成",
  cancelled: "已取消",
};

export const STATUS_TITLE: Record<string, string> = {
  pending: "未开始",
  in_progress: "正在执行",
  completed: "已完成",
  cancelled: "已取消",
};

export const doneCount = (todos: Todo[]): number =>
  todos.filter((t) => t.status === "completed").length;

export function parseTodos(raw: unknown): Todo[] | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw as Todo[];
  if (typeof raw === "object" && Array.isArray((raw as any).todos)) {
    return (raw as any).todos as Todo[];
  }
  return undefined;
}

export function todoProg(todos: Todo[]): string {
  const done = doneCount(todos);
  return `${done}/${todos.length}`;
}

/** 每行的状态点：待办空圈、进行中蓝色三角、完成绿勾、取消灰叉 */
export function TodoMark({ status }: { status: string }) {
  if (status === "completed")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" fill="currentColor" />
        <path
          d="M5.1 8.2l2 2 3.9-4.3"
          fill="none"
          stroke="#ffffff"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (status === "in_progress")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6.3 4.4l5.3 3.6-5.3 3.6z" fill="currentColor" />
      </svg>
    );
  if (status === "cancelled")
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M6 6l4 4M10 6l-4 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function TodoRows({ todos }: { todos: Todo[] }) {
  return (
    <ol className="todoRows">
      {todos.map((t, i) => (
        <li key={i} data-status={t.status} title={STATUS_TITLE[t.status] ?? t.status}>
          <span className="tmark" aria-hidden="true">
            <TodoMark status={t.status} />
          </span>
          <span className="tx">{t.content}</span>
          <span className="tmeta">
            {t.priority === "high" && <span className="pri">高优</span>}
            <span className="st-cn">{TODO_CN[t.status] ?? t.status}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * 轮末待办：收在该轮最底部。跑着的时候不在这里出现，
 * 由 TodoFly 悬浮展示；一轮结束后才落到这里，回看时按轮归档。
 */
export const TurnTodo = memo(function TurnTodo({ todos }: { todos?: Todo[] }) {
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
        <span>
          待办 {done} / {todos.length}
        </span>
        {!all && doing && <span className="muted"> · {doing.content}</span>}
      </summary>
      <TodoRows todos={todos} />
    </details>
  );
});

/** 运行中的悬浮清单：绝对定位在对话区右上角，不随消息滚走，可折叠 */
export function TodoFly({ todos, pulse }: { todos: Todo[]; pulse: number }) {
  const [fold, setFold] = useState(false);
  if (!todos.length) return null;
  const done = doneCount(todos);
  const pct = Math.round((done / todos.length) * 100);
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
          {done} / {todos.length}
        </span>
        <span className="grow" />
        <span className="tfchev" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path
              d={fold ? "M6 3.6l4.4 4.4L6 12.4" : "M3.6 6L8 10.4 12.4 6"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>
      {!fold && (
        <>
          <div className="tfbar" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </div>
          <TodoRows todos={todos} />
        </>
      )}
    </aside>
  );
}
