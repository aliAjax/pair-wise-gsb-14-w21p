export const FUELS = ["92号汽油", "98号汽油", "95号汽油", "柴油"] as const;
export type Fuel = (typeof FUELS)[number];

/** 价格时间轴上的一个生效点：step function 的一次价格切换 */
export interface PricePoint {
  id: string;
  /** 幂等键：同一来源重试只会生成同一个生效点 */
  idemKey: string;
  fuel: Fuel;
  price: number;
  effectiveAt: string; // ISO 时间
  /** 所属时间轴版本：迁移旧价全部为 v1，此后每批准一条价格生成一个新版本 */
  version: number;
  status: "scheduled" | "active" | "expired" | "revoked";
  source: "draft" | "batch" | "migration";
  operator: string;
  note?: string;
  orderId?: string;
  batchId?: string;
  createdAt: string;
  createdBy: string; // 提交窗口 tabId
}

export type OrderStatus = "submitted" | "applied" | "stale" | "conflict";

/** 调价单：窗口里编辑/提交的草稿，批准后与时间轴生效点关联 */
export interface PriceOrder {
  id: string;
  fuel: Fuel;
  price: number;
  effectiveAt: string;
  operator: string;
  note: string;
  status: OrderStatus;
  /** 创建/重排时所依据的时间轴版本，落后于当前版本即为失效草稿 */
  baseVersion: number;
  pointId?: string;
  batchId?: string;
  conflictReason?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export type BatchItemStatus = "pending" | "done" | "conflict" | "stale";

export interface BatchItem {
  /** 批次内稳定幂等键，重试同一批次时已完成的条目不会重复生成记录 */
  idemKey: string;
  orderId: string;
  fuel: Fuel;
  price: number;
  effectiveAt: string;
  status: BatchItemStatus;
  attempts: number;
  pointId?: string;
  message?: string;
  updatedAt: string;
}

export interface PriceBatch {
  id: string;
  createdAt: string;
  createdBy: string;
  done: boolean;
  items: BatchItem[];
}

export type LedgerAction =
  | "draft-create"
  | "draft-apply"
  | "draft-conflict"
  | "draft-stale"
  | "draft-reshuffle"
  | "draft-delete"
  | "batch-stage"
  | "batch-item-apply"
  | "batch-item-conflict"
  | "batch-item-stale"
  | "batch-item-fail"
  | "batch-reshuffle"
  | "batch-done"
  | "switch"
  | "switch-catchup"
  | "rollback"
  | "migration-start"
  | "migration-item"
  | "migration-pause"
  | "migration-done";

export interface LedgerEntry {
  seq: number;
  /** 幂等键：台账中同一个业务事件只出现一次 */
  idemKey: string;
  action: LedgerAction;
  at: string;
  operator: string;
  tabId: string;
  detail: string;
  fuel?: Fuel;
  version?: number;
  batchId?: string;
}

/** 旧版（v0）挂牌价记录，迁移后仍永久可查 */
export interface LegacyRecord {
  id: string;
  fuel: Fuel;
  price: number;
  operator: string;
  effectiveDate: string; // yyyy-MM-dd
  status: string;
  notes: string;
  createdAt: string;
  migrated: boolean;
  migratedPointId?: string;
  migratedAt?: string;
}

export interface MigrationState {
  started: boolean;
  running: boolean;
  paused: boolean;
  finished: boolean;
  total: number;
  cursor: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface PersistState {
  schema: 2;
  rev: number;
  timelineVersion: number;
  points: PricePoint[];
  orders: PriceOrder[];
  batches: PriceBatch[];
  ledger: LedgerEntry[];
  legacyRecords: LegacyRecord[];
  migration: MigrationState;
  /** 页面最后一次在线时间，用于重开时识别停用期间错过的切换 */
  lastSeenAt?: string;
}

export interface ActionResult {
  ok: boolean;
  kind: "applied" | "conflict" | "stale" | "failed" | "noop" | "duplicate";
  message: string;
  version?: number;
}
