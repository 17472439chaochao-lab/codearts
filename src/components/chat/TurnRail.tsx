import { useState } from "react";
import type { Message } from "../../kernelApi";

/** 右侧轮次导航的标题：取该轮用户输入的第一段真实文本 */
export function turnText(m: Message, max = 24): string {
  for (const p of m.parts) {
    if (p.type === "text" && p.text?.trim()) {
      const first = p.text.trim().split(/\r?\n/)[0].trim();
      return first.length > max ? `${first.slice(0, max)}…` : first;
    }
  }
  return "（空）";
}

export type TurnRailProps = {
  turns: Message[];
  railHit: string | null;
  onJumpTo: (id: string) => void;
};

export function TurnRail({ turns, railHit, onJumpTo }: TurnRailProps) {
  const [tip, setTip] = useState<{ top: number; text: string } | null>(null);

  if (turns.length <= 1) return null;

  function showTip(btn: HTMLElement, text: string) {
    const parent = btn.closest(".body");
    const prect = parent?.getBoundingClientRect() ?? { top: 0 };
    const brect = btn.getBoundingClientRect();
    setTip({
      top: brect.top - prect.top + brect.height / 2,
      text,
    });
  }

  return (
    <>
      <nav className="rail" aria-label="轮次导航" onMouseLeave={() => setTip(null)}>
        <div className="railinner">
          {turns.map((m, i) => (
            <button
              key={m.info.id}
              className={railHit === m.info.id ? "on" : ""}
              onClick={() => onJumpTo(m.info.id)}
              onMouseEnter={(e) => showTip(e.currentTarget, `${i + 1} · ${turnText(m, 160)}`)}
              onFocus={(e) => showTip(e.currentTarget, `${i + 1} · ${turnText(m, 160)}`)}
              aria-label={`跳到第 ${i + 1} 轮`}
            />
          ))}
        </div>
      </nav>
      {tip && (
        <div className="tip" style={{ top: tip.top }}>
          {tip.text}
        </div>
      )}
    </>
  );
}
