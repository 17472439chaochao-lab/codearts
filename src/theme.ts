import { useSyncExternalStore } from "react";

/**
 * 主题：light / dark / system。
 * 样式表里的颜色都走 CSS 变量（见 App.css 顶部的 `--c-*` 表），切主题只改
 * `<html data-theme>` 上的取值，不重挂任何组件；shiki 的高亮主题跟着这个值走。
 */
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const KEY = "codearts.theme";
const listeners = new Set<() => void>();
const media = window.matchMedia("(prefers-color-scheme: dark)");

function readMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // 隐私模式读不到 localStorage 就按系统走
  }
  return "system";
}

let mode: ThemeMode = readMode();

function resolve(m: ThemeMode): ResolvedTheme {
  if (m === "system") return media.matches ? "dark" : "light";
  return m;
}

let current: ResolvedTheme = resolve(mode);

function notify() {
  for (const fn of listeners) fn();
}

/** 把主题写到 DOM 上：`data-theme` 给 CSS 用，`color-scheme` 让原生控件（滚动条、输入框）一起变 */
function apply() {
  const next = resolve(mode);
  const root = document.documentElement;
  root.dataset.theme = next;
  root.style.colorScheme = next;
  if (next !== current) {
    current = next;
    notify();
  }
}

export function setThemeMode(next: ThemeMode) {
  mode = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 存不下也不影响这次切换
  }
  apply();
  notify();
}

export function getThemeMode(): ThemeMode {
  return mode;
}

export function getResolvedTheme(): ResolvedTheme {
  return current;
}

/** 主题变了要重算的东西（比如代码高亮）用这个订阅 */
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, getThemeMode, getThemeMode);
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, getResolvedTheme);
}

// 系统偏好变化：只有跟着系统走时才需要重画
media.addEventListener("change", () => {
  if (mode === "system") apply();
});

// 首帧之前就把 data-theme 挂上，避免深色下先闪一下白底
apply();
