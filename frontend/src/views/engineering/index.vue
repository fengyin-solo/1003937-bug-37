<template>
  <section class="page" data-module="engineering">
    <header class="page-head">
      <div>
        <h2>治理工程管理</h2>
        <p class="page-desc">维护治理工程项目，围绕项目编号、隐患点编号、治理方案、承建方做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreateModal">登记治理工程项目</button>
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
    </footer>

    <div v-if="showCreate" class="modal-mask" @click.self="closeCreateModal">
      <form class="modal" @submit.prevent="submitCreate">
        <header class="modal-head">
          <h3>登记治理工程项目</h3>
          <button class="btn ghost" type="button" @click="closeCreateModal">关闭</button>
        </header>
        <p class="page-desc">项目编号自动生成；只有「正常」状态的承建单位可承接新项目。</p>
        <div class="form-grid">
          <label class="form-item">
            <span>隐患点编号</span>
            <input v-model="form.隐患点编号" placeholder="例如 YHD-0105" />
          </label>
          <label class="form-item">
            <span>治理方案</span>
            <input v-model="form.治理方案" placeholder="例如 抗滑桩+截排水" />
          </label>
          <label class="form-item">
            <span>承建方</span>
            <select v-model="form.承建方">
              <option value="" disabled>请选择可承接单位</option>
              <option v-for="option in contractorList" :key="String(option.id)" :value="String(option['单位名称'])">
                {{ option['单位名称'] }}（{{ option.status }}）
              </option>
            </select>
          </label>
          <label class="form-item">
            <span>合同金额（万元）</span>
            <input v-model="form.合同金额" type="number" min="0" step="0.01" placeholder="例如 260.5" />
          </label>
          <label class="form-item">
            <span>开工日期</span>
            <input v-model="form.开工日期" type="date" />
          </label>
          <label class="form-item">
            <span>计划工期</span>
            <input v-model="form.计划工期" placeholder="例如 180天" />
          </label>
        </div>
        <p v-if="!contractorList.length" class="error-text">当前没有「正常」状态的承建单位，不能新增项目。</p>
        <footer class="modal-foot">
          <span v-if="formError" class="error-text">{{ formError }}</span>
          <button class="btn primary" type="submit" :disabled="!contractorList.length">提交登记</button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  contractorOptions,
  createProject,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('engineering')
// 列表右侧已有独立状态列，数据列不再重复「项目状态」。
const columns = ["项目编号", "隐患点编号", "治理方案", "承建方", "合同金额", "开工日期", "计划工期"]
const actions = ["启动招标", "开工确认", "申请验收"]
const statuses = ["待立项", "招标中", "施工中", "已竣工", "待验收"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const showCreate = ref(false)
const formError = ref('')
const contractorList = ref<EntryRow[]>([])
const emptyForm = () => ({
  隐患点编号: '',
  治理方案: '',
  承建方: '',
  合同金额: '',
  开工日期: '',
  计划工期: '',
})
const form = ref(emptyForm())

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: "项目总数", value: rows.value.length },
  { label: "施工中数", value: rows.value.filter((row) => String(row.status) === '施工中').length },
  { label: "待验收数", value: rows.value.filter((row) => String(row.status) === '待验收').length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreateModal() {
  formError.value = ''
  // 重新拉取：刚被列入黑名单的单位不会再出现在承接选项里。
  contractorList.value = contractorOptions()
  form.value = emptyForm()
  showCreate.value = true
}

function closeCreateModal() {
  showCreate.value = false
  formError.value = ''
}

function submitCreate() {
  formError.value = ''
  const result = createProject({
    隐患点编号: form.value.隐患点编号,
    治理方案: form.value.治理方案,
    承建方: form.value.承建方,
    合同金额: form.value.合同金额,
    开工日期: form.value.开工日期,
    计划工期: form.value.计划工期,
  })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  closeCreateModal()
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
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
