// 价格维护 store：调价单 / 价格时间轴 / 操作台账
// - 初始化时把历史数据迁移到时间轴 v1（可中断续跑）
// - 提交前重新读取 localStorage，覆盖另一窗口已批准的价格（两窗口并发提交场景）
// - 监听 storage 事件与页面可见性变化，重开后自动同步并补上错过的切换
import { defineStore } from "pinia";
import * as logic from "../logic/priceLogic";
import type { CreateOrderInput, SubmitResult } from "../logic/priceLogic";
import type { AdjustmentOrder, LegacyPrice, State, TimelineVersion } from "../logic/types";
import { LEGACY_KEY, loadLegacyRecords, loadState, saveState, seedLegacyRecords, STATE_KEY } from "../logic/storage";

let initialized = false;

export const usePriceStore = defineStore("price", {
  state: (): State => logic.createInitialState(),

  getters: {
    latestVersion(state): TimelineVersion | undefined {
      return logic.latestVersion(state);
    },
    staleOrders(state): AdjustmentOrder[] {
      return logic.staleOrders(state);
    },
    versionNumber(state): (versionId: string | undefined) => number {
      return (versionId) => logic.versionNumberOf(state, versionId);
    },
  },

  actions: {
    /** 页面打开/重开时调用：迁移历史数据、同步其他窗口、补切换 */
    init() {
      if (initialized) return;
      initialized = true;

      let state = loadState();
      if (!state) {
        // 首次使用：历史数据迁移为时间轴 v1
        state = logic.createInitialState();
        const legacy = loadLegacyRecords() ?? seedLegacyRecords();
        logic.migrateLegacy(state, legacy as LegacyPrice[]);
        saveState(state);
      } else if (state.migration.status === "running") {
        // 迁移曾中断：续跑
        const legacy = loadLegacyRecords() ?? [];
        logic.migrateLegacy(state, legacy);
        saveState(state);
      }
      this.$patch(state);

      const caught = logic.catchUp(this.$state);
      if (caught > 0) saveState(this.$state);

      if (typeof window !== "undefined") {
        window.addEventListener("storage", this.onStorage);
        document.addEventListener("visibilitychange", this.onVisible);
      }
    },

    onStorage(event: StorageEvent) {
      if (event.key === STATE_KEY || event.key === LEGACY_KEY) {
        this.reload();
      }
    },

    onVisible() {
      if (document.visibilityState === "visible") {
        this.reload();
        const caught = logic.catchUp(this.$state);
        if (caught > 0) saveState(this.$state);
      }
    },

    /** 从 localStorage 重新加载最新状态（跨窗口同步） */
    reload() {
      const state = loadState();
      if (state) {
        this.$patch(state);
      }
    },

    persist() {
      saveState(this.$state);
    },

    createOrder(input: CreateOrderInput): AdjustmentOrder {
      const order = logic.createOrder(this.$state, input);
      this.persist();
      return order;
    },

    submitOrder(orderId: string): SubmitResult {
      // 提交前先同步另一窗口可能已批准的时间轴版本
      this.reload();
      const result = logic.submitOrder(this.$state, orderId);
      this.persist();
      return result;
    },

    rebaseOrder(orderId: string) {
      const result = logic.rebaseOrder(this.$state, orderId);
      this.persist();
      return result;
    },

    rollbackVersion(versionId: string) {
      this.reload();
      const result = logic.rollbackVersion(this.$state, versionId);
      this.persist();
      return result;
    },

    /** 重开页面后补上停用期间错过的切换 */
    catchUp(): number {
      const count = logic.catchUp(this.$state);
      this.persist();
      return count;
    },

    queryPrice(fuel: string, at: string) {
      return logic.queryPrice(this.$state, fuel, at);
    },
  },
});

/** 仅供测试重置 store 初始化标记 */
export function _resetPriceStoreForTest(): void {
  initialized = false;
}
