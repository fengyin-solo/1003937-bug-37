import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveModules, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  NewEngineeringProject,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 承建单位状态机：只能沿 正常 → 暂停合作 → 资质过期 → 列入黑名单 逐级推进；
// 「恢复正常」是唯一的回退动作，恢复前必须重新校验资质有效期。
const CONTRACT_KEY = 'contract'
const ENGINEERING_KEY = 'engineering'
const CONTRACT_FLOW = ['正常', '暂停合作', '资质过期', '列入黑名单']
const CONTRACT_RESTORE_ACTION = '恢复正常'
const CONTRACT_RESTORE_FROM = ['暂停合作', '资质过期']

// 每个单位状态对应的台账标记：正常单位无待办无异常；暂停、资质过期要跟进；黑名单是终态异常。
const CONTRACT_FLAGS: Record<string, { pending: boolean; abnormal: boolean }> = {
  正常: { pending: false, abnormal: false },
  暂停合作: { pending: true, abnormal: true },
  资质过期: { pending: true, abnormal: true },
  列入黑名单: { pending: false, abnormal: true },
}

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
  const items = key === CONTRACT_KEY ? decorateContractors(matched) : matched
  return { items, total: items.length, page: 1, size: items.length }
}

// 承建单位的「承建项目数」以治理工程台账为准现算，并给出「承接状态」，保证两边台账对得上。
function decorateContractors(rows: EntryRow[]): EntryRow[] {
  const projects = listRows(ENGINEERING_KEY)
  return rows.map((row) => {
    const name = String(row['单位名称'] ?? '')
    const count = projects.filter((project) => String(project['承建方']) === name).length
    return {
      ...row,
      承建项目数: count,
      承接状态: String(row.status) === '正常' ? '可承接' : '不可承接',
    }
  })
}

function todayString(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// 当前状态下可执行的动作：页面只渲染这里返回的按钮，业务判断留在服务层。
export function availableActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  if (key !== CONTRACT_KEY) {
    return meta.actions
  }
  const current = String(row.status)
  return meta.actions.filter((action) => {
    const target = meta.actionTargets[action]
    if (!target || target === current) {
      return false
    }
    if (action === CONTRACT_RESTORE_ACTION) {
      return CONTRACT_RESTORE_FROM.includes(current)
    }
    const targetIndex = CONTRACT_FLOW.indexOf(target)
    return targetIndex > 0 && CONTRACT_FLOW[targetIndex - 1] === current
  })
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  if (key === CONTRACT_KEY) {
    return runContractAction(meta, id, action)
  }
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

function runContractAction(meta: ModuleMeta, id: number, action: string): ActionResult {
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `承建单位没有登记「${action}」这个动作` }
  }
  const rows = listRows(CONTRACT_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的承建单位` }
  }
  const current = String(rows[index].status)
  // 重复暂停/恢复只留首次结果：目标状态已达成的操作直接拒绝，不再写入。
  if (current === target) {
    return { ok: false, message: `承建单位已是「${target}」，重复${action}不生效` }
  }
  if (action === CONTRACT_RESTORE_ACTION) {
    if (!CONTRACT_RESTORE_FROM.includes(current)) {
      return {
        ok: false,
        message: `只有「${CONTRACT_RESTORE_FROM.join('」「')}」的单位能申请恢复，当前状态「${current}」`,
      }
    }
    // 恢复必须重新校验：资质有效期已过的单位不允许恢复合作。
    const expiry = String(rows[index]['资质有效期'] ?? '')
    if (!expiry || expiry < todayString()) {
      return {
        ok: false,
        message: `恢复未通过校验：「${String(rows[index]['单位名称'])}」的资质有效期已过，需先更新资质`,
      }
    }
  } else {
    // 推进动作只能沿 正常 → 暂停合作 → 资质过期 → 列入黑名单 逐级流转。
    const targetIndex = CONTRACT_FLOW.indexOf(target)
    const from = targetIndex > 0 ? CONTRACT_FLOW[targetIndex - 1] : ''
    if (!from || current !== from) {
      return {
        ok: false,
        message: `单位状态只能按 ${CONTRACT_FLOW.join('→')} 流转，不能由「${current}」直接${action}`,
      }
    }
  }
  const flags = CONTRACT_FLAGS[target] ?? { pending: true, abnormal: false }
  const next = [...rows]
  next[index] = { ...rows[index], ...flags, status: target, 单位状态: target }
  try {
    saveRows(CONTRACT_KEY, next)
  } catch {
    return { ok: false, message: '承建单位状态写入失败，已保持原状态' }
  }
  return { ok: true, message: `承建单位已${action}，当前状态「${target}」` }
}

// 登记治理工程项目：状态非「正常」的单位（含黑名单）不能承接新项目；
// 项目行与单位「承建项目数」一起写入，任何一步失败两边都保持原状态，历史项目一律不改。
export function createEngineeringProject(input: NewEngineeringProject): ActionResult {
  const contractorName = input.承建方.trim()
  if (!input.隐患点编号.trim() || !input.治理方案.trim() || !contractorName) {
    return { ok: false, message: '隐患点编号、治理方案、承建方都不能为空' }
  }
  const contractors = listRows(CONTRACT_KEY)
  const contractorIndex = contractors.findIndex((row) => String(row['单位名称']) === contractorName)
  if (contractorIndex < 0) {
    return { ok: false, message: `承建方「${contractorName}」尚未登记，不能关联项目` }
  }
  const contractor = contractors[contractorIndex]
  if (String(contractor.status) !== '正常') {
    return {
      ok: false,
      message: `「${contractorName}」当前状态「${String(contractor.status)}」，不可承接新项目`,
    }
  }
  const projects = listRows(ENGINEERING_KEY)
  const id = projects.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const project: EntryRow = {
    id,
    status: '待立项',
    pending: true,
    abnormal: false,
    项目编号: nextProjectCode(projects),
    隐患点编号: input.隐患点编号.trim(),
    治理方案: input.治理方案.trim(),
    承建方: contractorName,
    合同金额: Number(input.合同金额) || 0,
    开工日期: input.开工日期,
    计划工期: input.计划工期.trim(),
    项目状态: '待立项',
  }
  const undertaken = projects.filter((row) => String(row['承建方']) === contractorName).length
  const nextContractors = [...contractors]
  nextContractors[contractorIndex] = { ...contractor, 承建项目数: undertaken + 1 }
  try {
    saveModules({ [ENGINEERING_KEY]: [...projects, project], [CONTRACT_KEY]: nextContractors })
  } catch {
    return { ok: false, message: '项目登记写入失败，单位与项目均已保持原状态' }
  }
  return { ok: true, message: `项目「${String(project['项目编号'])}」已登记，承建方「${contractorName}」` }
}

function nextProjectCode(rows: EntryRow[]): string {
  const max = rows.reduce((acc, row) => {
    const match = /^ENGI-(\d+)$/.exec(String(row['项目编号'] ?? ''))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `ENGI-${String(max + 1).padStart(4, '0')}`
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  const source = key === CONTRACT_KEY ? decorateContractors(listRows(key)) : listRows(key)
  for (const row of source) {
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
