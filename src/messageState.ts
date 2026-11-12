import type { KernelEvent, Message, MessageInfo, Part } from "./kernelApi";

export const MESSAGE_EVENTS = new Set([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "message.part.removed",
  "message.removed",
]);

export type SnapshotChanges = {
  dirty: boolean;
  messages: Set<string>;
  parts: Set<string>;
};

export function recordSnapshotEvent(changes: SnapshotChanges, event: KernelEvent) {
  changes.dirty = true;
  const p = event.properties;
  const id = String(p.messageID ?? p.part?.messageID ?? p.info?.id ?? "");
  if (event.type === "message.removed") changes.messages.add(id);
  if (event.type === "message.updated") changes.messages.delete(id);
  if (event.type === "message.part.removed") changes.parts.add(`${id}\0${p.partID}`);
  if (event.type === "message.part.updated") changes.parts.delete(`${id}\0${p.part?.id}`);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => k in y && same(x[k], y[k]));
}

export function applyMessageEvents(messages: Message[], events: KernelEvent[]): Message[] {
  const next = new Map(messages.map((m) => [m.info.id, m]));
  let changed = false;
  for (const { type, properties: p } of events) {
    const id = String(p.messageID ?? p.part?.messageID ?? p.info?.id ?? "");
    if (!id) continue;
    if (type === "message.removed") {
      changed = next.delete(id) || changed;
      continue;
    }
    const old = next.get(id);
    if (!old && type === "message.part.removed") continue;
    const m = old ?? {
      info: { id, sessionID: String(p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID ?? ""), role: "assistant", time: { created: 0 } } as MessageInfo,
      parts: [],
    };
    let updated = m;
    if (type === "message.updated" && p.info) {
      const info = { ...m.info, ...p.info };
      if (p.info.time) info.time = { ...m.info.time, ...p.info.time };
      if (!same(info, m.info)) updated = { ...m, info };
    } else if (type === "message.part.removed") {
      const parts = m.parts.filter((part) => part.id !== p.partID);
      if (parts.length !== m.parts.length) updated = { ...m, parts };
    } else if (type === "message.part.updated" || type === "message.part.delta") {
      const partID = String(p.part?.id ?? p.partID ?? "");
      if (!partID) continue;
      const index = m.parts.findIndex((part) => part.id === partID);
      const previous = m.parts[index];
      let part: Part;
      if (type === "message.part.delta") {
        if (!p.delta || previous?.time?.end) continue;
        const field = String(p.field ?? "text");
        const base = (previous ?? { id: partID, messageID: id, sessionID: m.info.sessionID, type: "text" }) as Record<string, unknown>;
        part = { ...base, [field]: String(base[field] ?? "") + String(p.delta) } as unknown as Part;
      } else {
        part = { ...previous, ...p.part };
        // 初始空壳可能晚于首个增量到达，只有带结束时间的快照才能清空正文。
        if (part.text === "" && previous?.text && !part.time?.end) part.text = previous.text;
      }
      if (!same(previous, part)) {
        const parts = m.parts.slice();
        if (index < 0) parts.push(part);
        else parts[index] = part;
        updated = { ...m, parts };
      }
    }
    if (!old || updated !== old) {
      changed = true;
      next.set(id, updated);
    }
  }
  return changed ? [...next.values()] : messages;
}

function mergeFields<T extends object>(current: T, snapshot: T, baseline: T | undefined): T {
  const merged = { ...snapshot };
  for (const key of Object.keys(current) as (keyof T)[]) {
    if (!baseline || !same(current[key], baseline[key])) merged[key] = current[key];
  }
  return same(current, merged) ? current : merged;
}

export function reconcileMessages(current: Message[], snapshot: Message[], baseline: Message[], changes?: SnapshotChanges): Message[] {
  const now = new Map(current.map((m) => [m.info.id, m]));
  const before = new Map(baseline.map((m) => [m.info.id, m]));
  const result: Message[] = [];
  const seen = new Set<string>();
  for (const snap of snapshot) {
    const id = snap.info.id;
    if (seen.has(id) || changes?.messages.has(id)) continue;
    seen.add(id);
    const cur = now.get(id);
    const base = before.get(id);
    if (!cur) {
      if (!base) {
        const parts = snap.parts.filter((p) => !changes?.parts.has(`${id}\0${p.id}`));
        result.push(parts.length === snap.parts.length ? snap : { ...snap, parts });
      }
      continue;
    }
    const oldParts = new Map(base?.parts.map((p) => [p.id, p]));
    const curParts = new Map(cur.parts.map((p) => [p.id, p]));
    const parts: Part[] = [];
    const partIDs = new Set<string>();
    for (const p of snap.parts) {
      if (partIDs.has(p.id) || changes?.parts.has(`${id}\0${p.id}`)) continue;
      partIDs.add(p.id);
      const live = curParts.get(p.id);
      const old = oldParts.get(p.id);
      if (!live) {
        if (!old) parts.push(p);
      } else {
        parts.push(mergeFields(live, p, old));
      }
    }
    for (const p of cur.parts) {
      if (!partIDs.has(p.id) && !changes?.parts.has(`${id}\0${p.id}`) && p !== oldParts.get(p.id)) parts.push(p);
    }
    const info = cur.info.time.created === 0 ? snap.info : mergeFields(cur.info, snap.info, base?.info);
    result.push(info === cur.info && parts.length === cur.parts.length && parts.every((p, i) => p === cur.parts[i]) ? cur : { info, parts });
  }
  for (const m of current) {
    if (!seen.has(m.info.id) && !changes?.messages.has(m.info.id) && m !== before.get(m.info.id)) result.push(m);
  }
  return result.length === current.length && result.every((m, i) => m === current[i]) ? current : result;
}
