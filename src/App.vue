<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { FUELS, type Fuel, type LedgerAction, type PriceOrder } from "./types";
import { formatTime, startOfToday, toInputValue, uid, usePriceStore } from "./store";

const store = usePriceStore();

type TabKey = "current" | "orders" | "batch" | "timeline" | "ledger" | "legacy" | "migration";
const tab = ref<TabKey>("current");
const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "current", label: "今日有效价" },
  { key: "orders", label: "调价单" },
  { key: "batch", label: "批量提交" },
  { key: "timeline", label: "价格时间轴" },
  { key: "ledger", label: "操作台账" },
  { key: "migration", label: "迁移" },
  { key: "legacy", label: "旧价查询" },
];

const toast = reactive({ show: false, ok: true, text: "" });
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function notify(ok: boolean, text: string) {
  toast.show = true;
  toast.ok = ok;
  toast.text = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.show = false), 4200);
}

/* ---------------- 草稿表单 ---------------- */

function blankForm() {
  return {
    fuel: "92号汽油" as Fuel,
    price: 7.85,
    effectiveAt: toInputValue(startOfToday()),
    operator: "早班窗口",
    note: "",
  };
}
const form = reactive(blankForm());

function submitDraft(ownerTab?: string) {
  if (!form.effectiveAt) return notify(false, "请选择生效时间");
  const owner = ownerTab ?? store.tabId;
  store.createDraft(
    {
      fuel: form.fuel,
      price: Number(form.price),
      effectiveAt: new Date(form.effectiveAt).toISOString(),
      operator: form.operator,
      note: form.note,
    },
    owner
  );
  notify(true, `调价单已保存为草稿（窗口 ${owner.slice(-4)}），时间轴变动后旧草稿会自动失效`);
}

/* ---------------- 调价单操作 ---------------- */

const reshuffleDraft = reactive<Record<string, string>>({});

function approve(order: PriceOrder, ownerTab?: string) {
  const res = store.approveOrder(order.id, ownerTab);
  notify(res.ok, res.message);
}

function reshuffle(order: PriceOrder) {
  const v = reshuffleDraft[order.id];
  if (!v) return notify(false, "请先选择新的生效时间");
  const res = store.reshuffleOrder(order.id, { effectiveAt: new Date(v).toISOString() });
  notify(res.ok, res.message);
  reshuffleDraft[order.id] = "";
}

function removeOrder(order: PriceOrder) {
  store.deleteOrder(order.id);
  notify(true, "草稿已删除");
}

/** 换班冲突演示：窗口B对同一油品同一时刻再报一个价 */
function lateWindowBid() {
  const target = store.orders.find((o) => o.status === "submitted") ?? store.orders[0];
  const at = target ? target.effectiveAt : startOfToday();
  const fuel = target?.fuel ?? "92号汽油";
  const otherTab = uid("tab");
  const order = store.createDraft(
    {
      fuel,
      price: 8.01,
      effectiveAt: at,
      operator: "晚班窗口",
      note: "换班时两个窗口同时提交的未来价",
    },
    otherTab
  );
  const res = store.approveOrder(order.id, otherTab);
  notify(false, `窗口B（${otherTab.slice(-4)}）撞点：${res.message}`);
  tab.value = "orders";
}

/* ---------------- 批量提交 ---------------- */

const selected = ref<Set<string>>(new Set());

function toggleSelect(id: string) {
  if (selected.value.has(id)) selected.value.delete(id);
  else selected.value.add(id);
  selected.value = new Set(selected.value);
}

function createBatch(failFirst = false) {
  const ids = store.orders.filter((o) => o.status !== "applied" && selected.value.has(o.id)).map((o) => o.id);
  if (!ids.length) return notify(false, "请先勾选待提交的调价单");
  const batch = store.stageBatchFromOrders(ids);
  if (!batch) return notify(false, "组批失败");
  selected.value = new Set();
  const res = store.retryBatch(batch.id, failFirst ? [0] : []);
  notify(res.ok, `${failFirst ? "已模拟首条中途失败。" : ""}${res.message}`);
  tab.value = "batch";
}

function retryBatch(batchId: string, failNext = false) {
  const batch = store.batches.find((b) => b.id === batchId);
  if (!batch) return;
  const pendingIdx = batch.items.map((it, i) => (it.status === "pending" ? i : -1)).filter((i) => i >= 0);
  const res = store.retryBatch(batchId, failNext && pendingIdx.length ? [pendingIdx[0]] : []);
  notify(res.ok, res.message);
}

const batchReshuffle = reactive<Record<string, string>>({});
function reshuffleBatchItem(batchId: string, idemKey: string, fuel: string) {
  const key = `${batchId}:${idemKey}`;
  const v = batchReshuffle[key];
  if (!v) return notify(false, `请先为 ${fuel} 选择新的生效时间`);
  const res = store.reshuffleBatchItem(batchId, idemKey, new Date(v).toISOString());
  notify(res.ok, res.message);
  batchReshuffle[key] = "";
}

/* ---------------- 时间轴 / 回滚 ---------------- */

function rollback(version: number) {
  const res = store.rollbackVersion(version, form.operator || "值班员");
  notify(res.ok, res.message);
}

/* ---------------- 台账筛选 ---------------- */

const ledgerCategory = ref<"all" | "draft" | "batch" | "switch" | "migration" | "rollback">("all");
const ledgerFuel = ref<"all" | Fuel>("all");

const CATEGORY_ACTIONS: Record<Exclude<typeof ledgerCategory.value, "all">, LedgerAction[]> = {
  draft: ["draft-create", "draft-apply", "draft-conflict", "draft-stale", "draft-reshuffle", "draft-delete"],
  batch: ["batch-stage", "batch-item-apply", "batch-item-conflict", "batch-item-stale", "batch-item-fail", "batch-reshuffle", "batch-done"],
  switch: ["switch", "switch-catchup"],
  migration: ["migration-start", "migration-item", "migration-pause", "migration-done"],
  rollback: ["rollback"],
};

const ACTION_LABELS: Record<LedgerAction, string> = {
  "draft-create": "建草稿",
  "draft-apply": "批准调价单",
  "draft-conflict": "草稿撞点",
  "draft-stale": "草稿失效",
  "draft-reshuffle": "草稿重排",
  "draft-delete": "删除草稿",
  "batch-stage": "批次暂存",
  "batch-item-apply": "批次生效",
  "batch-item-conflict": "批次撞点",
  "batch-item-stale": "批次失效",
  "batch-item-fail": "批次失败",
  "batch-reshuffle": "批次重排",
  "batch-done": "批次完成",
  switch: "价格切换",
  "switch-catchup": "补切换",
  rollback: "回滚版本",
  "migration-start": "迁移开始",
  "migration-item": "迁移条目",
  "migration-pause": "迁移中断",
  "migration-done": "迁移完成",
};

const filteredLedger = computed(() =>
  [...store.ledger]
    .reverse()
    .filter((e) => ledgerCategory.value === "all" || CATEGORY_ACTIONS[ledgerCategory.value].includes(e.action))
    .filter((e) => ledgerFuel.value === "all" || e.fuel === ledgerFuel.value)
);

/* ---------------- 汇总视图 ---------------- */

const currentPrices = computed(() =>
  FUELS.map((fuel) => {
    const p = store.effectivePrice(fuel);
    return { fuel, price: p?.price, version: p?.version, at: p?.effectiveAt, point: p };
  })
);

const activeDraftCount = computed(() => store.orders.filter((o) => o.status === "submitted").length);
const conflictCount = computed(() => store.orders.filter((o) => o.status === "conflict").length);
const staleCount = computed(() => store.orders.filter((o) => o.status === "stale").length);

const timelineGroups = computed(() =>
  FUELS.map((fuel) => ({
    fuel,
    points: [...(store.timelineByFuel[fuel] ?? [])].sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt)),
  })).filter((g) => g.points.length > 0)
);

const statusMeta: Record<string, { text: string; cls: string }> = {
  submitted: { text: "待批准", cls: "ok" },
  applied: { text: "已批准", cls: "done" },
  stale: { text: "已失效", cls: "muted" },
  conflict: { text: "撞点·待重排", cls: "bad" },
  pending: { text: "待提交", cls: "ok" },
  done: { text: "已生效", cls: "done" },
  scheduled: { text: "待生效", cls: "ok" },
  active: { text: "生效中", cls: "done" },
  expired: { text: "历史价", cls: "muted" },
  revoked: { text: "已回滚", cls: "bad" },
};

/* ---------------- 演示数据 / 生命周期 ---------------- */

const DEMO_V0: Array<{
  id: string;
  fuel: Fuel;
  price: number;
  operator: string;
  effectiveDate: string;
  status: string;
  notes: string;
  createdAt: string;
}> = [
  { id: "old-1", fuel: "92号汽油", price: 7.10, operator: "老站长", effectiveDate: "2026-03-01", status: "生效中", notes: "春季价", createdAt: "2026-02-28T08:00:00.000Z" },
  { id: "old-2", fuel: "92号汽油", price: 7.35, operator: "老站长", effectiveDate: "2026-04-01", status: "生效中", notes: "调价", createdAt: "2026-03-31T08:00:00.000Z" },
  { id: "old-3", fuel: "95号汽油", price: 7.91, operator: "值班经理", effectiveDate: "2026-04-01", status: "已回退", notes: "旧价备查", createdAt: "2026-03-31T09:00:00.000Z" },
  { id: "old-4", fuel: "98号汽油", price: 8.66, operator: "站长", effectiveDate: "2026-05-01", status: "生效中", notes: "五一调价", createdAt: "2026-04-30T08:00:00.000Z" },
  { id: "old-5", fuel: "柴油", price: 6.92, operator: "值班经理", effectiveDate: "2026-05-01", status: "待确认", notes: "批发联动", createdAt: "2026-04-30T10:00:00.000Z" },
  { id: "old-6", fuel: "柴油", price: 7.18, operator: "值班经理", effectiveDate: "2026-06-30", status: "生效中", notes: "同油品同时刻只留一条演示", createdAt: "2026-06-29T09:30:00.000Z" },
];

function resetAndMigrate(opts: { pause?: boolean; lastSeenBefore?: boolean; dataset?: "seed" | "demo" } = {}) {
  localStorage.removeItem("dfwlfront-9-price");
  localStorage.removeItem("dfwlfront-9-price-legacy-v1");
  if (opts.dataset === "demo" || opts.pause) {
    // 预置一批 v0 旧记录，boot 检测到非 schema2 数据后自动迁移
    localStorage.setItem("dfwlfront-9-price", JSON.stringify(DEMO_V0));
  }
  // 重置内部状态后重新走 boot
  store.$patch({
    schema: 2,
    rev: 0,
    timelineVersion: 0,
    points: [],
    orders: [],
    batches: [],
    ledger: [],
    legacyRecords: [],
    migration: { started: false, running: false, paused: false, finished: false, total: 0, cursor: 0 },
    lastSeenAt: opts.lastSeenBefore ? "2026-02-27T23:00:00.000Z" : undefined,
    booted: false,
    catchupCount: 0,
  });
  store.boot();
  if (opts.pause) {
    setTimeout(() => {
      store.pauseMigration();
      notify(false, `迁移已在第 1 条后中断（${store.migration.cursor}/${store.migration.total}），刷新页面即可看到“继续完成”`);
    }, 220);
  }
  notify(true, "已重置：旧数据正在迁移成时间轴最初版本 v1");
  tab.value = "migration";
}

function seedBatchDemo() {
  resetAndMigrate();
  setTimeout(() => {
    const base = "2026-12-01T08:00";
    const fuels: Array<{ fuel: Fuel; price: number }> = [
      { fuel: "92号汽油", price: 7.9 },
      { fuel: "95号汽油", price: 8.4 },
      { fuel: "98号汽油", price: 9.1 },
      { fuel: "柴油", price: 7.3 },
    ];
    const ids: string[] = [];
    fuels.forEach((f, i) => {
      const o = store.createDraft(
        { fuel: f.fuel, price: f.price, effectiveAt: new Date(`${base}`).toISOString(), operator: "夜班窗口", note: `批量调价第 ${i + 1} 条` },
        store.tabId
      );
      ids.push(o.id);
    });
    const batch = store.stageBatchFromOrders(ids)!;
    const res = store.retryBatch(batch.id, [0]); // 首条中途失败
    notify(false, `已生成4条批次并模拟首条失败：${res.message}。点“重试批次”可续办，已成功条目不会重复`);
    tab.value = "batch";
  }, 500);
}

let heartbeat: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  store.boot();
  store.markSeen();
  heartbeat = setInterval(() => store.markSeen(), 10000);
  window.addEventListener("beforeunload", () => store.markSeen());
  // 另一个标签页（第二个换班窗口）写入后，本页同步状态
  window.addEventListener("storage", onStorage);
});

onBeforeUnmount(() => {
  clearInterval(heartbeat);
  window.removeEventListener("storage", onStorage);
});

function onStorage(e: StorageEvent) {
  if (e.key !== "dfwlfront-9-price" || !e.newValue) return;
  try {
    const saved = JSON.parse(e.newValue);
    if (saved?.schema === 2) store.restoreSaved(saved);
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">油站换班 · 调价协同</p>
          <h1>油品价格维护</h1>
          <p class="subtitle">
            调价单、价格时间轴、操作台账三位一体：同一油品同一时刻只留一个有效价；时间轴一变旧草稿失效；
            晚到窗口保留草稿并提示重排；批量提交可重试、重开续办且不重复记账；旧价迁移为时间轴 v1，旧价永久可查；回滚只撤指定版本。
          </p>
        </div>
        <div class="stack">
          <span class="tag">时间轴 v{{ store.timelineVersion }}</span>
          <span class="tag">窗口 {{ store.tabId.slice(-4) }}</span>
          <span class="tag">{{ store.migration.finished ? "迁移完成" : store.migration.running ? "迁移中" : "迁移待用" }}</span>
        </div>
      </header>

      <section v-if="store.catchupCount" class="banner">
        页面重开检测到停用期间错过 <strong>{{ store.catchupCount }}</strong> 次价格切换，已按时间轴补执行，台账可查。
      </section>

      <section class="metrics">
        <article class="metric"><span>今日有效价品种</span><strong>{{ currentPrices.filter((c) => c.price !== undefined).length }}</strong></article>
        <article class="metric"><span>待批准调价单</span><strong>{{ activeDraftCount }}</strong></article>
        <article class="metric"><span>撞点待重排</span><strong :class="{ bad: conflictCount }">{{ conflictCount }}</strong></article>
        <article class="metric"><span>已失效草稿</span><strong>{{ staleCount }}</strong></article>
        <article class="metric"><span>台账事件</span><strong>{{ store.ledger.length }}</strong></article>
        <article class="metric"><span>迁移进度</span><strong>{{ store.migrationProgress.done }}/{{ store.migrationProgress.total }}</strong></article>
      </section>

      <nav class="tabs">
        <button v-for="t in tabs" :key="t.key" type="button" :class="['tab', { active: tab === t.key }]" @click="tab = t.key">
          {{ t.label }}
          <em v-if="t.key === 'orders' && activeDraftCount + conflictCount + staleCount" class="badge">
            {{ activeDraftCount + conflictCount + staleCount }}
          </em>
          <em v-if="t.key === 'batch' && store.pendingBatches.length" class="badge warn">!</em>
        </button>
      </nav>

      <!-- 今日有效价 -->
      <section v-if="tab === 'current'" class="panel">
        <h2>当前有效价 <small>（同一油品此刻只取时间轴上最后一个未撤销的生效点）</small></h2>
        <div class="price-grid">
          <article v-for="c in currentPrices" :key="c.fuel" class="price-card">
            <p class="fuel">{{ c.fuel }}</p>
            <p class="price" v-if="c.price !== undefined">￥{{ c.price.toFixed(2) }}</p>
            <p class="price empty" v-else>暂无有效价</p>
            <p class="meta" v-if="c.at">v{{ c.version }} · {{ formatTime(c.at) }} 起</p>
          </article>
        </div>
      </section>

      <!-- 调价单 -->
      <section v-if="tab === 'orders'" class="panel">
        <h2>调价单（草稿）</h2>
        <form class="form-grid form-row" @submit.prevent="submitDraft()">
          <label>油品
            <select v-model="form.fuel">
              <option v-for="f in FUELS" :key="f" :value="f">{{ f }}</option>
            </select>
          </label>
          <label>挂牌价
            <input v-model.number="form.price" type="number" step="0.01" min="0" required />
          </label>
          <label>生效时刻
            <input v-model="form.effectiveAt" type="datetime-local" required />
          </label>
          <label>操作员
            <input v-model="form.operator" required />
          </label>
          <label class="grow">备注
            <input v-model="form.note" placeholder="换班说明 / 调价依据" />
          </label>
          <button type="submit">保存草稿</button>
          <button type="button" class="secondary" @click="lateWindowBid">模拟换班第二窗口撞点提交</button>
        </form>

        <div class="record-grid">
          <div v-if="store.orders.length === 0" class="empty">暂无调价单</div>
          <article v-for="o in store.orders" :key="o.id" class="record" :class="{ disabled: o.status === 'applied' }">
            <div class="record-head">
              <p class="record-title">{{ o.fuel }} ￥{{ o.price.toFixed(2) }}
                <small>窗口 {{ o.createdBy.slice(-4) }} · 基于 v{{ o.baseVersion }}</small>
              </p>
              <span class="status" :class="statusMeta[o.status].cls">{{ statusMeta[o.status].text }}</span>
            </div>
            <div class="details">
              <span>生效时刻：{{ formatTime(o.effectiveAt) }}</span>
              <span>操作员：{{ o.operator }}</span>
              <span v-if="o.note">备注：{{ o.note }}</span>
              <span v-if="o.conflictReason" class="bad-text">原因：{{ o.conflictReason }}</span>
            </div>
            <div class="inline-reshuffle" v-if="o.status === 'conflict' || o.status === 'stale'">
              <input v-model="reshuffleDraft[o.id]" type="datetime-local" />
              <button type="button" class="secondary" @click="reshuffle(o)">重排到此时刻</button>
            </div>
            <div class="actions">
              <button type="button" :disabled="o.status !== 'submitted'" @click="approve(o)">批准入时间轴</button>
              <button type="button" class="secondary" :disabled="o.status === 'applied'" @click="approve(o, uid('tab'))">
                模拟另一窗口晚到批准
              </button>
              <button type="button" class="danger" :disabled="o.status === 'applied'" @click="removeOrder(o)">删除草稿</button>
            </div>
          </article>
        </div>
      </section>

      <!-- 批量提交 -->
      <section v-if="tab === 'batch'" class="panel">
        <h2>批量提交 <small>（中途失败可重试同一批次；页面重开自动续办；已成功条目幂等，不重复生成记录）</small></h2>

        <div class="record-grid">
          <div v-if="store.orders.some((o) => o.status !== 'applied')" class="batch-compose">
            <p class="section-label">勾选调价单组批：</p>
            <label v-for="o in store.orders.filter((x) => x.status !== 'applied')" :key="o.id" class="check">
              <input type="checkbox" :checked="selected.has(o.id)" @change="toggleSelect(o.id)" />
              {{ o.fuel }} ￥{{ o.price.toFixed(2) }} · {{ formatTime(o.effectiveAt) }}
              <span class="status" :class="statusMeta[o.status].cls">{{ statusMeta[o.status].text }}</span>
            </label>
            <div class="actions">
              <button type="button" @click="createBatch(false)">组批并提交</button>
              <button type="button" class="secondary" @click="createBatch(true)">组批并模拟首条失败</button>
            </div>
          </div>

          <div v-if="store.batches.length === 0" class="empty">暂无批次</div>
          <article v-for="b in store.batches" :key="b.id" class="record batch">
            <div class="record-head">
              <p class="record-title">批次 {{ b.id.slice(-6) }}
                <small>{{ formatTime(b.createdAt) }} · 窗口 {{ b.createdBy.slice(-4) }}</small>
              </p>
              <span class="status" :class="b.done ? 'done' : 'ok'">{{ b.done ? "已收尾" : "未完成（重开自动续办）" }}</span>
            </div>
            <table class="batch-table">
              <thead>
                <tr><th>油品</th><th>价格</th><th>生效时刻</th><th>状态</th><th>尝试</th><th>说明 / 重排</th></tr>
              </thead>
              <tbody>
                <tr v-for="it in b.items" :key="it.idemKey">
                  <td>{{ it.fuel }}</td>
                  <td>￥{{ it.price.toFixed(2) }}</td>
                  <td>{{ formatTime(it.effectiveAt) }}</td>
                  <td><span class="status" :class="statusMeta[it.status].cls">{{ statusMeta[it.status].text }}</span></td>
                  <td>{{ it.attempts }}</td>
                  <td>
                    {{ it.message }}
                    <div class="inline-reshuffle" v-if="it.status === 'conflict'">
                      <input v-model="batchReshuffle[`${b.id}:${it.idemKey}`]" type="datetime-local" />
                      <button type="button" class="secondary" @click="reshuffleBatchItem(b.id, it.idemKey, it.fuel)">重排</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="actions" v-if="!b.done">
              <button type="button" @click="retryBatch(b.id, false)">重试批次（续办，不重复）</button>
              <button type="button" class="secondary" @click="retryBatch(b.id, true)">重试并模拟下一条再失败</button>
            </div>
          </article>
        </div>
      </section>

      <!-- 时间轴 -->
      <section v-if="tab === 'timeline'" class="panel">
        <h2>价格时间轴 <small>（每批准一个价格生成新版本；回滚只撤销指定版本，其后批准的价格不受影响）</small></h2>
        <div class="timeline">
          <div v-for="g in timelineGroups" :key="g.fuel" class="tl-group">
            <h3>{{ g.fuel }}</h3>
            <div v-for="p in g.points" :key="p.id" class="tl-item" :class="p.status">
              <div class="tl-dot" />
              <div class="tl-body">
                <div class="tl-head">
                  <strong>￥{{ p.price.toFixed(2) }}</strong>
                  <span class="status" :class="statusMeta[p.status].cls">{{ statusMeta[p.status].text }}</span>
                  <span class="ver">v{{ p.version }}</span>
                  <span class="src">{{ p.source === "migration" ? "迁移" : p.source === "batch" ? "批次" : "调价单" }}</span>
                </div>
                <p>{{ formatTime(p.effectiveAt) }} 起 · {{ p.operator }}<template v-if="p.note"> · {{ p.note }}</template></p>
                <button v-if="p.status !== 'revoked'" type="button" class="danger tiny" @click="rollback(p.version)">
                  只回滚 v{{ p.version }}
                </button>
              </div>
            </div>
          </div>
          <div v-if="timelineGroups.length === 0" class="empty">时间轴为空</div>
        </div>
      </section>

      <!-- 操作台账 -->
      <section v-if="tab === 'ledger'" class="panel">
        <h2>操作台账 <small>（所有事件按序幂等记录，重试/重放不会出现重复条目）</small></h2>
        <div class="filters">
          <button v-for="c in ['all','draft','batch','switch','migration','rollback']" :key="c"
                  type="button" class="chip" :class="{ active: ledgerCategory === c }"
                  @click="ledgerCategory = c as typeof ledgerCategory.value">
            {{ { all: "全部", draft: "调价单", batch: "批次", switch: "切换/补切换", migration: "迁移", rollback: "回滚" }[c] }}
          </button>
          <select v-model="ledgerFuel">
            <option value="all">全部油品</option>
            <option v-for="f in FUELS" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <table class="ledger-table">
          <thead><tr><th>#</th><th>时间</th><th>动作</th><th>油品</th><th>版本</th><th>窗口</th><th>详情</th></tr></thead>
          <tbody>
            <tr v-for="e in filteredLedger" :key="e.idemKey">
              <td>{{ e.seq }}</td>
              <td>{{ formatTime(e.at) }}</td>
              <td><span class="action-tag">{{ ACTION_LABELS[e.action] }}</span></td>
              <td>{{ e.fuel ?? "—" }}</td>
              <td>{{ e.version ? `v${e.version}` : "—" }}</td>
              <td>{{ e.tabId.slice(-4) }}</td>
              <td>{{ e.detail }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="filteredLedger.length === 0" class="empty">暂无台账记录</div>
      </section>

      <!-- 迁移 -->
      <section v-if="tab === 'migration'" class="panel">
        <h2>旧价迁移</h2>
        <p class="section-label">
          已有旧数据迁移成时间轴最初版本（迁移点标记为 v1 起）。迁移分批落库，中断后刷新页面会从断点继续完成；
          同油品同日期的旧价并入同一生效点，不重复建价。
        </p>
        <div class="progress">
          <div class="progress-track"><div class="progress-fill" :style="{ width: `${store.migrationProgress.percent}%` }" /></div>
          <strong>{{ store.migrationProgress.done }}/{{ store.migrationProgress.total }}（{{ store.migrationProgress.percent }}%）</strong>
        </div>
        <p class="meta-line">
          状态：{{ store.migration.finished ? "已完成" : store.migration.paused ? "已中断（重开继续）" : store.migration.running ? "进行中" : "未开始" }}
          <template v-if="store.migration.startedAt"> · 开始 {{ formatTime(store.migration.startedAt) }}</template>
          <template v-if="store.migration.finishedAt"> · 完成 {{ formatTime(store.migration.finishedAt) }}</template>
        </p>
        <div class="actions">
          <button type="button" :disabled="store.migration.finished || store.migration.running" @click="store.resumeMigration()">继续完成迁移</button>
          <button type="button" class="secondary" :disabled="store.migration.finished" @click="store.pauseMigration()">模拟中断</button>
          <button type="button" class="secondary" @click="resetAndMigrate()">重置：迁移内置旧价（2条）</button>
          <button type="button" class="secondary" @click="resetAndMigrate({ pause: true })">重置：演示迁移中断后续跑（6条）</button>
          <button type="button" class="secondary" @click="resetAndMigrate({ lastSeenBefore: true })">重置：演示重开补切换</button>
          <button type="button" class="secondary" @click="seedBatchDemo()">一键演示：批量失败→重试续办</button>
        </div>
      </section>

      <!-- 旧价查询 -->
      <section v-if="tab === 'legacy'" class="panel">
        <h2>旧价查询 <small>（迁移后旧价照旧可查，只读保留）</small></h2>
        <table class="ledger-table">
          <thead><tr><th>油品</th><th>旧挂牌价</th><th>生效日期</th><th>原状态</th><th>操作员</th><th>备注</th><th>迁移去向</th></tr></thead>
          <tbody>
            <tr v-for="r in store.legacyRecords" :key="r.id">
              <td>{{ r.fuel }}</td>
              <td>￥{{ r.price.toFixed(2) }}</td>
              <td>{{ r.effectiveDate }}</td>
              <td>{{ r.status }}</td>
              <td>{{ r.operator }}</td>
              <td>{{ r.notes }}</td>
              <td>
                <template v-if="r.migrated">已并入时间轴点 {{ r.migratedPointId?.slice(-6) }}</template>
                <template v-else>待迁移</template>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="store.legacyRecords.length === 0" class="empty">暂无旧价数据</div>
      </section>

      <footer class="foot">
        数据保存在浏览器 localStorage（schema v2）；多标签页打开本页即可模拟换班的两个窗口同时提交。
      </footer>
    </div>

    <transition name="fade">
      <div v-if="toast.show" class="toast" :class="toast.ok ? 'ok' : 'bad'">{{ toast.text }}</div>
    </transition>
  </main>
</template>
