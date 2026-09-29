<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { storeToRefs } from "pinia";
import { usePriceStore } from "./store/priceStore";
import { project } from "./project";
import type { AdjustmentOrder, TimelineVersion } from "./logic/types";

const store = usePriceStore();
const { orders, versions, prices, ledger, migration } = storeToRefs(store);

type TabKey = "orders" | "timeline" | "query" | "ledger";
const tab = ref<TabKey>("orders");
const notice = ref<{ type: "ok" | "warn" | "err"; text: string } | null>(null);

const fuels = project.filters.filter((f) => f !== "全部油品");

const tabs = computed<Array<{ key: TabKey; label: string; badge?: number }>>(() => [
  { key: "orders", label: "调价单", badge: store.staleOrders.length || undefined },
  { key: "timeline", label: "价格时间轴" },
  { key: "query", label: "历史价格查询" },
  { key: "ledger", label: "操作台账" },
]);

// 新建调价单草稿（页面内表单草稿，提交后即生成正式调价单）
const form = reactive({
  operator: "站长",
  note: "",
  items: [{ fuel: "", price: 0, effectiveAt: "" }],
});

function addItem() {
  form.items.push({ fuel: "", price: 0, effectiveAt: "" });
}
function removeItem(index: number) {
  if (form.items.length > 1) form.items.splice(index, 1);
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function showNotice(type: "ok" | "warn" | "err", text: string) {
  notice.value = { type, text };
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = null), 8000);
}

onMounted(() => {
  store.init();
  const caught = store.catchUp();
  if (caught > 0) showNotice("ok", `已补上 ${caught} 条停用期间错过的价格切换`);
  if (store.staleOrders.length > 0) {
    showNotice("warn", `有 ${store.staleOrders.length} 份调价单基于旧时间轴，草稿已保留，请重排后再提交`);
  }
});

// ---------------------------------------------------------------------------
// 调价单
// ---------------------------------------------------------------------------

function submitNewOrder() {
  try {
    const order = store.createOrder({
      operator: form.operator,
      note: form.note,
      items: form.items.map((it) => ({ ...it })),
    });
    const result = store.submitOrder(order.id);
    if (result.stale) {
      showNotice("warn", "时间轴已更新，草稿已保留，请重排后再提交");
    } else if (result.ok) {
      showNotice("ok", `调价单 ${order.batchNo} 已提交，价格写入时间轴`);
      form.note = "";
      form.items = [{ fuel: "", price: 0, effectiveAt: "" }];
    } else {
      showNotice("err", `批量提交中断：${result.failedItem?.error ?? "请处理失败项后重试"}`);
    }
  } catch (err) {
    showNotice("err", err instanceof Error ? err.message : "提交失败");
  }
}

function submitOrder(order: AdjustmentOrder) {
  const result = store.submitOrder(order.id);
  if (result.stale) {
    showNotice("warn", `调价单 ${order.batchNo} 基于旧时间轴，草稿已保留，请重排后再提交`);
  } else if (result.ok) {
    showNotice("ok", `调价单 ${order.batchNo} 已完成，无重复记录生成`);
  } else {
    showNotice("err", `批量提交中断：${result.failedItem?.error ?? "请处理失败项后重试"}`);
  }
}

function rebase(order: AdjustmentOrder) {
  store.rebaseOrder(order.id);
  showNotice("ok", `调价单 ${order.batchNo} 已重排至最新时间轴，请确认后重新提交`);
}

function rebaseAll() {
  for (const order of store.staleOrders) store.rebaseOrder(order.id);
  showNotice("ok", "所有旧草稿已重排至最新时间轴，请确认后重新提交");
}

function isStale(order: AdjustmentOrder): boolean {
  return order.baseVersionId !== (store.latestVersion?.id ?? "");
}

// ---------------------------------------------------------------------------
// 时间轴
// ---------------------------------------------------------------------------

const timelineVersions = computed(() => [...versions.value].reverse());
const priceStatusLabel: Record<string, string> = {
  scheduled: "待生效",
  active: "生效中",
  superseded: "已失效",
  rolled_back: "已回退",
};
const versionStatusLabel: Record<string, string> = { active: "生效中", rolled_back: "已回滚" };

function pricesOfVersion(versionId: string) {
  return prices.value.filter((p) => p.versionId === versionId);
}

function rollback(version: TimelineVersion) {
  if (!window.confirm(`确认回滚时间轴 v${version.number}？\n仅撤销该版本价格，后续批准的价格不受影响。`)) return;
  const result = store.rollbackVersion(version.id);
  if (result.ok) showNotice("ok", `已回滚时间轴 v${version.number}，后续版本价格未受影响`);
}

// ---------------------------------------------------------------------------
// 历史价格查询
// ---------------------------------------------------------------------------

const queryFuel = ref(fuels[0] ?? "92号汽油");
const queryDate = ref(new Date().toISOString().slice(0, 10));
const queryResult = computed(() => store.queryPrice(queryFuel.value, queryDate.value));
const fuelHistory = computed(() =>
  prices.value
    .filter((p) => p.fuel === queryFuel.value)
    .slice()
    .sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : 0))
);

// ---------------------------------------------------------------------------
// 台账
// ---------------------------------------------------------------------------

const ledgerEntries = computed(() => [...ledger.value].reverse());
const ledgerTypeLabel: Record<string, string> = {
  migrate_start: "迁移",
  migrate: "迁移",
  migrate_done: "迁移",
  order_create: "建单",
  submit: "提交",
  approve: "批准",
  rollback: "回滚",
  catchup: "补生效",
  conflict: "冲突",
  stale: "失效",
  rebase: "重排",
};

// ---------------------------------------------------------------------------
// 指标
// ---------------------------------------------------------------------------

const metrics = computed(() => [
  orders.value.length,
  prices.value.filter((p) => p.status === "scheduled").length,
  versions.value.length,
]);

const orderStatusLabel: Record<string, string> = {
  draft: "草稿",
  submitting: "提交中",
  approved: "已批准",
  partial: "部分成功",
  failed: "失败",
};
const itemStatusLabel: Record<string, string> = { pending: "待处理", done: "已生效", failed: "失败" };

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">{{ project.industry }}行业前端最小闭环</p>
          <h1>{{ project.title }}</h1>
          <p class="subtitle">{{ project.subtitle }}</p>
        </div>
        <div class="stack">
          <span v-for="item in project.stack" :key="item" class="tag">{{ item }}</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="(label, index) in project.metricLabels" :key="label" class="metric">
          <span>{{ label }}</span>
          <strong>{{ metrics[index] }}</strong>
        </article>
      </section>

      <nav class="tabs">
        <button
          v-for="item in tabs"
          :key="item.key"
          type="button"
          :class="{ active: tab === item.key }"
          @click="tab = item.key"
        >
          {{ item.label }}
          <em v-if="item.badge" class="tab-badge">{{ item.badge }}</em>
        </button>
      </nav>

      <section class="panel main-panel">
        <transition name="fade">
          <div v-if="notice" class="notice" :class="notice.type">{{ notice.text }}</div>
        </transition>

        <!-- 调价单 -->
        <div v-show="tab === 'orders'">
          <div v-if="store.staleOrders.length" class="alert warn">
            有 {{ store.staleOrders.length }} 份调价单基于旧时间轴，草稿已保留，请重排后再提交。
            <button type="button" class="secondary small" @click="rebaseAll">全部重排</button>
          </div>
          <div v-if="migration.status === 'running'" class="alert warn">
            历史价格迁移中断后续跑中（{{ migration.done }} / {{ migration.total }}），旧价照旧可查。
          </div>

          <form class="panel inner" @submit.prevent="submitNewOrder">
            <h2>{{ project.formTitle }}</h2>
            <div class="form-grid">
              <label>
                操作员
                <input v-model="form.operator" required />
              </label>
              <label>
                备注
                <input v-model="form.note" placeholder="选填，如：换班调价" />
              </label>
            </div>

            <div class="items">
              <div v-for="(item, index) in form.items" :key="index" class="item-row">
                <label>
                  油品
                  <select v-model="item.fuel" required>
                    <option value="">请选择</option>
                    <option v-for="fuel in fuels" :key="fuel" :value="fuel">{{ fuel }}</option>
                  </select>
                </label>
                <label>
                  挂牌价（元）
                  <input v-model.number="item.price" type="number" step="0.01" min="0" required />
                </label>
                <label>
                  生效日期
                  <input v-model="item.effectiveAt" type="date" required />
                </label>
                <button type="button" class="danger small" @click="removeItem(index)">删除</button>
              </div>
            </div>

            <div class="actions">
              <button type="button" class="secondary" @click="addItem">添加油品</button>
              <button type="submit">{{ project.primaryAction }}</button>
            </div>
            <p class="hint">提交即生成调价单并写入价格时间轴；同油品同一时刻只留一个有效价。</p>
          </form>

          <h2 class="section-title">调价单列表</h2>
          <div v-if="orders.length === 0" class="empty">暂无调价单</div>
          <article v-for="order in orders" :key="order.id" class="order">
            <div class="order-head">
              <div>
                <strong>{{ order.batchNo }}</strong>
                <span class="muted">{{ order.operator }} · {{ formatTime(order.createdAt) }}</span>
              </div>
              <span class="tag status-tag" :class="order.status">{{ orderStatusLabel[order.status] }}</span>
            </div>
            <div v-if="order.note" class="order-note">{{ order.note }}</div>
            <div class="order-items">
              <div v-for="item in order.items" :key="item.id" class="order-item">
                <span class="item-fuel">{{ item.fuel }}</span>
                <span>{{ item.price }} 元</span>
                <span>{{ item.effectiveAt }}</span>
                <span class="tag status-tag" :class="item.status">{{ itemStatusLabel[item.status] }}</span>
                <span v-if="item.error" class="error-msg">{{ item.error }}</span>
              </div>
            </div>
            <div class="actions">
              <button v-if="order.status !== 'approved'" type="button" @click="submitOrder(order)">
                {{ order.status === 'draft' ? '提交' : '继续提交' }}
              </button>
              <button v-if="isStale(order)" type="button" class="secondary" @click="rebase(order)">重排</button>
            </div>
          </article>
        </div>

        <!-- 价格时间轴 -->
        <div v-show="tab === 'timeline'">
          <h2 class="section-title">价格时间轴（最新版本在前）</h2>
          <div v-if="timelineVersions.length === 0" class="empty">暂无时间轴版本</div>
          <article v-for="version in timelineVersions" :key="version.id" class="version">
            <div class="version-head">
              <div>
                <strong>时间轴 v{{ version.number }}</strong>
                <span class="muted">{{ formatTime(version.createdAt) }}</span>
              </div>
              <span class="tag status-tag" :class="version.status">{{ versionStatusLabel[version.status] }}</span>
            </div>
            <div v-if="version.note" class="order-note">{{ version.note }}</div>
            <div class="price-rows">
              <div v-for="price in pricesOfVersion(version.id)" :key="price.id" class="price-row">
                <span class="item-fuel">{{ price.fuel }}</span>
                <span>{{ price.price }} 元</span>
                <span>{{ price.effectiveAt }}</span>
                <span class="tag status-tag" :class="price.status">{{ priceStatusLabel[price.status] }}</span>
              </div>
              <div v-if="pricesOfVersion(version.id).length === 0" class="muted small">本版本无价格</div>
            </div>
            <div class="actions">
              <button
                v-if="version.status === 'active'"
                type="button"
                class="danger"
                @click="rollback(version)"
              >
                回滚本版本
              </button>
            </div>
          </article>
        </div>

        <!-- 历史价格查询 -->
        <div v-show="tab === 'query'">
          <h2 class="section-title">历史价格查询（旧价照旧可查）</h2>
          <div class="query-bar">
            <label>
              油品
              <select v-model="queryFuel">
                <option v-for="fuel in fuels" :key="fuel" :value="fuel">{{ fuel }}</option>
              </select>
            </label>
            <label>
              查询时刻
              <input v-model="queryDate" type="date" />
            </label>
          </div>

          <div class="query-result">
            <template v-if="queryResult">
              <span class="muted">{{ queryFuel }} 在 {{ queryDate }} 的有效价为</span>
              <strong>{{ queryResult.price }} 元</strong>
              <span class="tag status-tag" :class="queryResult.status">{{ priceStatusLabel[queryResult.status] }}</span>
            </template>
            <template v-else>
              <span class="muted">{{ queryFuel }} 在 {{ queryDate }} 暂无有效价格记录</span>
            </template>
          </div>

          <h3 class="section-title small">该油品全部价格记录</h3>
          <div v-if="fuelHistory.length === 0" class="empty">暂无价格记录</div>
          <div class="price-rows">
            <div v-for="price in fuelHistory" :key="price.id" class="price-row">
              <span class="item-fuel">{{ price.fuel }}</span>
              <span>{{ price.price }} 元</span>
              <span>{{ price.effectiveAt }}</span>
              <span class="tag status-tag" :class="price.status">{{ priceStatusLabel[price.status] }}</span>
            </div>
          </div>
        </div>

        <!-- 操作台账 -->
        <div v-show="tab === 'ledger'">
          <h2 class="section-title">操作台账（最新在前）</h2>
          <div v-if="ledgerEntries.length === 0" class="empty">暂无台账记录</div>
          <div class="ledger">
            <div v-for="entry in ledgerEntries" :key="entry.id" class="ledger-item">
              <span class="tag ledger-type" :class="entry.type">{{ ledgerTypeLabel[entry.type] ?? entry.type }}</span>
              <span class="ledger-detail">{{ entry.detail }}</span>
              <span class="muted small">{{ entry.operator ? `${entry.operator} · ` : "" }}{{ formatTime(entry.at) }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>
