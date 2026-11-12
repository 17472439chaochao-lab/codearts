import {
  createElement,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Token } from "marked";
import { openUrl } from "@tauri-apps/plugin-opener";
import { loadMarkdownEngine, type MarkdownEngine } from "./markdownEngine";
import "./ChatMarkdown.css";

type ChatMarkdownProps = {
  text: string;
  streaming: boolean;
  onCopy?: (text: string) => void;
};

const STREAM_INTERVAL = 80;
const MEDIUM_STREAM_TEXT = 6_000;
const HEAVY_STREAM_TEXT = 16_000;


function externalUrl(value: string | null): string | undefined {
  if (!value || /[\u0000-\u0020\u007f]/.test(value) || !/^(?:https?:\/\/|mailto:)/i.test(value)) return;
  try {
    const url = new URL(value);
    if (["http:", "https:", "mailto:"].includes(url.protocol)) return url.href;
  } catch {
    return;
  }
}

function useStreamText(text: string, streaming: boolean): string {
  const [visible, setVisible] = useState(text);
  const published = useRef({ text, at: performance.now() });

  useEffect(() => {
    const publish = () => {
      published.current = { text, at: performance.now() };
      setVisible(text);
    };
    if (!streaming || !published.current.text) {
      publish();
      return;
    }
    if (text === published.current.text) return;
    const interval = text.length > HEAVY_STREAM_TEXT ? 200 : text.length > MEDIUM_STREAM_TEXT ? 120 : STREAM_INTERVAL;
    const remaining = interval - (performance.now() - published.current.at);
    if (remaining <= 0) {
      publish();
      return;
    }
    const timer = window.setTimeout(publish, remaining);
    return () => window.clearTimeout(timer);
  }, [text, streaming]);

  return streaming ? visible : text;
}

function CodeBlock({ text, language, onCopy }: {
  text: string;
  language: string;
  onCopy?: ChatMarkdownProps["onCopy"];
}) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  const request = useRef(0);

  useEffect(() => {
    setState("idle");
    return () => {
      request.current += 1;
      window.clearTimeout(timer.current);
    };
  }, [text]);

  const copy = async () => {
    const current = ++request.current;
    window.clearTimeout(timer.current);
    setState("copying");
    try {
      if (onCopy) await onCopy(text);
      else await navigator.clipboard.writeText(text);
      if (current !== request.current) return;
      setState("copied");
    } catch {
      if (current !== request.current) return;
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  };
  const label = state === "copied" ? "已复制代码" : state === "failed" ? "复制失败，请重试" : "复制代码";

  return (
    <div className="chat-md-code">
      <div className="chat-md-code-bar">
        <span className="chat-md-language">{language || "代码"}</span>
        <span className="chat-md-copy-status" role="status" aria-live="polite">
          {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : ""}
        </span>
        <button
          type="button"
          className="chat-md-copy"
          aria-label={label}
          title={label}
          disabled={state === "copying"}
          onClick={() => void copy()}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" focusable="false">
            {state === "copied" ? <path d="m3 8 3 3 7-7" /> : <>
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 3.5v-1h-8v8h1" />
            </>}
          </svg>
        </button>
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

function renderChildren(parent: Node, onCopy: ChatMarkdownProps["onCopy"]): ReactNode[] {
  return Array.from(parent.childNodes).map((node, index): ReactNode => {
    if (node.nodeType === 3) {
      if (/^(?:TABLE|THEAD|TBODY|TR)$/.test(parent.nodeName) && !node.textContent?.trim()) return null;
      return node.textContent;
    }
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "pre") {
      const code = element.querySelector("code");
      return <CodeBlock key={index} text={code?.textContent ?? element.textContent ?? ""}
        language={code?.getAttribute("class")?.replace(/^language-/, "") ?? ""} onCopy={onCopy} />;
    }
    if (tag === "input") {
      return <input key={index} type="checkbox" disabled checked={element.hasAttribute("checked")} aria-label="任务完成状态" />;
    }
    if (tag === "br" || tag === "hr") return createElement(tag, { key: index });
    const children = renderChildren(element, onCopy);
    if (tag === "a") {
      const href = externalUrl(element.getAttribute("href"));
      const title = element.getAttribute("title") ?? undefined;
      return href ? <a key={index} href={href} title={title} rel="noopener noreferrer">{children}</a>
        : <span key={index} title={title}>{children}</span>;
    }
    if (tag === "table") {
      return <div key={index} className="chat-md-table" tabIndex={0} role="region" aria-label="Markdown 表格，可横向滚动">
        <table>{children}</table>
      </div>;
    }
    const attrs: { key: number; start?: number; className?: string } = { key: index };
    if (tag === "ol" && element.hasAttribute("start")) attrs.start = Number(element.getAttribute("start"));
    const align = element.getAttribute("align");
    if ((tag === "td" || tag === "th") && align && /^(left|center|right)$/.test(align)) {
      attrs.className = `chat-md-align-${align}`;
    }
    return createElement(tag, attrs, children);
  });
}

const MarkdownBlock = memo(function MarkdownBlock({ serialized, engine, onCopy }: {
  serialized: string;
  engine: MarkdownEngine;
  onCopy: ChatMarkdownProps["onCopy"];
}) {
  const token = JSON.parse(serialized) as Token;
  const fragment = engine.sanitizeFragment(engine.marked.parser([token]));
  return <div className="chat-md-block">{renderChildren(fragment, onCopy)}</div>;
});

export function ChatMarkdown({ text, streaming, onCopy }: ChatMarkdownProps) {
  const visible = useStreamText(text, streaming);
  const [engine, setEngine] = useState<MarkdownEngine | null>(null);
  useEffect(() => {
    let alive = true;
    loadMarkdownEngine().then((next) => {
      if (alive) setEngine(next);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const copyHandler = useRef(onCopy);
  useLayoutEffect(() => { copyHandler.current = onCopy; }, [onCopy]);
  const copy = useCallback((value: string) => {
    const handler = copyHandler.current;
    return handler ? handler(value) : navigator.clipboard.writeText(value);
  }, []);
  const [linkFailed, setLinkFailed] = useState(false);
  const linkRequest = useRef(0);
  useEffect(() => () => { linkRequest.current += 1; }, []);
  const heavy = streaming && visible.length > HEAVY_STREAM_TEXT;
  const blocks = useMemo(() => {
    if (heavy || !engine) return [];
    // 全文词法分析保留后置引用定义，序列化叶节点让无关的已完成块维持原 DOM。
    return engine.marked.lexer(visible)
      .filter((token) => token.type !== "space" && token.type !== "def")
      .map((token) => JSON.stringify(token));
  }, [visible, heavy, engine]);

  const openLink = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 && event.button !== 1) return;
    const url = externalUrl(anchor.getAttribute("href"));
    if (!url) return;
    const current = ++linkRequest.current;
    setLinkFailed(false);
    void openUrl(url).catch(() => {
      if (current === linkRequest.current) setLinkFailed(true);
    });
  };

  if (!engine || heavy) {
    return <div className="chat-markdown"><pre className="chat-md-stream">{visible}</pre></div>;
  }

  return (
    <div className="chat-markdown" onClickCapture={openLink} onAuxClickCapture={openLink}>
      {blocks.map((serialized, index) => <MarkdownBlock key={index} serialized={serialized} engine={engine} onCopy={copy} />)}
      {linkFailed && <p className="chat-md-link-error" role="status">无法打开链接，请检查系统权限后重试。</p>}
    </div>
  );
}
