<template>
  <section class="page" data-module="contract">
    <header class="page-head">
      <div>
        <h2>承建单位管理</h2>
        <p class="page-desc">维护承建单位，围绕单位编号、单位名称、资质等级、联系人做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记承建单位</button>
        <button class="btn" type="button" @click="exportRows">导出承建单位清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>承接资格</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td><span :class="['status-badge', statusClass(String(row.status))]">{{ row.status }}</span></td>
          <td>
            <span :class="['eligibility-badge', available(row) ? 'is-ok' : 'is-blocked']">
              {{ available(row) ? '可承接' : '不可承接' }}
            </span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-for="action in availableActions(String(row.status))"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无承建单位数据，可先登记承建单位</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条承建单位记录 · 状态只能按 正常 → 暂停合作 → 资质过期 → 黑名单 推进</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="detail" class="modal-mask" @click.self="closeDetail">
      <div class="modal">
        <header class="modal-head">
          <h3>承建单位详情</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ detail[field] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd><span :class="['status-badge', statusClass(String(detail.status))]">{{ detail.status }}</span></dd>
          <dt>承接资格</dt>
          <dd>
            <span :class="['eligibility-badge', available(detail) ? 'is-ok' : 'is-blocked']">
              {{ available(detail) ? '可承接新项目' : '不可承接新项目' }}
            </span>
          </dd>
          <dt v-if="detail['首次暂停合作时间']">首次暂停时间</dt>
          <dd v-if="detail['首次暂停合作时间']">{{ detail['首次暂停合作时间'] }}</dd>
          <dt v-if="detail['首次资质过期时间']">首次资质过期</dt>
          <dd v-if="detail['首次资质过期时间']">{{ detail['首次资质过期时间'] }}</dd>
          <dt v-if="detail['首次黑名单时间']">首次列入黑名单</dt>
          <dd v-if="detail['首次黑名单时间']">{{ detail['首次黑名单时间'] }}</dd>
          <dt v-if="detail['最近资质校验']">最近资质校验</dt>
          <dd v-if="detail['最近资质校验']">{{ detail['最近资质校验'] }}</dd>
        </dl>
        <section class="detail-projects">
          <h4>承建项目台账（{{ detailProjects.length }}）</h4>
          <p v-if="!detailProjects.length" class="page-desc">暂无关联项目。</p>
          <ul v-else>
            <li v-for="project in detailProjects" :key="String(project.id)">
              {{ project['项目编号'] }} · {{ project['治理方案'] }} · {{ project['开工日期'] }} ·
              项目状态「{{ project.status }}」
            </li>
          </ul>
          <p class="page-desc">历史项目始终保留原承建方，单位状态变化不改写项目台账。</p>
        </section>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getContractorDetail,
  listContractors,
  moduleMeta,
  runContractorAction,
} from '@/api/local-service'
import { isContractorAvailable } from '@/data/contract'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('contract')
// 列表不再重复渲染「单位状态」字段：右侧已有独立的当前状态列。
const columns = ["单位编号", "单位名称", "资质等级", "资质有效期至", "联系人", "联系电话", "承建项目数", "注册日期"]
const detailFields = ["单位编号", "单位名称", "资质等级", "资质有效期至", "联系人", "联系电话", "承建项目数", "注册日期"]
const statuses = ["正常", "暂停合作", "资质过期", "黑名单"]

// 每个状态下页面允许发起的动作；非法流转即使绕过按钮也会被服务端拦下。
const STATUS_ACTIONS: Record<string, string[]> = {
  正常: ["暂停合作"],
  暂停合作: ["标记资质过期", "恢复正常"],
  资质过期: ["列入黑名单", "恢复正常"],
  黑名单: ["恢复正常"],
}

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const detail = ref<EntryRow | null>(null)
const detailProjects = ref<EntryRow[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: "单位总数", value: rows.value.length },
  { label: "正常合作数", value: rows.value.filter((row) => String(row.status) === '正常').length },
  { label: "黑名单数", value: rows.value.filter((row) => String(row.status) === '黑名单').length },
])

function availableActions(status: string): string[] {
  return STATUS_ACTIONS[status] ?? []
}

function available(row: EntryRow): boolean {
  return isContractorAvailable(row)
}

function statusClass(status: string): string {
  if (status === '正常') return 'is-normal'
  if (status === '暂停合作') return 'is-paused'
  if (status === '资质过期') return 'is-expired'
  return 'is-blocked'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '承建单位登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = runContractorAction(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  if (detail.value && Number(detail.value.id) === Number(row.id)) {
    openDetail(row)
  }
}

function openDetail(row: EntryRow) {
  errorMessage.value = ''
  const result = getContractorDetail(Number(row.id))
  if (!result.ok || !result.contractor) {
    errorMessage.value = result.message
    return
  }
  detail.value = result.contractor
  detailProjects.value = result.projects ?? []
}

function closeDetail() {
  detail.value = null
  detailProjects.value = []
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listContractors(filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '承建单位列表读取失败'
  }
}

onMounted(reload)
</script>
