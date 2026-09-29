export const project = {
  number: 9,
  folder: "dfwl/frontend/dfwlfront-9",
  framework: "vue",
  title: "油品价格维护",
  subtitle: "调价单、价格时间轴与操作台账联动：同一油品同一时刻只留一个有效价，草稿随时间轴失效，批量提交可断点续办。",
  industry: "石油",
  stack: [
    "Vue3",
    "Vite",
    "TypeScript",
    "Pinia",
    "Naive UI"
  ],
  storageKey: "dfwlfront-9-price",
  stateKey: "dfwlfront-9-state",
  formTitle: "新建调价单",
  primaryAction: "提交调价单",
  entityLabel: "油品",
  statuses: [
    "生效中",
    "待确认",
    "已回退"
  ],
  filters: [
    "全部油品",
    "92号汽油",
    "95号汽油",
    "98号汽油",
    "柴油"
  ],
  fields: [
    {
      key: "fuel",
      label: "油品",
      type: "select",
      options: [
        "92号汽油",
        "95号汽油",
        "98号汽油",
        "柴油"
      ]
    },
    {
      key: "price",
      label: "挂牌价",
      type: "number"
    },
    {
      key: "operator",
      label: "操作员"
    },
    {
      key: "effectiveDate",
      label: "生效日期",
      type: "date"
    }
  ],
  records: [
    {
      fuel: "92号汽油",
      price: 7.62,
      operator: "站长",
      effectiveDate: "2026-06-30",
      status: "生效中",
      notes: "正常调价"
    },
    {
      fuel: "柴油",
      price: 7.18,
      operator: "值班经理",
      effectiveDate: "2026-06-30",
      status: "待确认",
      notes: "等待复核"
    }
  ],
  metricLabels: [
    "调价单总数",
    "待生效价格",
    "时间轴版本"
  ]
} as const;

export type ProjectConfig = typeof project;
