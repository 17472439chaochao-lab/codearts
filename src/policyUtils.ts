import type { BashMode, PermRule } from "./kernelApi";
import type { Policy } from "./chatTypes";

export const ALWAYS_ALLOWED = ["websearch", "external_directory_read"];

export const POLICIES: Policy[] = [
  {
    id: "ask",
    label: "每次询问",
    hint: "执行命令、改文件、访问网络前逐项确认",
    mode: "always_ask",
    extra: [],
  },
  {
    id: "auto",
    label: "自动审批",
    hint: "工作区内改文件直接放行；命令走内核沙箱，只在检测到风险时询问",
    mode: "sandbox",
    extra: ["edit", "write"],
  },
  {
    id: "full",
    label: "完全访问",
    hint: "不再询问，可自由访问文件、终端和网络",
    mode: "always_allow",
    extra: ["*"],
  },
];

export const allowedSet = (p: Policy, rules: PermRule[]): Set<string> =>
  new Set(p.extra.includes("*") ? rules.map((r) => r.permission) : [...ALWAYS_ALLOWED, ...p.extra]);

export function matchPolicy(rules: PermRule[] | null, mode: BashMode | null): string {
  if (!rules || !mode) return "custom";
  const live = rules.filter((r) => r.action !== "deny");
  for (const p of POLICIES) {
    const allow = allowedSet(p, rules);
    if (
      p.mode === mode &&
      live.every((r) => r.action === (allow.has(r.permission) ? "allow" : "ask"))
    )
      return p.id;
  }
  return "custom";
}
