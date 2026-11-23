import type { BashMode, ModelRef } from "./kernelApi";

/** 本机 OCR：后台无感识别截图里的文字/代码 */
export type OcrState = {
  state: "pending" | "done" | "empty" | "error";
  text?: string;
  error?: string;
};

/** 粘贴进输入框的图片：本地无感通过系统原生 OCR 提取文字 */
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  url: string;
  size: number;
  ocr?: OcrState;
};

/** 排队待发送的轮次：上一轮收尾后自动发 */
export type QueuedPrompt = {
  id: string;
  raw: string;
  imgs: Attachment[];
  model: ModelRef | null;
  agent: string | null;
  target: string;
};

export type Policy = {
  id: string;
  label: string;
  hint: string;
  mode: BashMode;
  /** "*" 表示全部放行，其余是在内核默认之上额外自动允许的权限 */
  extra: string[];
};

export type MenuItem = {
  label: string;
  danger?: boolean;
  run: () => void;
};

export type Menu = {
  x: number;
  y: number;
  items: MenuItem[];
};

/** 截图通常只有几百 KB；给个上限，别让整段 base64 把输入区撑爆 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 4;
export const DEFAULT_TITLES = new Set(["", "新会话", "New session", "Untitled", "untitled"]);

export function imageTitle(raw: string, images: number): string {
  const first = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
  const compact = first.replace(/\s+/g, " ");
  if (compact) return compact.length > 40 ? `${compact.slice(0, 40)}…` : compact;
  return images > 1 ? `图片会话（${images} 张）` : "图片会话";
}

export const imgSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function ocrLabel(ocr?: OcrState): string {
  if (!ocr || ocr.state === "pending") return "识别中";
  if (ocr.state === "done") return `文字 ${ocr.text?.length ?? 0}`;
  if (ocr.state === "empty") return "无文字";
  return "OCR 失败";
}

export function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (!url.startsWith("data:")) {
        reject(new Error("读取图片失败"));
        return;
      }
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || `粘贴图片-${Date.now()}.${file.type.split("/")[1] || "png"}`,
        mime: file.type || "image/png",
        url,
        size: file.size,
        ocr: { state: "pending" },
      });
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}
