import { loadMarkdownEngine } from "./markdownEngine";

/** 计划/README 的 GitHub 风格预览：与聊天正文共用同一份按需解析和清洗库 */
export async function renderMarkdown(text: string): Promise<string> {
  // 文件头的 YAML frontmatter 不渲染成正文
  const body = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  const engine = await loadMarkdownEngine();
  return engine.sanitizeHtml(engine.marked.parse(body, { gfm: true, async: false }) as string);
}