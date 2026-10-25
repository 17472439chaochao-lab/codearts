import { useSyncExternalStore } from "react";

/**
 * 会话完成通知的偏好。
 *
 * 这几项只决定「要不要弹、什么时候弹」，内核完全不需要知道，所以和主题一样
 * 存在 localStorage，没有塞进 Rust 那边的 Settings 文件；改完立刻生效，不用重启。
 */
export type NotifyPrefs = {
  /** 总开关：关掉之后一条都不弹 */
  enabled: boolean;
  /** 只在窗口不在前台时提醒。正盯着这个会话时弹窗是噪音 */
  onlyWhenAway: boolean;
  /** 子任务（task 派生出来的独立会话）跑完也提醒 */
  subagents: boolean;
  /** 声音提醒 */
  sound: boolean;
};

const KEY = "codearts.notify";

const DEFAULTS: NotifyPrefs = {
  enabled: true,
  onlyWhenAway: true,
  subagents: false,
  sound: false,
};

const listeners = new Set<() => void>();

function pick(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function read(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Partial<NotifyPrefs>;
      return {
        enabled: pick(obj.enabled, DEFAULTS.enabled),
        onlyWhenAway: pick(obj.onlyWhenAway, DEFAULTS.onlyWhenAway),
        subagents: pick(obj.subagents, DEFAULTS.subagents),
        sound: pick(obj.sound, DEFAULTS.sound),
      };
    }
  } catch {
    // 隐私模式读不到、或者存进去的是旧的脏数据：按默认走，不拦主流程
  }
  return DEFAULTS;
}

let prefs: NotifyPrefs = read();

function emit() {
  for (const fn of listeners) fn();
}

export function getNotifyPrefs(): NotifyPrefs {
  return prefs;
}

export function setNotifyPrefs(patch: Partial<NotifyPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // 存不下也不影响这次改动
  }
  emit();
}

/** 订阅要拿到稳定引用，useSyncExternalStore 才会在真的改了之后重渲染 */
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useNotifyPrefs(): NotifyPrefs {
  return useSyncExternalStore(subscribe, getNotifyPrefs, getNotifyPrefs);
}
