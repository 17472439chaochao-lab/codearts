import type { Marked } from "marked";

export type MarkdownEngine = {
  marked: Marked;
  sanitizeHtml: (html: string) => string;
  sanitizeFragment: (html: string) => DocumentFragment;
};

let pending: Promise<MarkdownEngine> | null = null;

const FRAGMENT_TAGS = ["p", "br", "strong", "em", "del", "a", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td", "input"];
const FRAGMENT_ATTR = ["href", "title", "class", "align", "start", "type", "disabled", "checked"];
const SAFE_URI = /^(?:https?:\/\/|mailto:)/i;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

/** marked 与 dompurify 合计接近 100KB，只有真正渲染 Markdown 时才拉进运行时。 */
export function loadMarkdownEngine(): Promise<MarkdownEngine> {
  return pending ??= Promise.all([import("marked"), import("dompurify")]).then(([{ Marked }, { default: DOMPurify }]) => {
    const marked = new Marked({
      gfm: true,
      async: false,
      renderer: {
        html({ text }) {
          return escapeHtml(text);
        },
        text(token) {
          return "escaped" in token && token.escaped ? escapeHtml(token.text) : false;
        },
        image(token) {
          const label = `图片：${token.text || "查看图片"}`;
          return this.link({
            ...token,
            type: "link",
            text: label,
            tokens: [{ type: "text", raw: label, text: label }],
          });
        },
        code({ text, lang }) {
          const language = lang?.match(/^\S+/)?.[0] ?? "";
          return `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre>`;
        },
      },
    });
    return {
      marked,
      sanitizeHtml: (html) => DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style"] }),
      sanitizeFragment: (html) => DOMPurify.sanitize(html, {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS: FRAGMENT_TAGS,
        ALLOWED_ATTR: FRAGMENT_ATTR,
        ALLOWED_URI_REGEXP: SAFE_URI,
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
      }) as unknown as DocumentFragment,
    };
  });
}