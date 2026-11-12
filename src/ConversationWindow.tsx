import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

const Expansion = createContext<Map<string, boolean> | null>(null);

export function useConversationExpansion(key: string) {
  const saved = useContext(Expansion);
  const [open, setOpen] = useState(() => saved?.get(key) ?? false);
  return [open, (value: boolean) => {
    saved?.set(key, value);
    setOpen(value);
  }] as const;
}

type Watcher = { observer: IntersectionObserver; listeners: Map<Element, (visible: boolean) => void>; refreshSelection: () => void };
const watchers = new WeakMap<Element, Watcher>();

function watch(root: Element, target: Element, update: (visible: boolean) => void) {
  let watcher = watchers.get(root);
  if (!watcher) {
    const listeners = new Map<Element, (visible: boolean) => void>();
    const visibility = new WeakMap<Element, boolean>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        visibility.set(entry.target, entry.isIntersecting);
        listeners.get(entry.target)?.(entry.isIntersecting);
      }
    }, { root, rootMargin: "900px 0px" });
    const refreshSelection = () => {
      for (const [element, update] of listeners) {
        if (visibility.get(element) === false) update(false);
      }
    };
    document.addEventListener("selectionchange", refreshSelection);
    document.addEventListener("focusin", refreshSelection);
    watcher = { observer, listeners, refreshSelection };
    watchers.set(root, watcher);
  }
  watcher.listeners.set(target, update);
  watcher.observer.observe(target);
  return () => {
    watcher.listeners.delete(target);
    watcher.observer.unobserve(target);
    if (!watcher.listeners.size) {
      watcher.observer.disconnect();
      document.removeEventListener("selectionchange", watcher.refreshSelection);
      document.removeEventListener("focusin", watcher.refreshSelection);
      watchers.delete(root);
    }
  };
}

export const ConversationWindow = memo(function ConversationWindow({ id, eager, estimate, root, following, children }: {
  id: string;
  eager: boolean;
  estimate: number;
  root: RefObject<HTMLDivElement | null>;
  following: RefObject<boolean>;
  children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const height = useRef(estimate);
  const expanded = useRef(new Map<string, boolean>());
  const [visible, setVisible] = useState(eager);
  const mounted = eager || visible;
  useEffect(() => {
    if (!root.current || !box.current) return;
    return watch(root.current, box.current, (nearby) => {
      // 正在选字或用键盘操作的轮次不能从 DOM 中移走。
      const selection = window.getSelection();
      const selected = !!selection && !selection.isCollapsed && !!box.current &&
        Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)).some((range) => range.intersectsNode(box.current!));
      if (!nearby && (selected || box.current?.contains(document.activeElement))) return;
      setVisible(nearby);
    });
  }, [root]);
  useLayoutEffect(() => {
    const el = box.current;
    const scroll = root.current;
    if (!el || !scroll || !mounted) return;
    const measure = () => {
      const next = el.getBoundingClientRect().height;
      const previous = height.current;
      if (Math.abs(next - previous) < 0.5) return;
      const above = el.getBoundingClientRect().top + previous <= scroll.getBoundingClientRect().top;
      height.current = next;
      if (above && !following.current) scroll.scrollTop += next - previous;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted, root, following]);
  return (
    <section ref={box} id={`m-${id}`} className="conversation-turn" data-mounted={mounted ? "true" : "false"}
      style={mounted ? undefined : { height: height.current }}>
      <Expansion.Provider value={expanded.current}>{mounted ? children : null}</Expansion.Provider>
    </section>
  );
});
