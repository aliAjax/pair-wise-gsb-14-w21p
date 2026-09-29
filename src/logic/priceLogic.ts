// 价格时间轴核心逻辑（纯函数，不依赖 Vue / localStorage，便于测试）
//
// 业务规则：
// 1. 同一油品同一时刻只留一个有效价（冲突时晚到的调价单项失败，草稿保留待重排）。
// 2. 时间轴一变，旧草稿失效（baseVersionId 落后于最新版本），草稿保留并提示重排。
// 3. 批量提交幂等：done 项不重复生成价格点；失败项可重试；重开后续跑。
// 4. 历史数据迁移到时间轴 v1，迁移按条记账，中断后续跑不重复迁移。
// 5. 回滚只撤指定版本（该版本价格置为已回滚），后续批准的价格不受影响。
// 6. 重开页面时补上停用期间错过的切换：到期的待生效价格自动生效。

import type {
  AdjustmentOrder,
  LedgerEntry,
  LedgerType,
  LegacyPrice,
  OrderItem,
  PricePoint,
  State,
  TimelineVersion,
} from "./types";

export function createInitialState(): State {
  return {
    schemaVersion: 1,
    versions: [],
    prices: [],
    orders: [],
    ledger: [],
    migration: { status: "idle", total: 0, done: 0 },
    versionCounter: 0,
    orderCounter: 0,
  };
}

export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      /* fall through */
    }
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** 生效日期统一为 YYYY-MM-DD（同一时刻按同一天比较） */
export function normalizeDate(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && value.trim()) {
    const text = value.trim();
    const day = text.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return nowISO().slice(0, 10);
}

export function latestVersion(state: State): TimelineVersion | undefined {
  return state.versions[state.versions.length - 1];
}

export function versionNumberOf(state: State, versionId: string | undefined): number {
  if (!versionId) return 0;
  return state.versions.find((v) => v.id === versionId)?.number ?? 0;
}

function pushLedger(
  state: State,
  type: LedgerType,
  detail: string,
  refType?: LedgerEntry["refType"],
  refId?: string,
  operator?: string
): void {
  state.ledger.push({ id: newId(), at: nowISO(), type, refType, refId, detail, operator });
}

// ---------------------------------------------------------------------------
// 迁移：历史数据 -> 价格时间轴 v1（可中断、可续跑）
// ---------------------------------------------------------------------------

/**
 * 迁移历史价格到时间轴最初版本（v1）。
 * - 已迁移过的记录（legacyId 相同）直接跳过，中断后再跑不重复生成。
 * - 同一油品同一时刻只留一个有效价：重复时刻的价格置为 superseded（旧价仍可查）。
 * - opts.limit 用于模拟迁移中途停止（本次最多处理 limit 条）。
 */
export function migrateLegacy(
  state: State,
  legacy: LegacyPrice[],
  opts: { limit?: number } = {}
): { processed: number; done: boolean } {
  if (state.migration.status === "done") return { processed: 0, done: true };

  if (state.migration.status === "idle") {
    state.migration.status = "running";
    state.migration.total = legacy.length;
    state.migration.done = 0;
    state.migration.startedAt = nowISO();
    pushLedger(state, "migrate_start", `检测到 ${legacy.length} 条历史价格，开始迁移至价格时间轴 v1`);
  } else {
    // 续跑：对账已迁移条数
    state.migration.total = legacy.length;
    state.migration.done = state.prices.filter((p) => p.legacyId !== undefined).length;
  }

  let v1 = state.versions.find((v) => v.number === 1);
  if (!v1) {
    v1 = {
      id: newId(),
      number: 1,
      status: "active",
      createdAt: nowISO(),
      note: "历史数据迁移",
    };
    state.versions.push(v1);
    state.versionCounter = Math.max(state.versionCounter, 1);
  }

  let processed = 0;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  for (const rec of legacy) {
    if (processed >= limit) break;
    const legacyId = rec.id !== undefined && rec.id !== null ? String(rec.id) : undefined;
    if (legacyId !== undefined && state.prices.some((p) => p.legacyId === legacyId)) {
      continue; // 续跑：已迁移，跳过
    }
    const fuel = String(rec.fuel ?? "");
    const price = Number(rec.price ?? 0);
    const effectiveAt = normalizeDate(rec.effectiveDate ?? rec.effectiveAt);
    const operator = String(rec.operator ?? "系统");

    const duplicated = state.prices.some(
      (p) =>
        p.fuel === fuel &&
        p.effectiveAt === effectiveAt &&
        p.status !== "rolled_back" &&
        p.status !== "superseded"
    );

    const point: PricePoint = {
      id: newId(),
      fuel,
      price,
      effectiveAt,
      status: duplicated ? "superseded" : effectiveAt <= nowISO().slice(0, 10) ? "active" : "scheduled",
      orderId: "",
      versionId: v1.id,
      legacyId,
      operator,
      createdAt: nowISO(),
    };
    state.prices.push(point);
    state.migration.done += 1;
    processed += 1;
    pushLedger(
      state,
      "migrate",
      `迁移历史价格：${fuel} 挂牌价 ${price} 元（${effectiveAt}）`,
      "price",
      point.id,
      operator
    );
  }

  const migratedCount = state.prices.filter((p) => p.legacyId !== undefined).length;
  if (legacy.length > 0 && migratedCount >= legacy.length) {
    state.migration.status = "done";
    state.migration.done = migratedCount;
    state.migration.finishedAt = nowISO();
    pushLedger(state, "migrate_done", `历史价格迁移完成，共 ${migratedCount} 条，旧价可随时查询`);
  } else if (legacy.length === 0) {
    state.migration.status = "done";
    state.migration.done = 0;
    state.migration.finishedAt = nowISO();
    pushLedger(state, "migrate_done", "无历史价格需要迁移，时间轴 v1 已建立");
  } else {
    state.migration.done = migratedCount;
  }
  return { processed, done: state.migration.status === "done" };
}

// ---------------------------------------------------------------------------
// 调价单（批量提交单元）
// ---------------------------------------------------------------------------

export interface CreateOrderInput {
  operator: string;
  note?: string;
  items: Array<{ fuel: string; price: number | string; effectiveAt: string }>;
}

export function createOrder(state: State, input: CreateOrderInput): AdjustmentOrder {
  const items = input.items.filter((it) => it.fuel && it.effectiveAt);
  if (items.length === 0) {
    throw new Error("请至少填写一条油品调价项（油品、价格、生效日期）");
  }
  const base = latestVersion(state);
  const order: AdjustmentOrder = {
    id: newId(),
    batchNo: `TJ-${String(++state.orderCounter).padStart(4, "0")}`,
    operator: String(input.operator || "值班员"),
    note: String(input.note || ""),
    status: "draft",
    items: items.map((it): OrderItem => ({
      id: newId(),
      fuel: String(it.fuel),
      price: Number(it.price || 0),
      effectiveAt: normalizeDate(it.effectiveAt),
      status: "pending",
    })),
    baseVersionId: base?.id ?? "",
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  state.orders.unshift(order);
  pushLedger(
    state,
    "order_create",
    `创建调价单 ${order.batchNo}，${order.items.length} 项，基于时间轴 v${base?.number ?? 1}`,
    "order",
    order.id,
    order.operator
  );
  return order;
}

export interface SubmitResult {
  ok: boolean;
  /** 时间轴已落后于草稿基线，草稿保留，需重排后再提交 */
  stale?: boolean;
  order: AdjustmentOrder;
  failedItem?: OrderItem;
}

/**
 * 提交调价单（幂等，可续跑）。
 * - 草稿基线落后于最新时间轴：返回 stale，草稿保留，提示重排。
 * - 逐项批准：同油品同生效时刻已有有效价 -> 该项失败，订单 partial/failed，剩余项保持 pending。
 * - 已 done 的项直接跳过，重试不重复生成价格点。
 * - 首次批准时生成新的时间轴版本；同单后续项（含重试）复用该版本。
 */
export function submitOrder(state: State, orderId: string): SubmitResult {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new Error("调价单不存在");

  // 基线比较对象：其他窗口/订单创建的最新版本（本订单自己批准生成的版本不算“时间轴被别人改动”，
  // 否则批量部分成功后重试会被自己刚创建的版本误判为旧草稿）
  const foreignLatest = [...state.versions].reverse().find((v) => v.orderId !== order.id);
  if (order.baseVersionId !== (foreignLatest?.id ?? "")) {
    order.status = "draft";
    order.updatedAt = nowISO();
    pushLedger(
      state,
      "stale",
      `调价单 ${order.batchNo} 基于旧时间轴（v${versionNumberOf(state, order.baseVersionId)}），草稿已保留，请重排后再提交`,
      "order",
      order.id,
      order.operator
    );
    return { ok: false, stale: true, order };
  }

  order.status = "submitting";
  order.updatedAt = nowISO();
  let version = order.versionId ? state.versions.find((v) => v.id === order.versionId) : undefined;
  let approved = order.items.filter((i) => i.status === "done").length;

  for (const item of order.items) {
    if (item.status === "done") continue; // 幂等：已生效项不重复生成
    if (item.status === "failed") {
      item.status = "pending";
      item.error = undefined;
    }

    // 同一油品同一时刻只留一个有效价（排除本项自己，覆盖跨窗口与同单重复）
    const conflict = state.prices.find(
      (p) =>
        p.fuel === item.fuel &&
        p.effectiveAt === item.effectiveAt &&
        p.id !== item.priceId &&
        p.status !== "rolled_back" &&
        p.status !== "superseded"
    );
    if (conflict) {
      item.status = "failed";
      item.error = `该时刻已有有效价（${conflict.operator} 已提交 ${conflict.price} 元），请重排生效时间`;
      order.status = approved > 0 ? "partial" : "failed";
      order.updatedAt = nowISO();
      pushLedger(
        state,
        "conflict",
        `调价单 ${order.batchNo} ${item.fuel} ${item.effectiveAt} 提交失败：该时刻已有有效价，草稿保留待重排`,
        "order",
        order.id,
        order.operator
      );
      return { ok: false, order, failedItem: item }; // 中途失败，剩余项保持 pending
    }

    if (!version) {
      version = {
        id: newId(),
        number: ++state.versionCounter,
        status: "active",
        createdAt: nowISO(),
        orderId: order.id,
        note: order.note || undefined,
      };
      state.versions.push(version);
      order.versionId = version.id;
    }

    const point: PricePoint = {
      id: newId(),
      fuel: item.fuel,
      price: item.price,
      effectiveAt: item.effectiveAt,
      status: item.effectiveAt <= nowISO().slice(0, 10) ? "active" : "scheduled",
      orderId: order.id,
      versionId: version.id,
      operator: order.operator,
      createdAt: nowISO(),
    };
    state.prices.push(point);
    item.status = "done";
    item.priceId = point.id;
    approved += 1;
    pushLedger(
      state,
      "approve",
      `批准 ${item.fuel} 挂牌价 ${item.price} 元（${item.effectiveAt}）→ 时间轴 v${version.number}`,
      "price",
      point.id,
      order.operator
    );
  }

  order.status = "approved";
  order.updatedAt = nowISO();
  pushLedger(state, "submit", `调价单 ${order.batchNo} 提交完成，共 ${approved} 项价格生效`, "order", order.id, order.operator);
  return { ok: true, order };
}

/**
 * 重排：把调价单基线更新到最新时间轴。
 * - 与新时间轴冲突的项标记 failed（提示重排生效日期）。
 * - 其余未完成项恢复 pending，可继续提交。
 * - 已完成项不动。
 */
export function rebaseOrder(state: State, orderId: string): { ok: boolean; order: AdjustmentOrder } {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new Error("调价单不存在");

  const base = latestVersion(state);
  order.baseVersionId = base?.id ?? "";
  for (const item of order.items) {
    if (item.status === "done") continue;
    const conflict = state.prices.some(
      (p) =>
        p.fuel === item.fuel &&
        p.effectiveAt === item.effectiveAt &&
        p.status !== "rolled_back" &&
        p.status !== "superseded"
    );
    if (conflict) {
      item.status = "failed";
      item.error = "时间轴已更新，该时刻已有有效价，请重排生效日期";
    } else {
      item.status = "pending";
      item.error = undefined;
    }
  }
  order.updatedAt = nowISO();
  pushLedger(
    state,
    "rebase",
    `调价单 ${order.batchNo} 已重排至最新时间轴 v${base?.number ?? 1}`,
    "order",
    order.id,
    order.operator
  );
  return { ok: true, order };
}

// ---------------------------------------------------------------------------
// 回滚：只撤指定版本，后续批准的价格不受影响
// ---------------------------------------------------------------------------

export function rollbackVersion(state: State, versionId: string): { ok: boolean; version: TimelineVersion } {
  const version = state.versions.find((v) => v.id === versionId);
  if (!version) throw new Error("时间轴版本不存在");
  if (version.status === "rolled_back") return { ok: false, version };

  version.status = "rolled_back";
  for (const point of state.prices) {
    if (point.versionId === versionId && (point.status === "active" || point.status === "scheduled")) {
      point.status = "rolled_back";
    }
  }
  pushLedger(state, "rollback", `回滚时间轴 v${version.number}：仅撤销该版本价格，后续批准的价格不受影响`, "version", version.id);
  return { ok: true, version };
}

// ---------------------------------------------------------------------------
// 重开页面：补上停用期间错过的切换（到期的待生效价格自动生效）
// ---------------------------------------------------------------------------

export function catchUp(state: State): number {
  const today = nowISO().slice(0, 10);
  let count = 0;
  for (const point of state.prices) {
    if (point.status === "scheduled" && point.effectiveAt <= today) {
      point.status = "active";
      count += 1;
      pushLedger(
        state,
        "catchup",
        `补上切换：${point.fuel} ${point.price} 元（${point.effectiveAt}）已到期生效`,
        "price",
        point.id,
        point.operator
      );
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// 查询：某油品在某时刻的有效价（旧价照旧可查：回滚/失效版本外的最近一笔）
// ---------------------------------------------------------------------------

export function queryPrice(state: State, fuel: string, at: string): PricePoint | undefined {
  const day = normalizeDate(at);
  const candidates = state.prices.filter(
    (p) =>
      p.fuel === fuel &&
      p.effectiveAt <= day &&
      p.status !== "rolled_back" &&
      p.status !== "superseded"
  );
  candidates.sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : 0));
  return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

export function isOrderStale(state: State, order: AdjustmentOrder): boolean {
  const base = latestVersion(state);
  return order.baseVersionId !== (base?.id ?? "");
}

export function staleOrders(state: State): AdjustmentOrder[] {
  return state.orders.filter((o) => o.status !== "approved" && isOrderStale(state, o));
}

export function getVersion(state: State, versionId: string | undefined): TimelineVersion | undefined {
  return state.versions.find((v) => v.id === versionId);
}
