import type { ActionResult, EntryRow } from './types'

// 承建单位领域：单位状态机、资质重新校验、与治理工程项目的台账关联都收敛在这里。
export const CONTRACT_KEY = 'contract'
export const ENGINEERING_KEY = 'engineering'

// 单位状态只能按这个顺序单向推进：正常 → 暂停合作 → 资质过期 → 黑名单。
export const CONTRACT_STATUSES = ['正常', '暂停合作', '资质过期', '黑名单'] as const

// 动作落到哪个目标状态。
const ACTION_TARGET: Record<string, string> = {
  暂停合作: '暂停合作',
  标记资质过期: '资质过期',
  列入黑名单: '黑名单',
  恢复正常: '正常',
}

// 每个推进动作允许的来源状态：只能逐格往后，不能跳级、不能回退。
const ACTION_SOURCES: Record<string, readonly string[]> = {
  暂停合作: ['正常'],
  标记资质过期: ['暂停合作'],
  列入黑名单: ['资质过期'],
}

const QUALIFICATION_GRADES = new Set(['特级', '一级', '二级', '三级'])
const PHONE_PATTERN = /^1[3-9]\d{9}$/

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function toNumber(value: string | number | boolean | undefined): number {
  if (typeof value === 'number') {
    return value
  }
  return Number(String(value ?? '').trim())
}

/** 只有「正常」单位具备新项目承接资格；暂停、资质过期、黑名单一律不可承接。 */
export function isContractorAvailable(row: EntryRow): boolean {
  return String(row.status) === '正常'
}

/** 恢复前必须重新校验：资质等级合法、联系电话可联、资质仍在有效期内，三项全过才放行。 */
export function requalify(row: EntryRow, now: string = today()): ActionResult {
  const grade = String(row['资质等级'] ?? '').trim()
  if (!QUALIFICATION_GRADES.has(grade)) {
    return { ok: false, message: `资质等级「${grade || '空'}」未通过重新校验，请先续期资质后再恢复` }
  }
  const phone = String(row['联系电话'] ?? '').trim()
  if (!PHONE_PATTERN.test(phone)) {
    return { ok: false, message: '联系人电话失效，未通过重新校验，请先更新联系方式后再恢复' }
  }
  const expireAt = String(row['资质有效期至'] ?? '').trim()
  if (!expireAt || Number.isNaN(Date.parse(expireAt)) || expireAt < now) {
    return { ok: false, message: '资质已过有效期，未通过重新校验，请先续期资质后再恢复' }
  }
  return { ok: true, message: '资质重新校验通过' }
}

export type ContractActionPatch = {
  ok: boolean
  message: string
  row?: EntryRow
}

/**
 * 纯计算：生成单位动作后的新行，不碰存储。
 * - 重复动作（当前已是目标状态）直接拒绝，不覆盖任何字段，只留首次结果；
 * - 推进只能沿状态顺序逐格进行；恢复正常必须先过资质重新校验，不过则保持原状态；
 * - pending/abnormal 由最终状态重新推导，杜绝暂停标记、黑名单可承接标记残留。
 */
export function buildContractAction(row: EntryRow, action: string, now: string = today()): ContractActionPatch {
  const target = ACTION_TARGET[action]
  if (!target) {
    return { ok: false, message: `承建单位没有登记「${action}」这个动作` }
  }
  const current = String(row.status)
  if (current === target) {
    return { ok: false, message: `承建单位已经是「${target}」，只保留首次处理结果，无需重复操作` }
  }
  if (action === '恢复正常') {
    const check = requalify(row, now)
    if (!check.ok) {
      return { ok: false, message: check.message }
    }
  } else {
    const sources = ACTION_SOURCES[action] ?? []
    if (!sources.includes(current)) {
      return {
        ok: false,
        message: `承建单位当前为「${current}」，不能直接${action}；状态只能按 正常 → 暂停合作 → 资质过期 → 黑名单 的顺序推进`,
      }
    }
  }
  const updated: EntryRow = {
    ...row,
    status: target,
    // 黑名单是终态，不再有待办；正常单位没有待办也不算异常。
    pending: target === '暂停合作' || target === '资质过期',
    abnormal: target !== '正常',
  }
  // 首次进入某状态的时间只写一次，重复暂停/恢复都不会覆盖首次结果。
  const firstField = `首次${target}时间`
  if (!updated[firstField]) {
    updated[firstField] = now
  }
  if (target === '正常') {
    updated['最近资质校验'] = now
  }
  return { ok: true, row: updated, message: `承建单位已${action}，当前状态「${target}」` }
}

/** 项目台账按「工程.承建方 = 单位.单位名称」对账。 */
export function projectCountOf(contractorName: string, projects: EntryRow[]): number {
  const name = contractorName.trim()
  if (!name) {
    return 0
  }
  return projects.filter((project) => String(project['承建方'] ?? '').trim() === name).length
}

/** 列表展示用：承建项目数以工程台账实时对账为准，历史项目保留原承建方，不会因状态变化被改写。 */
export function decorateContractor(row: EntryRow, projects: EntryRow[]): EntryRow {
  return {
    ...row,
    承建项目数: projectCountOf(String(row['单位名称'] ?? ''), projects),
    pending: derivePending(row),
    abnormal: deriveAbnormal(row),
  }
}

function derivePending(row: EntryRow): boolean {
  return row.status === '暂停合作' || row.status === '资质过期'
}

function deriveAbnormal(row: EntryRow): boolean {
  return row.status !== '正常'
}

export type CreateProjectInput = {
  隐患点编号: string
  治理方案: string
  承建方: string
  合同金额: string | number
  开工日期: string
  计划工期: string
}

export type CreateProjectDraft = {
  ok: boolean
  message: string
  project?: EntryRow
  engineering: EntryRow[]
  contract: EntryRow[]
}

/**
 * 纯计算：登记治理工程项目并同步承建方台账，返回两张表的完整新数据供一次性原子提交。
 * 黑名单（含暂停、资质过期）单位不能新增项目；任何一项校验不过都返回原数组、不产生半截写入。
 */
export function createEngineeringProject(
  input: CreateProjectInput,
  projects: EntryRow[],
  contractors: EntryRow[],
  now: string = today(),
): CreateProjectDraft {
  const unchanged = { ok: false, message: '', engineering: projects, contract: contractors }

  const hazardCode = input.隐患点编号.trim()
  const scheme = input.治理方案.trim()
  const contractorName = input.承建方.trim()
  const startDate = input.开工日期.trim()
  const duration = input.计划工期.trim()
  if (!hazardCode || !scheme || !contractorName || !startDate || !duration) {
    return { ...unchanged, message: '隐患点编号、治理方案、承建方、开工日期、计划工期均为必填项' }
  }
  const contractorIndex = contractors.findIndex(
    (item) => String(item['单位名称'] ?? '').trim() === contractorName,
  )
  if (contractorIndex < 0) {
    return { ...unchanged, message: `承建单位「${contractorName}」不在承建单位台账中，不能登记项目` }
  }
  const contractor = contractors[contractorIndex]
  if (!isContractorAvailable(contractor)) {
    return {
      ...unchanged,
      message: `承建单位当前为「${contractor.status}」，不能新增项目；其历史项目保留原承建方不做变更`,
    }
  }
  const amount = toNumber(input.合同金额)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ...unchanged, message: '合同金额必须为大于 0 的数字（单位：万元）' }
  }
  if (Number.isNaN(Date.parse(startDate))) {
    return { ...unchanged, message: '开工日期格式不正确' }
  }

  const nextId = projects.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  let seq = nextId
  let code = `ENGI-${String(seq).padStart(4, '0')}`
  // 编号撞号就顺延，保证项目编号唯一。
  while (projects.some((item) => String(item['项目编号']) === code)) {
    seq += 1
    code = `ENGI-${String(seq).padStart(4, '0')}`
  }

  const project: EntryRow = {
    id: nextId,
    status: '待立项',
    pending: true,
    abnormal: false,
    项目编号: code,
    隐患点编号: hazardCode,
    治理方案: scheme,
    // 承建方落单位名称；单位之后即使进黑名单，该字段也不改写，历史项目保留原承建方。
    承建方: contractorName,
    合同金额: amount,
    开工日期: startDate,
    计划工期: duration,
    项目状态: '待立项',
  }

  const nextProjects = [...projects, project]
  // 同步承建方台账上的承建项目数，和工程表一起提交。
  const nextContractors = contractors.map((item, index) =>
    index === contractorIndex
      ? { ...item, 承建项目数: toNumber(item['承建项目数']) + 1 }
      : item,
  )
  return {
    ok: true,
    message: `项目 ${code} 已登记，承建方「${contractorName}」台账已同步`,
    project,
    engineering: nextProjects,
    contract: nextContractors,
  }
}
