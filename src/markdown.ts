/** 计划/README 的 GitHub 风格预览：解析和清洗都按需加载，只在打开 .md 时才进 bundle 分支 */
export async function renderMarkdown(text: string): Promise<string> {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import("marked"),
    import("dompurify"),
  ]);
  // 文件头的 YAML frontmatter 不渲染成正文
  const body = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  const html = marked.parse(body, { gfm: true, async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style"] });
}
