import { Fragment, useEffect, useRef, useState, type KeyboardEvent } from "react";

export type ChipOption = {
  value: string;
  label: string;
  hint?: string;
  group?: string;
  prov?: string;
};

/**
 * 原生 select 的展开层归系统画，改不了样式；换成自绘 listbox。
 * 支持点击外部/Esc 收起、上下键移动、Enter 选中，菜单向上弹。
 */
export function ChipSelect({
  value,
  options,
  placeholder,
  disabled,
  title,
  className,
  align = "left",
  onChange,
}: {
  value: string;
  options: ChipOption[];
  placeholder: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  align?: "left" | "right";
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const box = useRef<HTMLDivElement | null>(null);
  const cur = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function openMenu() {
    const i = options.findIndex((o) => o.value === value);
    setHi(i < 0 ? 0 : i);
    setOpen(true);
  }

  function pick(v: string) {
    setOpen(false);
    if (v !== value) onChange(v);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHi((h) => (Math.max(h, 0) + step + options.length) % options.length);
    } else if (open && e.key === "Enter") {
      e.preventDefault();
      const o = options[hi];
      if (o) pick(o.value);
    }
  }

  return (
    <div className={`chipsel ${align === "right" ? "right" : ""} ${className ?? ""}`} ref={box}>
      <button
        type="button"
        className={`chip ${open ? "open" : ""}`}
        disabled={disabled || !options.length}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="chiptx">{cur?.label ?? placeholder}</span>
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
        <div className="chipmenu" role="listbox" aria-label={title}>
          {options.map((o, i) => (
            <Fragment key={o.value}>
              {o.group && o.group !== options[i - 1]?.group && (
                <div className="chipgroup">{o.group}</div>
              )}
              {o.prov && <div className="chipgroup sub">{o.prov}</div>}
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                key={o.value}
                className={`${o.value === value ? "on" : ""} ${i === hi ? "hi" : ""}`}
                onMouseEnter={() => setHi(i)}
                onClick={() => pick(o.value)}
              >
                <span className="chiptext">
                  <span className="lbl">{o.label}</span>
                  {o.hint && <span className="sub">{o.hint}</span>}
                </span>
                {o.value === value && (
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
                )}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
