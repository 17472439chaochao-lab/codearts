import { useEffect, useRef } from "react";
import type { Menu } from "../../chatTypes";

export function ContextMenu({
  menu,
  onClose,
}: {
  menu: Menu;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="ctx"
      ref={boxRef}
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
            onClose();
            it.run();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
