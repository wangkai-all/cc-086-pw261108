// 领域类型：只描述"数据版本—副本—删除计划—回执"这一层，不依赖任何 UI 或真实存储。

export type IsoDate = string; // YYYY-MM-DD（本地日历日，避免时区漂移）

export type ReplicaKind = "primary" | "backup" | "snapshot" | "archive" | "export";

/**
 * 副本的处置状态。
 * pending     等待处置
 * discovered  后来发现的新副本，尚未确认处置
 * deleting    本次执行中
 * failed      最近一次执行失败（历史回执仍保留）
 * deleted     所有回执确认已删除（模拟）
 * held        处于法律保留，不进入删除执行
 */
export type ReplicaState =
  | "pending"
  | "discovered"
  | "deleting"
  | "failed"
  | "deleted"
  | "held";

export interface Replica {
  id: string;
  /** 所属数据版本（版本是删除计划的唯一作用单位） */
  versionId: string;
  locationId: string;
  kind: ReplicaKind;
  state: ReplicaState;
  /** 观测到该副本存在的时刻（ISO 时间戳） */
  observedAt: string;
  /** 施加法律保留前的状态，用于解除后恢复 */
  stateBeforeHold: ReplicaState | null;
  /** 最近一次执行回执摘要 */
  lastReceiptId: string | null;
  /** 演练用的故障注入：该副本执行时必然失败，可在 UI 切换 */
  faultInjected: boolean;
}

export interface StorageLocation {
  id: string;
  name: string;
  region: string;
  /** 模拟的执行延迟（毫秒）：仅让批次进度在界面上可见 */
  latencyMs: number;
}

export interface LegalHold {
  id: string;
  replicaId: string;
  versionId: string;
  reason: string;
  openedAt: string;
  releasedAt: string | null;
}

export interface RetentionChange {
  id: string;
  versionId: string;
  previousDays: number;
  nextDays: number;
  /** 新期限生效日（通常为变更当日） */
  effectiveAt: IsoDate;
  recordedAt: string;
  note: string;
}

export interface DatasetVersion {
  id: string;
  datasetId: string;
  datasetName: string;
  versionLabel: string;
  createdAt: IsoDate;
  recordCount: number;
  /** 保留期（天）：到期日 = createdAt + retentionDays */
  retentionDays: number;
  retentionChanges: RetentionChange[];
}

export interface TaskEvent {
  id: string;
  at: string;
  type:
    | "created"
    | "reused-request"
    | "replica-added"
    | "started"
    | "cancelled"
    | "failed"
    | "completed"
    | "held"
    | "released";
  detail: string;
}

/** 一次删除执行请求。幂等：相同（版本 + 当前副本集合）的重复请求复用同一任务。 */
export interface DeletionTask {
  id: string;
  versionId: string;
  /** 任务建立时确定的当前副本集合（副本 id），后来发现的新副本会并入 */
  targetReplicaIds: string[];
  /** 任务建立时的计划到期日快照，用于说明"按哪个期限排的计划" */
  plannedExpiry: IsoDate;
  status: "planned" | "running" | "failed" | "completed" | "cancelled" | "held";
  isRunning: boolean;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** 每个副本的逐项结果（回执 id，按追加顺序） */
  receiptIds: string[];
  events: TaskEvent[];
  /** 最近一次请求的幂等键；重复到达时随之记录 */
  requestKey: string;
  requestCount: number;
}

/** 单个存储位置的回执。每一份都保留，重复执行只追加、不改写。 */
export interface Receipt {
  id: string;
  taskId: string;
  replicaId: string;
  locationId: string;
  locationName: string;
  attempt: number;
  outcome: "succeeded" | "failed" | "skipped";
  at: string;
  message: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface TrackerState {
  clock: IsoDate; // 当前模拟日期
  seq: number;
  locations: StorageLocation[];
  versions: DatasetVersion[];
  replicas: Replica[];
  holds: LegalHold[];
  tasks: DeletionTask[];
  receipts: Receipt[];
  audit: AuditEntry[];
}

export interface SnapshotData {
  id: string;
  label: string;
  takenAt: string;
  clock: IsoDate;
  versions: DatasetVersion[];
  replicas: Replica[];
  tasks: DeletionTask[];
  receipts: Receipt[];
  holds: LegalHold[];
}

export type Snapshot = SnapshotData;
