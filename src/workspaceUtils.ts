/**
 * 工作区与路径处理公共工具函数
 */

/**
 * 比较两个目录是否指向同一个路径（忽略末尾路径分隔符，兼容 Windows 反斜杠）
 */
export const sameDir = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  const cleanA = a.replace(/[\\/]+$/, "");
  const cleanB = b.replace(/[\\/]+$/, "");
  return cleanA === cleanB;
};

/**
 * 提取文件或目录的基础名（最后一个路径分段）
 */
export const baseName = (p: unknown): string => {
  if (typeof p !== "string" || !p) return "";
  return p.split(/[\\/]+/).filter(Boolean).pop() ?? p;
};
