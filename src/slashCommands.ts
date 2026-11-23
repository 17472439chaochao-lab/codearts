/**
 * 斜杠快捷指令相关解析与模板替换公共工具
 */

/**
 * 正在敲一条斜杠命令时才返回它的名字部分；一旦敲空格就说明参数已经在写了，面板要收起
 */
export function slashToken(text: string): string | null {
  if (!text.startsWith("/") || /\s/.test(text)) return null;
  return text.slice(1);
}

/**
 * 根据当前输入的斜杠前缀模糊过滤命令列表，最多返回 8 个候选
 */
export function slashMatches<T extends { name: string }>(text: string, cmds: T[]): T[] {
  const tok = slashToken(text);
  if (tok === null) return [];
  const k = tok.toLowerCase();
  return cmds.filter((c) => c.name.toLowerCase().includes(k)).slice(0, 8);
}

/**
 * 内核的 HTTP 侧不展开命令模板（实测直接把 "/review x" 当普通 prompt 发，
 * 模型只看到一个陌生斜杠词），所以壳子自己按 TUI 的做法替换 $ARGUMENTS。
 */
export function expandSlash(text: string, cmds: Array<{ name: string; template?: string }>): string {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!m) return text;
  const cmd = cmds.find((c) => c.name === m[1]);
  if (!cmd?.template) return text;
  const args = m[2].trim();
  if (cmd.template.includes("$ARGUMENTS")) return cmd.template.replace(/\$ARGUMENTS/g, args);
  return args ? `${cmd.template}\n\n${args}` : cmd.template;
}
