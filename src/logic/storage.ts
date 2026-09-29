// localStorage 持久化与旧数据兼容
import type { LegacyPrice, State } from "./types";
import { project } from "../project";

export const STATE_KEY = project.stateKey;
export const LEGACY_KEY = project.storageKey;

export function loadState(): State | undefined {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.versions)) {
      return parsed as State;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function saveState(state: State): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时静默失败，不影响页面操作
  }
}

/** 读取旧版本数据（迁移前的调价记录） */
export function loadLegacyRecords(): LegacyPrice[] | undefined {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LegacyPrice[]) : undefined;
  } catch {
    return undefined;
  }
}

/** 首次使用时的种子历史数据（项目内置记录） */
export function seedLegacyRecords(): LegacyPrice[] {
  return project.records.map((record, index) => ({
    ...record,
    id: `seed-${index + 1}`,
    createdAt: new Date(Date.now() - index * 86400000).toISOString(),
  }));
}
