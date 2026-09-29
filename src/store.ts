import { defineStore } from "pinia";
import type {
  ActionResult,
  BatchItem,
  LegacyRecord,
  LedgerAction,
  LedgerEntry,
  PersistState,
  PriceBatch,
  PriceOrder,
  PricePoint,
} from "./types";

const STORAGE_KEY = "dfwlfront-9-price";
const LEGACY_KEY_LEGACY = "dfwlfront-9-price-legacy-v1"; // 旧价备份，迁移后照旧可查

export function uid(prefix = "id"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** 当天 00:00，本地时区 */
export function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function toDatetimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 旧记录的 effectiveDate（yyyy-MM-dd）当作当天零点 */
function legacyDateToIso(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/* ---------------- 旧数据（v0） ---------------- */

interface V0Record {
  id: string;
  fuel: PricePoint["fuel"];
  price: number;
  operator: string;
  effectiveDate: string;
  status: string;
  notes: string;
  createdAt: string;
}

const SEED_RECORDS: V0Record[] = [
  {
    id: "seed-1",
    fuel: "92号汽油",
    price: 7.62,
    operator: "站长",
    effectiveDate: "2026-06-30",
    status: "生效中",
    notes: "正常调价",
    createdAt: new Date("2026-06-29T08:00:00").toISOString(),
  },
  {
    id: "seed-2",
    fuel: "柴油",
    price: 7.18,
    operator: "值班经理",
    effectiveDate: "2026-06-30",
    status: "待确认",
    notes: "等待复核",
    createdAt: new Date("2026-06-29T09:30:00").toISOString(),
  },
];

function loadV0(): V0Record[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return SEED_RECORDS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as V0Record[];
  } catch {
    /* ignore corrupt v0 */
  }
  return SEED_RECORDS;
}

/* ---------------- Store ---------------- */

export const usePriceStore = defineStore("price", {
  state: (): PersistState & { tabId: string; booted: boolean; catchupCount: number } => ({
    schema: 2,
    rev: 0,
    timelineVersion: 0,
    points: [],
    orders: [],
    batches: [],
    ledger: [],
    legacyRecords: [],
    migration: { started: false, running: false, paused: false, finished: false, total: 0, cursor: 0 },
    lastSeenAt: undefined,
    tabId: uid("tab"),
    booted: false,
    catchupCount: 0,
  }),

  getters: {
    /** 按油品分组、按生效时间排序的时间轴 */
    timelineByFuel(state): Record<string, PricePoint[]> {
      const map: Record<string, PricePoint[]> = {};
      for (const p of state.points) {
        (map[p.fuel] ??= []).push(p);
      }
      for (const fuel of Object.keys(map)) {
        map[fuel].sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.version - b.version);
      }
      return map;
    },

    /** 页面重开（或刷新）期间错过的切换 */
    missedSwitches(state): PricePoint[] {
      if (!state.lastSeenAt) return [];
      const since = state.lastSeenAt;
      const now = nowIso();
      return state.points
        .filter((p) => p.status !== "revoked" && p.effectiveAt > since && p.effectiveAt <= now)
        .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
    },

    pendingBatches(state): PriceBatch[] {
      return state.batches.filter((b) => !b.done);
    },

    migrationProgress(state): { done: number; total: number; percent: number } {
      const done = state.migration.cursor;
      const total = state.migration.total;
      return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
    },
  },

  actions: {
    /* ============ 初始化 / 持久化 ============ */

    persist() {
      this.rev += 1;
      const snapshot: PersistState = {
        schema: 2,
        rev: this.rev,
        timelineVersion: this.timelineVersion,
        points: this.points,
        orders: this.orders,
        batches: this.batches,
        ledger: this.ledger,
        legacyRecords: this.legacyRecords,
        migration: this.migration,
        lastSeenAt: this.lastSeenAt,
      };
      // 旧价单独再留一份只读备份
      localStorage.setItem(LEGACY_KEY_LEGACY, JSON.stringify(this.legacyRecords));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    },

    /**
     * 启动：
     * 1. 已有 v2 数据直接恢复（重开接着办：未完成批次/迁移仍在）；
     * 2. 否则把旧数据搬到时间轴最初版本 v1，迁移可中断后续跑；
     * 3. 补上停用期间错过的价格切换。
     */
    boot() {
      if (this.booted) return;
      this.booted = true;

      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          const saved = JSON.parse(raw) as PersistState;
          if (saved.schema === 2) {
            this.restoreSaved(saved);
            this.runCatchup();
            // 迁移上次中断 → 继续完成
            if (this.migration.started && !this.migration.finished) this.resumeMigration();
            // 批量提交上次中断 → 重试同一批次，不重复生成记录
            for (const batch of this.batches.filter((b) => !b.done)) this.retryBatch(batch.id);
            return;
          }
        } catch {
          /* 落库损坏则按首次进入处理，重新迁移 */
        }
      }

      this.startMigration(loadV0());
    },

    restoreSaved(saved: PersistState) {
      this.schema = 2;
      this.rev = saved.rev ?? 0;
      this.timelineVersion = saved.timelineVersion ?? 0;
      this.points = saved.points ?? [];
      this.orders = saved.orders ?? [];
      this.batches = saved.batches ?? [];
      this.ledger = saved.ledger ?? [];
      this.legacyRecords = saved.legacyRecords ?? [];
      this.migration = saved.migration ?? {
        started: false,
        running: false,
        paused: false,
        finished: false,
        total: 0,
        cursor: 0,
      };
      this.lastSeenAt = saved.lastSeenAt;
      this.refreshPointStatuses(false);
    },

    /** 页面关闭前记录在线时间 */
    markSeen() {
      this.lastSeenAt = nowIso();
      this.persist();
    },

    /* ============ 台账 ============ */

    /** 台账幂等写入：同一 idemKey 只记一次 */
    log(action: LedgerAction, detail: string, extra: Partial<LedgerEntry> = {}): LedgerEntry | undefined {
      const idemKey = extra.idemKey ?? uid("evt");
      if (this.ledger.some((e) => e.idemKey === idemKey)) return undefined;
      const entry: LedgerEntry = {
        seq: this.ledger.length ? this.ledger[this.ledger.length - 1].seq + 1 : 1,
        idemKey,
        action,
        at: nowIso(),
        operator: extra.operator ?? "系统",
        tabId: extra.tabId ?? this.tabId,
        detail,
        fuel: extra.fuel,
        version: extra.version,
        batchId: extra.batchId,
      };
      this.ledger.push(entry);
      return entry;
    },

    /* ============ 时间轴 ============ */

    /** 根据当前时间刷新生效点状态（同一油品同一时刻只有一个有效价） */
    refreshPointStatuses(write = true) {
      const byFuel = new Map<string, PricePoint[]>();
      for (const p of this.points) {
        if (!byFuel.has(p.fuel)) byFuel.set(p.fuel, []);
        byFuel.get(p.fuel)!.push(p);
      }
      const now = nowIso();
      for (const list of byFuel.values()) {
        list.sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.version - b.version);
        // 找到“此刻”应生效的那一个：未撤销且生效时间 <= now 的最后一个
        let activeIdx = -1;
        list.forEach((p, i) => {
          if (p.status !== "revoked" && p.effectiveAt <= now) activeIdx = i;
        });
        list.forEach((p, i) => {
          if (p.status === "revoked") return;
          if (p.effectiveAt > now) p.status = "scheduled";
          else p.status = i === activeIdx ? "active" : "expired";
        });
      }
      if (write) this.persist();
    },

    /**
     * 把一个价格切换落到时间轴。
     * - 同一油品同一时刻只留一个有效价：撞点时后到的窗口判冲突，草稿保留并提示重排；
     * - idemKey 保证批量重试不重复生成记录；
     * - 每成功落一个点，时间轴版本 +1，旧草稿随即失效。
     */
    applyPoint(input: {
      idemKey: string;
      fuel: PricePoint["fuel"];
      price: number;
      effectiveAt: string;
      operator: string;
      source: PricePoint["source"];
      tabId?: string;
      orderId?: string;
      batchId?: string;
      note?: string;
    }): ActionResult & { pointId?: string } {
      // 幂等：同一业务事件重放，直接返回原结果
      const existed = this.points.find((p) => p.idemKey === input.idemKey);
      if (existed) {
        return {
          ok: true,
          kind: "duplicate",
          message: "该价格已在时间轴上，重试未重复生成",
          version: existed.version,
          pointId: existed.id,
        };
      }

      // 同一油品同一时刻只留一个有效价
      const clash = this.points.find(
        (p) => p.fuel === input.fuel && p.effectiveAt === input.effectiveAt && p.status !== "revoked"
      );
      if (clash) {
        return {
          ok: false,
          kind: "conflict",
          message: `${input.fuel} 在 ${formatTime(input.effectiveAt)} 已有 ${clash.price} 元（v${clash.version}），请改期后重排`,
        };
      }

      this.timelineVersion += 1;
      const point: PricePoint = {
        id: uid("pt"),
        idemKey: input.idemKey,
        fuel: input.fuel,
        price: input.price,
        effectiveAt: input.effectiveAt,
        version: this.timelineVersion,
        status: "scheduled",
        source: input.source,
        operator: input.operator,
        note: input.note,
        orderId: input.orderId,
        batchId: input.batchId,
        createdAt: nowIso(),
        createdBy: input.tabId ?? this.tabId,
      };
      this.points.push(point);
      this.refreshPointStatuses(false);

      // 时间轴一变，基于旧版本的草稿全部失效
      this.invalidateStaleDrafts(`时间轴更新至 v${this.timelineVersion}，草稿依据版本已过期`);

      this.log(
        "switch",
        `${input.fuel} 于 ${formatTime(input.effectiveAt)} 起执行 ${input.price} 元`,
        {
          idemKey: `switch:${input.idemKey}`,
          fuel: input.fuel,
          version: point.version,
          operator: input.operator,
          batchId: input.batchId,
        }
      );

      // 生效点恰好已到期（补切换）
      if (point.effectiveAt <= nowIso()) {
        this.log(
          "switch-catchup",
          `补执行 ${input.fuel} 错过的切换（应于 ${formatTime(input.effectiveAt)} 生效）`,
          { idemKey: `catchup:${input.idemKey}`, fuel: input.fuel, version: point.version, operator: input.operator }
        );
      }

      return { ok: true, kind: "applied", message: `已加入时间轴 v${point.version}`, version: point.version, pointId: point.id };
    },

    /** 失效所有 baseVersion 落后于当前时间轴版本的草稿（时间轴一变旧草稿失效） */
    invalidateStaleDrafts(reason: string) {
      for (const order of this.orders) {
        if (order.status === "submitted" && order.baseVersion < this.timelineVersion) {
          order.status = "stale";
          order.conflictReason = reason;
          order.updatedAt = nowIso();
          this.log("draft-stale", `调价单 ${order.id.slice(-6)} 失效：${reason}`, {
            idemKey: `stale:${order.id}:${this.timelineVersion}`,
            fuel: order.fuel,
            operator: order.operator,
          });
        }
      }
    },

    /* ============ 调价单（草稿） ============ */

    createDraft(
      input: {
        fuel: PricePoint["fuel"];
        price: number;
        effectiveAt: string;
        operator: string;
        note: string;
      },
      tabId?: string
    ): PriceOrder {
      const owner = tabId ?? this.tabId;
      const order: PriceOrder = {
        id: uid("ord"),
        fuel: input.fuel,
        price: input.price,
        effectiveAt: input.effectiveAt,
        operator: input.operator,
        note: input.note,
        status: "submitted",
        baseVersion: this.timelineVersion,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        createdBy: owner,
      };
      this.orders.unshift(order);
      this.log("draft-create", `${order.fuel} ${order.price} 元草稿，拟 ${formatTime(order.effectiveAt)} 生效（基于 v${order.baseVersion}）`, {
        idemKey: `draft-create:${order.id}`,
        fuel: order.fuel,
        version: order.baseVersion,
        operator: order.operator,
        tabId: owner,
      });
      this.persist();
      return order;
    },

    /** 批准草稿：冲突时保留草稿并提示重排。tabId 用于模拟另一换班窗口 */
    approveOrder(orderId: string, tabId?: string): ActionResult {
      const owner = tabId ?? this.tabId;
      const order = this.orders.find((o) => o.id === orderId);
      if (!order) return { ok: false, kind: "failed", message: "调价单不存在" };
      if (order.status === "applied") return { ok: false, kind: "duplicate", message: "该调价单已批准" };

      // 先看是否与时间轴撞点：晚到窗口保留草稿并提示重排
      const clash = this.points.find(
        (p) => p.fuel === order.fuel && p.effectiveAt === order.effectiveAt && p.status !== "revoked"
      );
      if (clash) {
        order.status = "conflict";
        order.conflictReason = `同一时刻已有 v${clash.version} 生效价 ${clash.price} 元`;
        order.updatedAt = nowIso();
        this.log("draft-conflict", `调价单撞点未批准：${order.fuel} @ ${formatTime(order.effectiveAt)} 已有 v${clash.version}`, {
          idemKey: `draft-conflict:${order.id}:${clash.version}`,
          fuel: order.fuel,
          operator: order.operator,
          tabId: owner,
        });
        this.persist();
        return {
          ok: false,
          kind: "conflict",
          message: `${order.fuel} 在 ${formatTime(order.effectiveAt)} 已有 ${clash.price} 元（v${clash.version}），草稿已保留，请改期重排`,
        };
      }

      // 时间轴一变旧草稿失效
      if (order.baseVersion < this.timelineVersion) {
        order.status = "stale";
        order.conflictReason = `草稿基于 v${order.baseVersion}，当前已到 v${this.timelineVersion}`;
        order.updatedAt = nowIso();
        this.persist();
        return { ok: false, kind: "stale", message: "时间轴已变更，草稿已失效，请重排后再提交" };
      }

      const res = this.applyPoint({
        idemKey: `order:${order.id}`,
        fuel: order.fuel,
        price: order.price,
        effectiveAt: order.effectiveAt,
        operator: order.operator,
        source: "draft",
        tabId: owner,
        orderId: order.id,
        note: order.note,
      });

      order.updatedAt = nowIso();
      if (res.ok && res.pointId) {
        order.status = "applied";
        order.pointId = res.pointId;
        this.log("draft-apply", `调价单批准：${order.fuel} ${order.price} 元 → v${res.version}`, {
          idemKey: `draft-apply:${order.id}`,
          fuel: order.fuel,
          version: res.version,
          operator: order.operator,
          tabId: owner,
        });
        this.persist();
        return { ok: true, kind: "applied", message: `已批准，时间轴 v${res.version}`, version: res.version };
      }

      // applyPoint 兜底冲突（极端并发）
      order.status = "conflict";
      order.conflictReason = res.message;
      this.log("draft-conflict", `调价单撞点未批准：${res.message}`, {
        idemKey: `draft-conflict:${order.id}:${this.timelineVersion}`,
        fuel: order.fuel,
        operator: order.operator,
        tabId: owner,
      });
      this.persist();
      return { ok: false, kind: "conflict", message: res.message };
    },

    /** 重排：改时间（也可改价）后重新挂回待提交 */
    reshuffleOrder(orderId: string, patch: { effectiveAt?: string; price?: number }): ActionResult {
      const order = this.orders.find((o) => o.id === orderId);
      if (!order) return { ok: false, kind: "failed", message: "调价单不存在" };
      if (patch.effectiveAt) order.effectiveAt = patch.effectiveAt;
      if (patch.price !== undefined) order.price = patch.price;
      order.status = "submitted";
      order.baseVersion = this.timelineVersion;
      order.conflictReason = undefined;
      order.updatedAt = nowIso();
      this.log("draft-reshuffle", `调价单重排：${order.fuel} 改至 ${formatTime(order.effectiveAt)}（重新基于 v${order.baseVersion}）`, {
        idemKey: `reshuffle:${order.id}:${order.effectiveAt}`,
        fuel: order.fuel,
        version: order.baseVersion,
        operator: order.operator,
      });
      this.persist();
      return { ok: true, kind: "applied", message: "已重排，可重新批准" };
    },

    deleteOrder(orderId: string) {
      const order = this.orders.find((o) => o.id === orderId);
      if (!order) return;
      this.orders = this.orders.filter((o) => o.id !== orderId);
      this.log("draft-delete", `删除调价单 ${order.fuel} ${order.price} 元`, {
        idemKey: `draft-delete:${order.id}`,
        fuel: order.fuel,
        operator: order.operator,
      });
      this.persist();
    },

    /* ============ 批量提交（可失败、可重试、重开续办） ============ */

    /**
     * 把多个调价单组成一个批次：先暂存（stage），逐条批准。
     * 中途某条失败不会影响已成功条目；重试同一批次只补未完成条目，
     * 已完成条目凭 idemKey 不会重复生成时间轴点和台账记录。
     */
    stageBatch(drafts: Array<Omit<PriceOrder, "id" | "status" | "baseVersion" | "createdAt" | "updatedAt" | "createdBy"> & { id?: string }>): PriceBatch {
      const batchId = uid("bat");
      const batch: PriceBatch = {
        id: batchId,
        createdAt: nowIso(),
        createdBy: this.tabId,
        done: false,
        // 稳定幂等键：批次id + 条目顺序，重试/重开都不变
        items: drafts.map((d, i) => ({
          idemKey: `batch:${batchId}:item:${i}`,
          orderId: d.id ?? uid("ord"),
          fuel: d.fuel,
          price: d.price,
          effectiveAt: d.effectiveAt,
          status: "pending",
          attempts: 0,
          updatedAt: nowIso(),
        })),
      };
      this.batches.unshift(batch);
      this.log("batch-stage", `批次 ${batch.id.slice(-6)} 暂存 ${batch.items.length} 条调价`, {
        idemKey: `batch-stage:${batch.id}`,
        batchId: batch.id,
      });
      this.persist();
      return batch;
    },

    /** 从选中的调价单快速组批（换班两个窗口各自提交时用） */
    stageBatchFromOrders(orderIds: string[]): PriceBatch | undefined {
      const orders = orderIds
        .map((id) => this.orders.find((o) => o.id === id))
        .filter((o): o is PriceOrder => !!o && o.status !== "applied");
      if (!orders.length) return undefined;
      const batch = this.stageBatch(
        orders.map((o) => ({
          id: o.id,
          fuel: o.fuel,
          price: o.price,
          effectiveAt: o.effectiveAt,
          operator: o.operator,
          note: o.note,
        }))
      );
      for (const o of orders) o.batchId = batch.id;
      this.persist();
      return batch;
    },

    /**
     * 重试批次：逐条跑未完成的条目（幂等）。
     * failItemIds 非空时模拟这些条目“提交失败”，用于演示中途失败后的重试。
     */
    retryBatch(batchId: string, failItemIdx: number[] = []): ActionResult {
      const batch = this.batches.find((b) => b.id === batchId);
      if (!batch) return { ok: false, kind: "failed", message: "批次不存在" };

      let applied = 0;
      let conflict = 0;
      let failed = 0;

      batch.items.forEach((item, idx) => {
        if (item.status === "done") return; // 已完成不重复处理
        item.attempts += 1;
        item.updatedAt = nowIso();

        // 模拟网络失败：记录台账，条目仍 pending，下次重试
        if (failItemIdx.includes(idx)) {
          failed += 1;
          item.message = "提交失败，等待重试";
          this.log("batch-item-fail", `${item.fuel} 提交失败（第 ${item.attempts} 次）`, {
            idemKey: `batch-fail:${batch.id}:${idx}:${item.attempts}`,
            fuel: item.fuel,
            batchId: batch.id,
            operator: "系统",
          });
          return;
        }

        // 找到对应调价单（可能来自另一窗口）
        const order = this.orders.find((o) => o.id === item.orderId);

        const res = this.applyPoint({
          idemKey: item.idemKey,
          fuel: item.fuel,
          price: item.price,
          effectiveAt: item.effectiveAt,
          operator: order?.operator ?? "批量提交",
          source: "batch",
          tabId: batch.createdBy,
          batchId: batch.id,
          note: order?.note,
        });

        if (res.ok && res.pointId) {
          item.status = "done";
          item.pointId = res.pointId;
          item.message = res.kind === "duplicate" ? "重试命中已生成记录，未重复创建" : `已入时间轴 v${res.version}`;
          if (order) {
            order.status = "applied";
            order.pointId = res.pointId;
            order.batchId = batch.id;
            order.updatedAt = nowIso();
          }
          applied += 1;
          this.log("batch-item-apply", `批次条目生效：${item.fuel} ${item.price} 元 → v${res.version}`, {
            idemKey: `batch-item-apply:${item.idemKey}`,
            fuel: item.fuel,
            version: res.version,
            batchId: batch.id,
            operator: order?.operator ?? "批量提交",
          });
        } else if (res.kind === "conflict") {
          item.status = "conflict";
          item.message = res.message;
          if (order) {
            order.status = "conflict";
            order.conflictReason = res.message;
            order.updatedAt = nowIso();
          }
          conflict += 1;
          this.log("batch-item-conflict", `批次条目撞点：${res.message}`, {
            idemKey: `batch-conflict:${item.idemKey}:${this.timelineVersion}`,
            fuel: item.fuel,
            batchId: batch.id,
          });
        }
      });

      const remaining = batch.items.filter((i) => i.status === "pending").length;
      const hasConflict = batch.items.some((i) => i.status === "conflict");
      batch.done = remaining === 0; // 撞条目不阻塞批次收尾，冲突条目可重排后再提
      if (batch.done) {
        this.log("batch-done", `批次 ${batch.id.slice(-6)} 处理完成（成功 ${batch.items.filter((i) => i.status === "done").length} 条${hasConflict ? `，冲突 ${batch.items.filter((i) => i.status === "conflict").length} 条` : ""}）`, {
          idemKey: `batch-done:${batch.id}:${batch.items.map((i) => i.status).join(",")}`,
          batchId: batch.id,
        });
      }
      this.persist();

      if (failed > 0) return { ok: false, kind: "failed", message: `${failed} 条提交失败，可重试同一批次，已成功的 ${applied} 条不会重复生成` };
      if (remaining > 0) return { ok: false, kind: "failed", message: `还剩 ${remaining} 条未完成` };
      if (hasConflict)
        return { ok: false, kind: "conflict", message: `批次完成，${conflict} 条撞点，草稿已保留请重排` };
      if (applied === 0)
        return { ok: true, kind: "duplicate", message: "批次条目此前均已生效，重试未重复生成任何记录" };
      return { ok: true, kind: "applied", message: `批次全部生效，本次新增 ${applied} 条` };
    },

    /** 批次中冲突条目的重排（改期后回到待提交，重新挂入新批次或单条批准） */
    reshuffleBatchItem(batchId: string, idemKey: string, effectiveAt: string): ActionResult {
      const batch = this.batches.find((b) => b.id === batchId);
      const item = batch?.items.find((i) => i.idemKey === idemKey);
      if (!item) return { ok: false, kind: "failed", message: "批次条目不存在" };
      item.effectiveAt = effectiveAt;
      item.status = "pending";
      item.message = undefined;
      item.updatedAt = nowIso();
      batch!.done = false;
      const order = this.orders.find((o) => o.id === item.orderId);
      if (order) {
        order.effectiveAt = effectiveAt;
        order.status = "submitted";
        order.baseVersion = this.timelineVersion;
        order.conflictReason = undefined;
        order.updatedAt = nowIso();
      }
      this.log("batch-reshuffle", `批次条目重排：${item.fuel} 改至 ${formatTime(effectiveAt)}`, {
        idemKey: `batch-reshuffle:${idemKey}:${effectiveAt}`,
        fuel: item.fuel,
        batchId: batchId,
      });
      this.persist();
      return { ok: true, kind: "applied", message: "已重排，请重试批次" };
    },

    /* ============ 回滚：只撤指定版本，后面批准的价格不受影响 ============ */

    /**
     * 回滚某一版本：仅把该版本的生效点标记 revoked，时间轴上其余点保留，
     * 已在它之后批准的价格版本号、生效时间都不受影响。
     */
    rollbackVersion(version: number, operator: string): ActionResult {
      const target = this.points.filter((p) => p.version === version && p.status !== "revoked");
      if (!target.length) return { ok: false, kind: "failed", message: `v${version} 没有可回滚的价格` };
      for (const p of target) {
        p.status = "revoked";
        this.log("rollback", `回滚 v${version}：撤销 ${p.fuel} ${p.price} 元（${formatTime(p.effectiveAt)} 生效）`, {
          idemKey: `rollback:${p.id}`,
          fuel: p.fuel,
          version,
          operator,
        });
      }
      this.refreshPointStatuses(false);
      this.persist();
      return { ok: true, kind: "applied", message: `已回滚 v${version}（${target.length} 条），其后版本不受影响` };
    },

    /* ============ 迁移：旧数据 → 时间轴 v1，可中断续跑 ============ */

    /**
     * 把已有数据迁移成时间轴最初版本（v1）。
     * - 同一油品同一时刻只留一个：旧数据里同油品同日期的只迁第一条，其余在旧价台账标注跳过；
     * - 迁移中断后继续完成（cursor 续跑，点与台账均幂等）；
     * - 旧价照旧可查：legacyRecords 永久保留。
     */
    startMigration(v0: V0Record[]) {
      if (this.migration.started) return;
      this.legacyRecords = v0.map((r) => ({
        ...r,
        migrated: false,
      }));
      this.migration = {
        started: true,
        running: true,
        paused: false,
        finished: false,
        total: v0.length,
        cursor: 0,
        startedAt: nowIso(),
      };
      this.log("migration-start", `开始迁移 ${v0.length} 条旧价到时间轴最初版本`, {
        idemKey: "migration-start",
        operator: "系统",
      });
      this.persist();
      this.processMigrationChunk();
    },

    /** 模拟分批迁移：每拍只迁一条，刷新/关闭后再开从 cursor 继续 */
    processMigrationChunk() {
      if (!this.migration.started || this.migration.finished) return;
      if (this.migration.paused) {
        this.log("migration-pause", `迁移中断于第 ${this.migration.cursor}/${this.migration.total} 条，重开后继续`, {
          idemKey: `migration-pause:${this.migration.cursor}`,
          operator: "系统",
        });
        this.persist();
        return;
      }
      this.migration.running = true;

      const i = this.migration.cursor;
      if (i < this.migration.total) {
        const legacy = this.legacyRecords[i];
        const effectiveAt = legacyDateToIso(legacy.effectiveDate);
        const idemKey = `migration:${legacy.id}`;

        const existed = this.points.find((p) => p.idemKey === idemKey);
        const clash = this.points.find(
          (p) => p.fuel === legacy.fuel && p.effectiveAt === effectiveAt && p.status !== "revoked"
        );

        if (existed) {
          legacy.migrated = true;
          legacy.migratedPointId = existed.id;
          legacy.migratedAt = legacy.migratedAt ?? nowIso();
        } else if (clash) {
          // 同油品同时刻只留一个有效价：保留先迁入的，后者在旧价中可查、不生成重复点
          legacy.migrated = true;
          legacy.migratedPointId = clash.id;
          legacy.migratedAt = nowIso();
          this.log("migration-item", `旧价 ${legacy.fuel} ${legacy.price} 元与 v${clash.version} 同时刻，并入该生效点，不重复建价`, {
            idemKey: `migration-skip:${legacy.id}`,
            fuel: legacy.fuel,
            version: clash.version,
            operator: "系统",
          });
        } else {
          this.timelineVersion += 1; // 首批迁移点即 v1（同拍内连续编号，整体属于“最初版本”代）
          const point: PricePoint = {
            id: uid("pt"),
            idemKey,
            fuel: legacy.fuel,
            price: legacy.price,
            effectiveAt,
            version: this.timelineVersion,
            status: "scheduled",
            source: "migration",
            operator: legacy.operator,
            note: `迁移自旧价（${legacy.status} / ${legacy.notes}）`,
            createdAt: nowIso(),
            createdBy: "migration",
          };
          this.points.push(point);
          legacy.migrated = true;
          legacy.migratedPointId = point.id;
          legacy.migratedAt = nowIso();
          this.log("migration-item", `旧价迁入时间轴：${legacy.fuel} ${legacy.price} 元 → v${point.version}`, {
            idemKey: `migration-item:${legacy.id}`,
            fuel: legacy.fuel,
            version: point.version,
            operator: "系统",
          });
        }
        this.migration.cursor = i + 1;
        this.refreshPointStatuses(false);
        this.persist();

        // 继续下一拍，让出主线程，便于观察“中断后续跑”
        setTimeout(() => this.processMigrationChunk(), 120);
      } else {
        this.finishMigration();
      }
    },

    finishMigration() {
      this.migration.running = false;
      this.migration.paused = false;
      this.migration.finished = true;
      this.migration.finishedAt = nowIso();
      this.refreshPointStatuses(false);
      this.log("migration-done", `旧价迁移完成：${this.migration.total}/${this.migration.total}，旧价仍可在“旧价查询”中查看`, {
        idemKey: "migration-done",
        operator: "系统",
      });
      this.persist();
      // 首次迁移完成后同样补一遍停用期间错过的切换
      this.runCatchup();
    },

    pauseMigration() {
      if (this.migration.finished) return;
      this.migration.paused = true;
      this.migration.running = false;
      this.persist();
    },

    /** 迁移中断后继续完成 */
    resumeMigration() {
      if (!this.migration.started || this.migration.finished) return;
      this.migration.paused = false;
      this.migration.running = true;
      this.persist();
      this.processMigrationChunk();
    },

    /* ============ 补切换：重开后补上停用期间错过的切换 ============ */

    runCatchup() {
      const missed = this.missedSwitches;
      this.catchupCount = missed.length;
      for (const p of missed) {
        this.log("switch-catchup", `重开补切换：${p.fuel} 已于 ${formatTime(p.effectiveAt)} 起执行 ${p.price} 元`, {
          idemKey: `catchup-reopen:${p.id}`,
          fuel: p.fuel,
          version: p.version,
          operator: p.operator,
        });
      }
      this.refreshPointStatuses(false);
      if (missed.length) this.persist();
      this.lastSeenAt = nowIso();
      this.persist();
    },

    /* ============ 查询 ============ */

    /** 某油品在指定时刻（默认现在）的有效价 */
    effectivePrice(fuel: string, at: string = nowIso()): PricePoint | undefined {
      const list = (this.timelineByFuel[fuel] ?? [])
        .filter((p) => p.status !== "revoked" && p.effectiveAt <= at)
        .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || b.version - a.version);
      return list[0];
    },
  },
});

/* ---------------- 展示辅助 ---------------- */

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function toInputValue(iso: string): string {
  return toDatetimeInput(iso);
}

export type { BatchItem };
