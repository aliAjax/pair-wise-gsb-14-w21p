// 价格时间轴 / 调价单 / 操作台账 核心数据模型

/** 价格点状态：待生效（未来价）、生效中、已失效（被同刻新价取代）、已回滚 */
export type FuelPriceStatus = "scheduled" | "active" | "superseded" | "rolled_back";

/** 时间轴版本状态：生效中、已回滚 */
export type VersionStatus = "active" | "rolled_back";

/** 调价单状态：草稿、提交中、已批准、部分成功、失败 */
export type OrderStatus = "draft" | "submitting" | "approved" | "partial" | "failed";

/** 调价单项状态：待处理、已生效、失败 */
export type ItemStatus = "pending" | "done" | "failed";

/** 台账操作类型 */
export type LedgerType =
  | "migrate_start"
  | "migrate"
  | "migrate_done"
  | "order_create"
  | "submit"
  | "approve"
  | "rollback"
  | "catchup"
  | "conflict"
  | "stale"
  | "rebase";

/** 价格点：某个油品在某个生效时刻的唯一有效价 */
export interface PricePoint {
  id: string;
  fuel: string;
  price: number;
  /** 生效日期 YYYY-MM-DD */
  effectiveAt: string;
  status: FuelPriceStatus;
  /** 来源调价单 id（迁移数据为空） */
  orderId: string;
  /** 所属时间轴版本 id */
  versionId: string;
  /** 迁移前的历史记录 id，用于断点续迁去重 */
  legacyId?: string;
  operator: string;
  createdAt: string;
}

/** 时间轴版本：每次批准调价单生成一个新版本 */
export interface TimelineVersion {
  id: string;
  number: number;
  status: VersionStatus;
  createdAt: string;
  /** 产生该版本的调价单 id */
  orderId?: string;
  note?: string;
}

/** 调价单项 */
export interface OrderItem {
  id: string;
  fuel: string;
  price: number;
  effectiveAt: string;
  status: ItemStatus;
  /** 批准后生成的价格点 id */
  priceId?: string;
  /** 失败原因（如同时刻已有有效价） */
  error?: string;
}

/** 调价单（批量提交的幂等单元） */
export interface AdjustmentOrder {
  id: string;
  /** 调价单号，幂等键 */
  batchNo: string;
  operator: string;
  note: string;
  status: OrderStatus;
  items: OrderItem[];
  /** 起草时基于的时间轴版本 id */
  baseVersionId: string;
  /** 批准后生成的时间轴版本 id（部分成功时复用同一版本） */
  versionId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 操作台账条目 */
export interface LedgerEntry {
  id: string;
  at: string;
  type: LedgerType;
  refType?: "order" | "version" | "price";
  refId?: string;
  detail: string;
  operator?: string;
}

/** 迁移状态（可中断、可续跑） */
export interface MigrationState {
  status: "idle" | "running" | "done";
  total: number;
  done: number;
  startedAt?: string;
  finishedAt?: string;
}

/** 全局状态 */
export interface State {
  schemaVersion: 1;
  versions: TimelineVersion[];
  prices: PricePoint[];
  orders: AdjustmentOrder[];
  ledger: LedgerEntry[];
  migration: MigrationState;
  versionCounter: number;
  orderCounter: number;
}

/** 历史记录（迁移前的旧格式） */
export interface LegacyPrice {
  id?: string | number;
  fuel?: string;
  price?: number | string;
  effectiveDate?: string;
  effectiveAt?: string;
  operator?: string;
  status?: string;
  notes?: string;
  [key: string]: unknown;
}
