import type {
  AuditEntry,
  DatasetVersion,
  DeletionTask,
  LegalHold,
  Receipt,
  Replica,
  StorageLocation,
  TrackerState,
} from "../domain/types";

export const LOCATIONS: StorageLocation[] = [
  { id: "loc-main-hz", name: "主集群 · 杭州", region: "cn-east", latencyMs: 420 },
  { id: "loc-replica-sh", name: "热备副本 · 上海", region: "cn-east", latencyMs: 560 },
  { id: "loc-cold-bj", name: "冷存储 · 北京", region: "cn-north", latencyMs: 640 },
  { id: "loc-vault-sz", name: "归档库 · 深圳", region: "cn-south", latencyMs: 720 },
  { id: "loc-tape-overseas", name: "异地磁带库 · 新加坡", region: "ap-southeast", latencyMs: 900 },
];

const T0 = "2026-11-13";

function version(
  id: string,
  datasetName: string,
  versionLabel: string,
  createdAt: string,
  retentionDays: number,
  recordCount: number,
): DatasetVersion {
  return {
    id,
    datasetId: `ds-${id}`,
    datasetName,
    versionLabel,
    createdAt,
    recordCount,
    retentionDays,
    retentionChanges: [],
  };
}

function replica(
  id: string,
  versionId: string,
  locationId: string,
  state: Replica["state"],
  observedAt: string,
  extras: Partial<Replica> = {},
): Replica {
  return {
    id,
    versionId,
    locationId,
    kind: locationId.includes("vault") || locationId.includes("tape") ? "archive"
      : locationId.includes("main") ? "primary" : "backup",
    state,
    observedAt,
    stateBeforeHold: null,
    lastReceiptId: null,
    faultInjected: false,
    ...extras,
  };
}

export function seedState(): TrackerState {
  // 六个虚构数据版本，到期日各不相同，覆盖"已过期 / 今日到期 / 即将过期 / 未到期"。
  const versions: DatasetVersion[] = [
    version("ver-1001", "客户画像快照", "v4", "2025-11-09", 365, 1_284_000), // 2026-11-09 已过期
    version("ver-1002", "交易流水归档", "2025-Q2", "2025-04-02", 540, 8_412_000), // 2026-09-24 已过期
    version("ver-1003", "通话录音索引", "v2.1", "2025-12-04", 330, 962_000), // 2026-10-30 已过期
    version("ver-1004", "工单附件池", "2026.3", "2026-01-18", 300, 214_500), // 2026-11-14 明日到期
    version("ver-1005", "设备遥测汇总", "v1", "2026-08-20", 90, 3_880_000), // 2026-11-18 即将到期
    version("ver-1006", "供应商对账底稿", "2026-10", "2026-10-31", 60, 58_400), // 2026-12-30 未到期
  ];

  const replicas: Replica[] = [
    // ver-1001：已过期但尚未发起计划，三个位置全部待处置
    replica("rep-2001", "ver-1001", "loc-main-hz", "pending", `${T0}T08:00:00.000Z`),
    replica("rep-2002", "ver-1001", "loc-vault-sz", "pending", `${T0}T08:00:00.000Z`),
    replica("rep-2002b", "ver-1001", "loc-cold-bj", "pending", `${T0}T08:00:00.000Z`),
    // ver-1002：一次失败执行，失败回执保留
    replica("rep-2003", "ver-1002", "loc-main-hz", "deleted", `${T0}T08:00:00.000Z`),
    replica("rep-2004", "ver-1002", "loc-replica-sh", "failed", `${T0}T08:00:00.000Z`, {
      faultInjected: true,
    }),
    replica("rep-2005", "ver-1002", "loc-tape-overseas", "pending", `${T0}T08:00:00.000Z`),
    // ver-1003：部分执行，归档库副本未执行
    replica("rep-2006", "ver-1003", "loc-main-hz", "deleted", `${T0}T08:00:00.000Z`),
    replica("rep-2007", "ver-1003", "loc-replica-sh", "deleted", `${T0}T08:00:00.000Z`),
    replica("rep-2008", "ver-1003", "loc-vault-sz", "pending", `${T0}T08:00:00.000Z`),
    // ver-1004：主集群已确认，其余两个位置在计划执行前被法律保留阻断
    replica("rep-2009", "ver-1004", "loc-main-hz", "deleted", `${T0}T08:00:00.000Z`, {
      lastReceiptId: "rcp-4006",
    }),
    replica("rep-2010", "ver-1004", "loc-replica-sh", "held", `${T0}T08:00:00.000Z`, {
      stateBeforeHold: "pending",
    }),
    replica("rep-2011", "ver-1004", "loc-cold-bj", "held", `${T0}T08:00:00.000Z`, {
      stateBeforeHold: "pending",
    }),
    // ver-1005：全部副本确认移除，可展示"完成"样本
    replica("rep-2012", "ver-1005", "loc-main-hz", "deleted", `${T0}T08:00:00.000Z`, {
      lastReceiptId: "rcp-4009",
    }),
    replica("rep-2013", "ver-1005", "loc-replica-sh", "deleted", `${T0}T08:00:00.000Z`, {
      lastReceiptId: "rcp-4010",
    }),
    // ver-1006：任务已完成，后来在归档库发现新副本，任务重开
    replica("rep-2014", "ver-1006", "loc-main-hz", "deleted", `${T0}T08:00:00.000Z`, {
      lastReceiptId: "rcp-4007",
    }),
    replica("rep-2015", "ver-1006", "loc-replica-sh", "deleted", `${T0}T08:00:00.000Z`, {
      lastReceiptId: "rcp-4008",
    }),
    replica("rep-2016", "ver-1006", "loc-vault-sz", "pending", `${T0}T08:00:00.000Z`),
  ];

  const tasks: DeletionTask[] = [
    {
      id: "task-3001",
      versionId: "ver-1002",
      targetReplicaIds: ["rep-2003", "rep-2004", "rep-2005"],
      plannedExpiry: "2026-09-24",
      status: "failed",
      isRunning: false,
      createdAt: "2026-11-06T09:14:00.000Z",
      cancelledAt: null,
      cancelReason: null,
      receiptIds: ["rcp-4001", "rcp-4002", "rcp-4003"],
      events: [
        { id: "evt-5001", at: "2026-11-06T09:14:00.000Z", type: "created", detail: "到期后手动发起删除请求，目标 3 个副本，计划依据到期日 2026-09-24" },
        { id: "evt-5002", at: "2026-11-06T09:26:00.000Z", type: "failed", detail: "热备副本 · 上海 第 1 次执行失败（回执 rcp-4002），失败历史保留" },
        { id: "evt-5003", at: "2026-11-06T09:26:00.000Z", type: "failed", detail: "未完成：仍有 2 个副本未确认 —— 热备副本 · 上海（执行失败）；异地磁带库 · 新加坡（尚未执行）" },
      ],
      requestKey: "ver-1002|rep-2003,rep-2004,rep-2005",
      requestCount: 1,
    },
    {
      id: "task-3002",
      versionId: "ver-1003",
      targetReplicaIds: ["rep-2006", "rep-2007", "rep-2008"],
      plannedExpiry: "2026-10-30",
      status: "planned",
      isRunning: false,
      createdAt: "2026-10-28T10:02:00.000Z",
      cancelledAt: null,
      cancelReason: null,
      receiptIds: ["rcp-4004", "rcp-4005"],
      events: [
        { id: "evt-5004", at: "2026-10-28T10:02:00.000Z", type: "created", detail: "到期前预排计划，目标 3 个副本" },
        { id: "evt-5005", at: "2026-10-28T10:20:00.000Z", type: "started", detail: "开始第 1 次执行，2 个副本" },
      ],
      requestKey: "ver-1003|rep-2006,rep-2007,rep-2008",
      requestCount: 1,
    },
    {
      id: "task-3003",
      versionId: "ver-1004",
      targetReplicaIds: ["rep-2009", "rep-2010", "rep-2011"],
      plannedExpiry: "2026-11-14",
      status: "held",
      isRunning: false,
      createdAt: "2026-11-01T07:45:00.000Z",
      cancelledAt: null,
      cancelReason: null,
      receiptIds: ["rcp-4006"],
      events: [
        { id: "evt-5006", at: "2026-11-01T07:45:00.000Z", type: "created", detail: "计划建立，目标 3 个副本" },
        { id: "evt-5007", at: "2026-11-02T16:05:00.000Z", type: "held", detail: "热备副本 · 上海、冷存储 · 北京 进入法律保留，不参与执行" },
      ],
      requestKey: "ver-1004|rep-2009,rep-2010,rep-2011",
      requestCount: 1,
    },
    {
      id: "task-3005",
      versionId: "ver-1005",
      targetReplicaIds: ["rep-2012", "rep-2013"],
      plannedExpiry: "2026-11-18",
      status: "completed",
      isRunning: false,
      createdAt: "2026-11-09T15:40:00.000Z",
      cancelledAt: null,
      cancelReason: null,
      receiptIds: ["rcp-4009", "rcp-4010"],
      events: [
        { id: "evt-5011", at: "2026-11-09T15:40:00.000Z", type: "created", detail: "计划建立，目标 2 个副本，计划依据到期日 2026-11-18" },
        { id: "evt-5012", at: "2026-11-09T15:52:00.000Z", type: "completed", detail: "全部 2 个当前副本均已取得成功回执，任务完成" },
      ],
      requestKey: "ver-1005|rep-2012,rep-2013",
      requestCount: 1,
    },
    {
      id: "task-3004",
      versionId: "ver-1006",
      targetReplicaIds: ["rep-2014", "rep-2015", "rep-2016"],
      plannedExpiry: "2026-12-30",
      status: "planned",
      isRunning: false,
      createdAt: "2026-11-08T14:20:00.000Z",
      cancelledAt: null,
      cancelReason: null,
      receiptIds: ["rcp-4007", "rcp-4008"],
      events: [
        { id: "evt-5008", at: "2026-11-08T14:20:00.000Z", type: "created", detail: "计划建立，目标 2 个副本" },
        { id: "evt-5009", at: "2026-11-08T14:31:00.000Z", type: "completed", detail: "全部 2 个当前副本均已取得成功回执，任务完成" },
        { id: "evt-5010", at: "2026-11-10T11:30:00.000Z", type: "replica-added", detail: "观测量在归档库 · 深圳 发现新副本 rep-2016，并入任务并重新待办；原回执保留" },
      ],
      requestKey: "ver-1006|rep-2014,rep-2015,rep-2016",
      requestCount: 1,
    },
  ];

  const receipts: Receipt[] = [
    {
      id: "rcp-4006",
      taskId: "task-3003",
      replicaId: "rep-2009",
      locationId: "loc-main-hz",
      locationName: "主集群 · 杭州",
      attempt: 1,
      outcome: "succeeded",
      at: "2026-11-01T08:02:00.000Z",
      message: "已确认移除：主集群 · 杭州 校验通过（演练，未触碰真实存储）",
    },
    {
      id: "rcp-4001",
      taskId: "task-3001",
      replicaId: "rep-2003",
      locationId: "loc-main-hz",
      locationName: "主集群 · 杭州",
      attempt: 1,
      outcome: "succeeded",
      at: "2026-11-06T09:20:00.000Z",
      message: "已确认移除：主集群 · 杭州 校验通过（演练，未触碰真实存储）",
    },
    {
      id: "rcp-4002",
      taskId: "task-3001",
      replicaId: "rep-2004",
      locationId: "loc-replica-sh",
      locationName: "热备副本 · 上海",
      attempt: 1,
      outcome: "failed",
      at: "2026-11-06T09:26:00.000Z",
      message: "拒绝移除：热备副本 · 上海 演练故障注入，未取得确认",
    },
    {
      id: "rcp-4003",
      taskId: "task-3001",
      replicaId: "rep-2005",
      locationId: "loc-tape-overseas",
      locationName: "异地磁带库 · 新加坡",
      attempt: 0,
      outcome: "skipped",
      at: "2026-11-06T09:26:00.000Z",
      message: "未执行：批次在热备副本失败后停止，等待重试",
    },
    {
      id: "rcp-4004",
      taskId: "task-3002",
      replicaId: "rep-2006",
      locationId: "loc-main-hz",
      locationName: "主集群 · 杭州",
      attempt: 1,
      outcome: "succeeded",
      at: "2026-10-28T10:14:00.000Z",
      message: "已确认移除：主集群 · 杭州 校验通过（演练，未触碰真实存储）",
    },
    {
      id: "rcp-4005",
      taskId: "task-3002",
      replicaId: "rep-2007",
      locationId: "loc-replica-sh",
      locationName: "热备副本 · 上海",
      attempt: 1,
      outcome: "succeeded",
      at: "2026-10-28T10:20:00.000Z",
      message: "已确认移除：热备副本 · 上海 校验通过（演练，未触碰真实存储）",
    },
    {
      id: "rcp-4009",
      taskId: "task-3005",
      replicaId: "rep-2012",
      locationId: "loc-main-hz",
      locationName: "主集群 · 杭州",
      attempt: 1,
      outcome: "succeeded",
      at: "2026-11-09T15:47:00.000Z",
      message: "已确认移除：主集群 · 杭州 校验通过（演练，未触碰真实存储）",
    },
    {
      id: "rcp-4010",
      taskId: "task-3005",
      replicaId: "rep-2013",
      locationId: "loc-replica-sh",
      locationName: "热备副本 · 上海",
      attempt: 1,
      outcome: "succeeded",
      at: "2026-11-09T15:52:00.000Z",
      message: "已确认移除：热备副本 · 上海 校验通过（演练，未触碰真实存储）",
    },
    {
      id: "rcp-4007",
      taskId: "task-3004",
      replicaId: "rep-2014",
      locationId: "loc-main-hz",
      locationName: "主集群 · 杭州",
      attempt: 1,
      outcome: "succeeded",
      at: "2026-11-08T14:26:00.000Z",
      message: "已确认移除：主集群 · 杭州 校验通过（演练，未触碰真实存储）",
    },
    {
      id: "rcp-4008",
      taskId: "task-3004",
      replicaId: "rep-2015",
      locationId: "loc-replica-sh",
      locationName: "热备副本 · 上海",
      attempt: 1,
      outcome: "succeeded",
      at: "2026-11-08T14:31:00.000Z",
      message: "已确认移除：热备副本 · 上海 校验通过（演练，未触碰真实存储）",
    },
  ];

  const holds: LegalHold[] = [
    {
      id: "hold-6001",
      replicaId: "rep-2010",
      versionId: "ver-1004",
      reason: "监管问询留存（案号 2026-L-0912）",
      openedAt: "2026-11-02T16:05:00.000Z",
      releasedAt: null,
    },
    {
      id: "hold-6002",
      replicaId: "rep-2011",
      versionId: "ver-1004",
      reason: "内部合规调查冻结",
      openedAt: "2026-11-02T16:05:00.000Z",
      releasedAt: null,
    },
  ];

  const audit: AuditEntry[] = [
    {
      id: "aud-7001",
      at: "2026-10-28T10:28:00.000Z",
      actor: "演练执行器",
      action: "演练未完成",
      detail: "任务 task-3002：2/3 确认；未确认来源：归档库 · 深圳（尚未执行）",
    },
    {
      id: "aud-7002",
      at: "2026-11-02T16:05:00.000Z",
      actor: "合规官",
      action: "施加法律保留",
      detail: "工单附件池 2026.3 / 热备副本 · 上海：监管问询留存（案号 2026-L-0912）",
    },
    {
      id: "aud-7003",
      at: "2026-11-02T16:05:00.000Z",
      actor: "合规官",
      action: "施加法律保留",
      detail: "工单附件池 2026.3 / 冷存储 · 北京：内部合规调查冻结",
    },
    {
      id: "aud-7004",
      at: "2026-11-06T09:26:00.000Z",
      actor: "演练执行器",
      action: "演练未完成",
      detail: "任务 task-3001：1/3 确认；未确认来源：热备副本 · 上海（执行失败）；异地磁带库 · 新加坡（尚未执行）",
    },
    {
      id: "aud-7005",
      at: "2026-11-10T11:30:00.000Z",
      actor: "运营控制台",
      action: "发现新副本",
      detail: "供应商对账底稿 2026-10 在 归档库 · 深圳 发现新副本 rep-2016，已并入任务 task-3004 并重新待办",
    },
    {
      id: "aud-7006",
      at: "2026-11-12T09:05:00.000Z",
      actor: "运营控制台",
      action: "删除请求复用",
      detail: "交易流水归档 2025-Q2 重复请求复用任务 task-3001，未清空原回执",
    },
  ];

  return {
    clock: T0,
    seq: 0,
    locations: LOCATIONS,
    versions,
    replicas,
    holds,
    tasks,
    receipts,
    audit,
  };
}
