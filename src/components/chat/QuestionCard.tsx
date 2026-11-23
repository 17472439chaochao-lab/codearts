import { useState, type ReactNode } from "react";
import type { QuestionRequest } from "../../kernelApi";

/** 内核反问：把 header/question/options 摊成可点的选项，而不是一个 JSON 折叠卡 */
export function QuestionCard({
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
        <span>
          {many ? `${q.questions.length} 个问题，一次答完` : "选一项，内核按你的选择继续"}
        </span>
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
      <footer className="qfoot">
        <div className="row">
          <button className="primary" disabled={!ready} onClick={() => onAnswer(answers)}>
            提交回答
          </button>
          <button onClick={onReject}>不回答</button>
        </div>
        {!ready && <p className="asknote">每个问题至少选一项</p>}
      </footer>
    </div>
  );
}
