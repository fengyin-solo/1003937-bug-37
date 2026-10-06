<template>
  <section class="page" data-module="engineering">
    <header class="page-head">
      <div>
        <h2>治理工程管理</h2>
        <p class="page-desc">维护治理工程项目，围绕项目编号、隐患点编号、治理方案、承建方做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记治理工程项目</button>
        <button class="btn" type="button" @click="exportRows">导出治理工程清单</button>
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

    <form v-if="showCreate" class="create-panel" @submit.prevent="submitCreate">
      <label class="filter-item">
        <span>隐患点编号</span>
        <input v-model="createForm.隐患点编号" placeholder="如 HAZA-0004" required />
      </label>
      <label class="filter-item">
        <span>治理方案</span>
        <input v-model="createForm.治理方案" placeholder="如 抗滑桩+截排水" required />
      </label>
      <label class="filter-item">
        <span>承建方</span>
        <select v-model="createForm.承建方" required>
          <option value="" disabled>请选择承建单位</option>
          <option
            v-for="item in contractorOptions"
            :key="String(item.id)"
            :value="String(item.单位名称)"
            :disabled="item.承接状态 !== '可承接'"
          >
            {{ item.单位名称 }}（{{ item.承接状态 }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>合同金额（万元）</span>
        <input v-model="createForm.合同金额" type="number" min="0" step="0.01" />
      </label>
      <label class="filter-item">
        <span>开工日期</span>
        <input v-model="createForm.开工日期" type="date" />
      </label>
      <label class="filter-item">
        <span>计划工期</span>
        <input v-model="createForm.计划工期" placeholder="如 180天" />
      </label>
      <button class="btn primary" type="submit">提交登记</button>
      <button class="btn ghost" type="button" @click="showCreate = false">取消</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
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
          <td :colspan="columns.length + 2" class="empty-state">暂无治理工程数据，可先登记治理工程项目</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条治理工程记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createEngineeringProject,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, NewEngineeringProject } from '@/data/types'

const meta = moduleMeta('engineering')
const columns = ["项目编号", "隐患点编号", "治理方案", "承建方", "合同金额", "开工日期", "计划工期", "项目状态"]
const actions = ["启动招标", "开工确认", "申请验收"]
const statuses = ["待立项", "招标中", "施工中", "已竣工", "待验收"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const showCreate = ref(false)
const contractorOptions = ref<EntryRow[]>([])
const emptyForm = (): NewEngineeringProject => ({
  隐患点编号: '',
  治理方案: '',
  承建方: '',
  合同金额: '',
  开工日期: '',
  计划工期: '',
})
const createForm = ref<NewEngineeringProject>(emptyForm())
const stats = computed(() => [
  { label: '项目总数', value: total.value },
  { label: '施工中数', value: rows.value.filter((row) => row.status === '施工中').length },
  { label: '待验收数', value: rows.value.filter((row) => row.status === '待验收').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  showCreate.value = !showCreate.value
  if (showCreate.value) {
    contractorOptions.value = listEntries('contract').items
  }
}

function submitCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = createEngineeringProject(createForm.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  showCreate.value = false
  createForm.value = emptyForm()
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '治理工程列表读取失败'
  }
}

onMounted(reload)
</script>
