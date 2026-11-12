const ENVELOPE = /^\s*(?:(?:<path>[\s\S]*?<\/path>|<type>[\s\S]*?<\/type>)\s*)+<content>([\s\S]*?)<\/content>\s*$/i;

export function readableToolOutput(output: string): string {
  const match = output.match(ENVELOPE);
  if (!match) return output;
  return match[1].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}