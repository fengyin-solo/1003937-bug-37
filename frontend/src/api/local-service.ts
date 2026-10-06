import { MODULE_BY_KEY } from '@/data/modules'
import { commitTables, allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  CONTRACT_KEY,
  ENGINEERING_KEY,
  buildContractAction,
  createEngineeringProject,
  decorateContractor,
  isContractorAvailable,
} from '@/data/contract'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 有状态流转图的模块只允许沿图推进（恢复类动作不在图上，由领域分支单独处理）。
  const transitions = meta.transitions
  if (transitions && !transitions[current]?.includes(target)) {
    return {
      ok: false,
      message: `${meta.entity}当前为「${current}」，不能直接流转到「${target}」，请按允许的状态顺序操作`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 承建单位列表：承建项目数等台账字段实时与治理工程对账。 */
export function listContractors(filters: Record<string, string> = {}): PageResult {
  const projects = listRows(ENGINEERING_KEY)
  const decorated = listRows(CONTRACT_KEY).map((row) => decorateContractor(row, projects))
  const matched = filterRows(decorated, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 承建单位详情：基础信息、承接资格与在台账中的历史项目一并返回。 */
export function getContractorDetail(id: number): {
  ok: boolean
  message: string
  contractor?: EntryRow
  projects?: EntryRow[]
} {
  const projects = listRows(ENGINEERING_KEY)
  const row = listRows(CONTRACT_KEY)
    .map((item) => decorateContractor(item, projects))
    .find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的承建单位` }
  }
  const name = String(row['单位名称'] ?? '')
  return {
    ok: true,
    message: '',
    contractor: row,
    projects: projects.filter((project) => String(project['承建方'] ?? '').trim() === name.trim()),
  }
}

/** 承建单位动作：状态顺序、资质重新校验、重复操作去重都由领域逻辑把关。 */
export function runContractorAction(id: number, action: string): ActionResult {
  const rows = listRows(CONTRACT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的承建单位` }
  }
  const patch = buildContractAction(rows[index], action)
  if (!patch.ok || !patch.row) {
    return { ok: false, message: patch.message }
  }
  const next = [...rows]
  next[index] = patch.row
  saveRows(CONTRACT_KEY, next)
  return { ok: true, message: patch.message }
}

/** 登记治理工程项目：黑名单等非正常单位禁止新增，项目表与单位台账跨表原子提交。 */
export function createProject(input: Parameters<typeof createEngineeringProject>[0]): ActionResult {
  const draft = createEngineeringProject(input, listRows(ENGINEERING_KEY), listRows(CONTRACT_KEY))
  if (!draft.ok) {
    return { ok: false, message: draft.message }
  }
  try {
    commitTables({ [ENGINEERING_KEY]: draft.engineering, [CONTRACT_KEY]: draft.contract })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `项目登记写入失败：${error.message}，已保持原状态` : '项目登记写入失败，已保持原状态',
    }
  }
  return { ok: true, message: draft.message }
}

/** 工程登记页的承建方选项：只暴露状态、不允许页面向黑名单单位落项目（服务端另有拦截兜底）。 */
export function contractorOptions(): EntryRow[] {
  return listContractors().items.filter(isContractorAvailable)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
