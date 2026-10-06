import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：承建单位/治理工程台账重做了关联，旧版示例数据作废，重新播种。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitTables({ [key]: rows })
}

/**
 * 多张表一次性提交：先在内存组好整份数据再写 localStorage，
 * 序列化或落盘抛错时缓存仍是旧值，单位、项目两张表一起保持原状态，不会出现半截写入。
 */
export function commitTables(patch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...patch }
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    // setItem 可能因配额等原因抛错：先序列化成功再写，且只在落盘成功后切换缓存。
    window.localStorage.setItem(STORAGE_KEY, serialized)
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
