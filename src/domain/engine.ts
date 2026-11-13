import { addDays, expiryFor, retentionStatus } from "./time";
import type {
  AuditEntry,
  DatasetVersion,
  DeletionTask,
  IsoDate,
  LegalHold,
  Replica,
  ReplicaKind,
  ReplicaState,
  Receipt,
  SnapshotData,
  StorageLocation,
  TaskEvent,
  TrackerState,
} from "./types";

/* ------------------------------------------------------------------------- */
/* 基础工具                                                                   */
/* ------------------------------------------------------------------------- */

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 模拟时钟下的时间戳：日期取模拟日，时刻按动作序号递增，保证审计顺序稳定。 */
function stamp(state: TrackerState): string {
  const total = 8 * 3600 + state.seq * 11;
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${state.clock}T${pad(h)}:${pad(m)}:${pad(s)}.000Z`;
}

function allocId(state: TrackerState, prefix: string): string {
  state.seq += 1;
  return `${prefix}-${8000 + state.seq}`;
}

function audit(
  state: TrackerState,
  action: string,
  detail: string,
  actor = "运营控制台",
): AuditEntry {
  const entry: AuditEntry = {
    id: allocId(state, "aud"),
    at: stamp(state),
    actor,
    action,
    detail,
  };
  state.audit.push(entry);
  return entry;
}

function taskEvent(
  state: TrackerState,
  task: DeletionTask,
  type: TaskEvent["type"],
  detail: string,
): TaskEvent {
  const entry: TaskEvent = { id: allocId(state, "evt"), at: stamp(state), type, detail };
  task.events.push(entry);
  return entry;
}

function expiryOfVersion(version: DatasetVersion): IsoDate {
  return expiryFor(version.createdAt, version.retentionDays);
}

function replicasOf(state: TrackerState, versionId: string): Replica[] {
  return state.replicas.filter((r) => r.versionId === versionId);
}

function holdsOf(state: TrackerState): LegalHold[] {
  return state.holds.filter((h) => h.releasedAt === null);
}

function activeHoldFor(state: TrackerState, replicaId: string): LegalHold | undefined {
  return holdsOf(state).find((h) => h.replicaId === replicaId);
}

function isHeld(state: TrackerState, replicaId: string): boolean {
  return activeHoldFor(state, replicaId) !== undefined;
}

export function latestReceiptForReplica(
  state: TrackerState,
  taskId: string,
  replicaId: string,
): Receipt | undefined {
  const rows = state.receipts.filter((r) => r.taskId === taskId && r.replicaId === replicaId);
  return rows.sort((a, b) => a.attempt - b.attempt || a.at.localeCompare(b.at)).at(-1);
}

/** 某版本当前未取消、最近建立的任务（含已完成，用于幂等复用）。 */
export function activeTaskFor(
  state: TrackerState,
  versionId: string,
): DeletionTask | undefined {
  return state.tasks
    .filter((t) => t.versionId === versionId && t.status !== "cancelled")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .at(-1);
}

export function allTasksFor(state: TrackerState, versionId: string): DeletionTask[] {
  return state.tasks
    .filter((t) => t.versionId === versionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export interface UnconfirmedReason {
  replicaId: string;
  locationId: string;
  locationName: string;
  state: ReplicaState;
  reason: string;
}

export interface TaskCoverage {
  taskId: string;
  total: number;
  confirmed: number;
  held: number;
  unconfirmed: UnconfirmedReason[];
  /** 全部当前副本都已拿到成功回执（不含法律保留副本） */
  fullyConfirmed: boolean;
}

const REASON_LABEL: Record<ReplicaState, string> = {
  pending: "尚未执行",
  discovered: "新发现副本，尚未排入执行",
  deleting: "执行中",
  failed: "执行失败，未确认",
  deleted: "已确认移除",
  held: "法律保留，禁止执行",
};

/** 任务覆盖度：严格按"版本当前副本"计算，新增副本会自然拉低覆盖度。 */
export function taskCoverage(state: TrackerState, taskId: string): TaskCoverage {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      taskId,
      total: 0,
      confirmed: 0,
      held: 0,
      unconfirmed: [],
      fullyConfirmed: false,
    };
  }
  // 覆盖度按"该版本登记过的全部副本"计算：已确认移除的副本不会从分母消失，
  // 这样后来发现的新副本一定会拉低覆盖度，而已完成的副本也不会被悄悄抹掉。
  const current = replicasOf(state, task.versionId);
  const unconfirmed: UnconfirmedReason[] = [];
  let confirmed = 0;
  let held = 0;

  for (const replica of current) {
    const loc = state.locations.find((l) => l.id === replica.locationId);
    const heldNow = isHeld(state, replica.id);
    const latest = latestReceiptForReplica(state, task.id, replica.id);

    if (heldNow) {
      held += 1;
      unconfirmed.push({
        replicaId: replica.id,
        locationId: replica.locationId,
        locationName: loc?.name ?? replica.locationId,
        state: "held",
        reason: REASON_LABEL.held,
      });
      continue;
    }
    if (latest?.outcome === "succeeded" || replica.state === "deleted") {
      confirmed += 1;
      continue;
    }
    let reason = REASON_LABEL[replica.state];
    if (!task.targetReplicaIds.includes(replica.id)) {
      reason = "不在任务目标中，需重新排期";
    } else if (latest?.outcome === "failed") {
      reason = `执行失败：${latest.message}`;
    }
    unconfirmed.push({
      replicaId: replica.id,
      locationId: replica.locationId,
      locationName: loc?.name ?? replica.locationId,
      state: replica.state,
      reason,
    });
  }

  return {
    taskId: task.id,
    total: current.length,
    confirmed,
    held,
    unconfirmed,
    fullyConfirmed: unconfirmed.length === 0,
  };
}

/** 根据覆盖度同步任务状态。canceled 与执行中的任务保持原状，由调用方控制。 */
function syncTask(state: TrackerState, task: DeletionTask): void {
  if (task.status === "cancelled" || task.isRunning) return;
  const coverage = taskCoverage(state, task.id);
  if (!task.targetReplicaIds.length) {
    task.status = "completed";
    return;
  }
  if (coverage.fullyConfirmed) {
    task.status = "completed";
    return;
  }
  const hasFailure = coverage.unconfirmed.some(
    (u) =>
      u.state === "failed" ||
      u.reason.startsWith("执行失败"),
  );
  if (hasFailure) {
    task.status = "failed";
    return;
  }
  if (coverage.held > 0 && coverage.unconfirmed.every((u) => u.state === "held")) {
    task.status = "held";
    return;
  }
  task.status = "planned";
}

function syncAllTasks(state: TrackerState, versionId?: string): void {
  for (const task of state.tasks) {
    if (versionId && task.versionId !== versionId) continue;
    syncTask(state, task);
  }
}

/* ------------------------------------------------------------------------- */
/* 操作                                                                       */
/* ------------------------------------------------------------------------- */

export interface Notice {
  level: "ok" | "warn" | "error";
  message: string;
}

export interface OpResult {
  state: TrackerState;
  notice: Notice;
}

function mutate(state: TrackerState, fn: (draft: TrackerState) => Notice): OpResult {
  const draft = clone(state);
  const notice = fn(draft);
  syncAllTasks(draft);
  return { state: draft, notice };
}

export interface ImportInput {
  datasetName: string;
  datasetId: string;
  versionLabel: string;
  createdAt: IsoDate;
  retentionDays: number;
  recordCount: number;
  locationIds: string[];
}

/** 导入虚构数据集：为每个选定存储位置生成一个副本。 */
export function importDataset(state: TrackerState, input: ImportInput): OpResult {
  return mutate(state, (draft) => {
    const name = input.datasetName.trim();
    if (!name || !input.versionLabel.trim()) {
      return { level: "error", message: "数据集名称与版本标识不能为空" };
    }
    if (!Number.isFinite(input.retentionDays) || input.retentionDays <= 0) {
      return { level: "error", message: "保留期限必须为正整数天数" };
    }
    if (!input.locationIds.length) {
      return { level: "error", message: "至少选择一个副本存储位置" };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.createdAt)) {
      return { level: "error", message: "创建日期格式应为 YYYY-MM-DD" };
    }
    const versionId = allocId(draft, "ver");
    const version: DatasetVersion = {
      id: versionId,
      datasetId: input.datasetId || `ds-${versionId}`,
      datasetName: name,
      versionLabel: input.versionLabel.trim(),
      createdAt: input.createdAt,
      recordCount: Math.max(0, Math.round(input.recordCount)),
      retentionDays: Math.round(input.retentionDays),
      retentionChanges: [],
    };
    draft.versions.push(version);

    for (const locId of input.locationIds) {
      const loc = draft.locations.find((l) => l.id === locId);
      if (!loc) continue;
      const kind: ReplicaKind =
        loc.id.includes("main") ? "primary"
        : loc.id.includes("vault") || loc.id.includes("offsite") ? "backup"
        : loc.id.includes("tape") || loc.id.includes("archive") ? "archive"
        : "export";
      draft.replicas.push({
        id: allocId(draft, "rep"),
        versionId,
        locationId: locId,
        kind,
        state: "pending",
        observedAt: stamp(draft),
        stateBeforeHold: null,
        lastReceiptId: null,
        faultInjected: false,
      });
    }

    // 若导入的是已到期版本，待办由"即将过期 / 待处理"列表承载，由用户显式请求排期。
    const expiry = expiryOfVersion(version);

    audit(
      draft,
      "导入数据集",
      `「${name} ${version.versionLabel}」导入 ${input.locationIds.length} 个存储位置，保留 ${version.retentionDays} 天，到期日 ${expiry}`,
    );
    return {
      level: "ok",
      message: `已导入「${name} ${version.versionLabel}」（${input.locationIds.length} 个副本位置）`,
    };
  });
}

function createTask(
  state: TrackerState,
  version: DatasetVersion,
  reason: string,
  actor = "运营控制台",
): DeletionTask {
  const targets = replicasOf(state, version.id)
    .filter((r) => r.state !== "deleted")
    .map((r) => r.id);
  const task: DeletionTask = {
    id: allocId(state, "task"),
    versionId: version.id,
    targetReplicaIds: targets,
    plannedExpiry: expiryOfVersion(version),
    status: "planned",
    isRunning: false,
    createdAt: stamp(state),
    cancelledAt: null,
    cancelReason: null,
    receiptIds: [],
    events: [],
    requestKey: `${version.id}|${[...targets].sort().join(",")}`,
    requestCount: 1,
  };
  state.tasks.push(task);
  taskEvent(
    state,
    task,
    "created",
    `${reason}；目标副本 ${targets.length} 个，计划依据到期日 ${task.plannedExpiry}`,
  );
  audit(
    state,
    "建立删除计划",
    `「${version.datasetName} ${version.versionLabel}」生成任务 ${task.id}，目标 ${targets.length} 个副本，计划到期日 ${task.plannedExpiry}`,
    actor,
  );
  return task;
}

/**
 * 删除请求：幂等。同一版本已有未取消任务时复用；重复到达只累加请求次数并留痕。
 * 期间发现的副本会并入同一任务，原回执保留可查。
 */
export function requestDeletion(
  state: TrackerState,
  versionId: string,
  actor = "运营控制台",
): OpResult {
  return mutate(state, (draft) => {
    const version = draft.versions.find((v) => v.id === versionId);
    if (!version) return { level: "error", message: "数据版本不存在" };
    const current = replicasOf(draft, version.id);
    if (!current.length) return { level: "error", message: "该版本没有登记任何副本，无可处置对象" };
    const active = activeTaskFor(draft, version.id);

    if (active) {
      const missing = current.filter(
        (r) => r.state !== "deleted" && !active.targetReplicaIds.includes(r.id),
      );
      for (const replica of missing) {
        active.targetReplicaIds.push(replica.id);
        if (replica.state === "discovered") replica.state = "pending";
        taskEvent(
          draft,
          active,
          "replica-added",
          `新副本并入复用任务：${draft.locations.find((l) => l.id === replica.locationId)?.name ?? replica.locationId}`,
        );
      }
      active.requestCount += 1;
      active.requestKey = `${version.id}|${[...active.targetReplicaIds].sort().join(",")}`;
      if (active.status === "completed" && missing.length) active.status = "planned";
      taskEvent(
        draft,
        active,
        "reused-request",
        `重复请求复用任务 ${active.id}（第 ${active.requestCount} 次请求${missing.length ? `，并入 ${missing.length} 个新副本` : "，副本集合未变"}）`,
      );
      audit(
        draft,
        "删除请求复用",
        `「${version.datasetName} ${version.versionLabel}」重复请求复用任务 ${active.id}，未清空原回执`,
        actor,
      );
      const coverage = taskCoverage(draft, active.id);
      return {
        level: "ok",
        message: coverage.fullyConfirmed
          ? `复用任务 ${active.id}：全部 ${coverage.total} 个副本均已确认，无需重复执行`
          : `复用任务 ${active.id}：当前 ${coverage.confirmed}/${coverage.total} 个副本已确认`,
      };
    }

    const task = createTask(draft, version, "删除请求到达，按当前期限排期", actor);
    if (task.status === "completed") {
      return { level: "ok", message: "该版本没有待处置副本" };
    }
    return {
      level: "ok",
      message: `已建立任务 ${task.id}，目标 ${task.targetReplicaIds.length} 个副本，计划到期日 ${task.plannedExpiry}`,
    };
  });
}

/**
 * 延长保留期：记录变更历史，并取消尚未执行的计划（含受保留阻断但从未执行的计划），
 * 取消原因与原计划到期日一并留痕。已执行过的任务不取消（其回执不能被抹掉）。
 */
export function extendRetention(
  state: TrackerState,
  versionId: string,
  nextDays: number,
  note = "保留期延长",
): OpResult {
  return mutate(state, (draft) => {
    const version = draft.versions.find((v) => v.id === versionId);
    if (!version) return { level: "error", message: "数据版本不存在" };
    if (!Number.isFinite(nextDays) || nextDays <= version.retentionDays) {
      return {
        level: "error",
        message: `新期限需大于当前 ${version.retentionDays} 天（本次仅支持延长）`,
      };
    }
    if (draft.tasks.some((t) => t.versionId === versionId && t.isRunning)) {
      return { level: "error", message: "该版本正在执行演练，完成后再延长期限" };
    }
    const previous = version.retentionDays;
    version.retentionDays = Math.round(nextDays);
    const change = {
      id: allocId(draft, "chg"),
      versionId,
      previousDays: previous,
      nextDays: Math.round(nextDays),
      effectiveAt: draft.clock,
      recordedAt: stamp(draft),
      note,
    };
    version.retentionChanges.push(change);

    const cancelled: string[] = [];
    for (const task of draft.tasks) {
      if (task.versionId !== versionId) continue;
      const unexecuted =
      task.receiptIds.length === 0 && !task.isRunning && task.status !== "cancelled";
      if (!unexecuted) continue;
      task.status = "cancelled";
      task.cancelledAt = stamp(draft);
      task.cancelReason = `保留期由 ${previous} 天延长至 ${change.nextDays} 天，原计划到期日 ${task.plannedExpiry} 已失效`;
      taskEvent(draft, task, "cancelled", task.cancelReason);
      cancelled.push(task.id);
    }

    audit(
      draft,
      "延长保留期",
      `「${version.datasetName} ${version.versionLabel}」保留期 ${previous} → ${change.nextDays} 天，新到期日 ${expiryOfVersion(version)}${
        cancelled.length ? `；取消未执行计划 ${cancelled.join("、")}` : "；无未执行计划需取消"
      }`,
    );
    return {
      level: "ok",
      message: cancelled.length
        ? `期限已延长至 ${change.nextDays} 天，取消计划 ${cancelled.join("、")} 并留痕`
        : `期限已延长至 ${change.nextDays} 天，未发现需取消的未执行计划`,
    };
  });
}

/** 后来发现新副本：并入现有任务并重新待办（若任务已完成则重开）。 */
export function discoverReplica(
  state: TrackerState,
  versionId: string,
  locationId: string,
): OpResult {
  return mutate(state, (draft) => {
    const version = draft.versions.find((v) => v.id === versionId);
    if (!version) return { level: "error", message: "数据版本不存在" };
    const loc = draft.locations.find((l) => l.id === locationId);
    if (!loc) return { level: "error", message: "存储位置不存在" };
    if (replicasOf(draft, versionId).some((r) => r.locationId === locationId)) {
      return { level: "error", message: `${loc.name} 已有该版本的副本记录` };
    }
    const replica: Replica = {
      id: allocId(draft, "rep"),
      versionId,
      locationId,
      kind: loc.id.includes("tape") || loc.id.includes("archive") ? "archive"
        : loc.id.includes("main") ? "primary" : "backup",
      state: "discovered",
      observedAt: stamp(draft),
      stateBeforeHold: null,
      lastReceiptId: null,
      faultInjected: false,
    };
    draft.replicas.push(replica);

    const active = activeTaskFor(draft, versionId);
    if (active) {
      replica.state = "pending";
      active.targetReplicaIds.push(replica.id);
      if (active.status === "completed") active.status = "planned";
      taskEvent(
        draft,
        active,
        "replica-added",
        `观测到新副本 ${loc.name}（${replica.id}），并入现有任务 ${active.id}，原回执保留`,
      );
    }

    audit(
      draft,
      "发现新副本",
      `「${version.datasetName} ${version.versionLabel}」在 ${loc.name} 发现新副本 ${replica.id}${
        active ? `，已并入任务 ${active.id} 并重新待办` : "，等待排期"
      }`,
    );
    return {
      level: "ok",
      message: active
        ? `新副本已并入任务 ${active.id}，该版本重新进入待办`
        : `已记录新副本（${loc.name}），等待排期`,
    };
  });
}

/** 对单个副本施加法律保留：立刻退出删除执行，直至解除。 */
export function placeHold(
  state: TrackerState,
  replicaId: string,
  reason: string,
): OpResult {
  return mutate(state, (draft) => {
    const replica = draft.replicas.find((r) => r.id === replicaId);
    if (!replica) return { level: "error", message: "副本不存在" };
    if (replica.state === "deleted") {
      return { level: "error", message: "该副本已确认移除，无法施加保留" };
    }
    if (isHeld(draft, replicaId)) {
      return { level: "error", message: "该副本已处于法律保留" };
    }
    const version = draft.versions.find((v) => v.id === replica.versionId);
    const loc = draft.locations.find((l) => l.id === replica.locationId);
    replica.stateBeforeHold = replica.state;
    replica.state = "held";
    const hold: LegalHold = {
      id: allocId(draft, "hold"),
      replicaId,
      versionId: replica.versionId,
      reason: reason.trim() || "法律保留（未填写案由）",
      openedAt: stamp(draft),
      releasedAt: null,
    };
    draft.holds.push(hold);
    const task = activeTaskFor(draft, replica.versionId);
    if (task) {
      taskEvent(
        draft,
        task,
        "held",
        `${loc?.name ?? replica.locationId} 副本进入法律保留，不参与本次执行`,
      );
    }
    audit(
      draft,
      "施加法律保留",
      `${version?.datasetName ?? replica.versionId} / ${loc?.name ?? replica.locationId}：${hold.reason}`,
    );
    return {
      level: "warn",
      message: `${loc?.name ?? replica.locationId} 已进入法律保留，将该副本排除在删除执行之外`,
    };
  });
}

/**
 * 解除法律保留：副本退出 held 状态；若该版本已到期，按"当前期限"生成新的待办计划
 * （不复用延长前取消的旧计划）。若已有活动任务，则把副本并回该任务。
 */
export function releaseHold(
  state: TrackerState,
  holdId: string,
  note = "法律保留解除",
): OpResult {
  return mutate(state, (draft) => {
    const hold = draft.holds.find((h) => h.id === holdId);
    if (!hold) return { level: "error", message: "保留记录不存在" };
    if (hold.releasedAt) return { level: "error", message: "该保留已解除" };
    const replica = draft.replicas.find((r) => r.id === hold.replicaId);
    if (!replica) return { level: "error", message: "副本不存在" };
    hold.releasedAt = stamp(draft);
    replica.state = replica.stateBeforeHold ?? "pending";
    replica.stateBeforeHold = null;

    const version = draft.versions.find((v) => v.id === hold.versionId);
    const loc = draft.locations.find((l) => l.id === replica.locationId);
    const existing = activeTaskFor(draft, hold.versionId);
    let taskMessage = "";

    if (version) {
      const due = expiryOfVersion(version) <= draft.clock;
      if (existing) {
        if (!existing.targetReplicaIds.includes(replica.id) && replica.state !== "deleted") {
          existing.targetReplicaIds.push(replica.id);
          if (existing.status === "completed") existing.status = "planned";
        }
        taskMessage = `并回现有任务 ${existing.id}`;
      } else if (due && replica.state !== "deleted") {
        const task = createTask(draft, version, "法律保留解除，按当前期限重新生成待办");
        taskMessage = `按当前到期日 ${task.plannedExpiry} 生成新任务 ${task.id}`;
      } else {
        taskMessage = due ? "副本已确认移除，无需待办" : "版本尚未到期，暂不排期";
      }
    }

    audit(
      draft,
      "解除法律保留",
      `${version?.datasetName ?? hold.versionId} / ${loc?.name ?? replica.locationId}：${note}；${taskMessage}`,
    );
    return { level: "ok", message: `保留已解除；${taskMessage}` };
  });
}

/** 演练故障注入开关：让某个副本在执行时必然失败，用于验证"任一副本失败不得显示完成"。 */
export function setFaultInjection(
  state: TrackerState,
  replicaId: string,
  on: boolean,
): OpResult {
  return mutate(state, (draft) => {
    const replica = draft.replicas.find((r) => r.id === replicaId);
    if (!replica) return { level: "error", message: "副本不存在" };
    replica.faultInjected = on;
    const loc = draft.locations.find((l) => l.id === replica.locationId);
    return {
      level: on ? "warn" : "ok",
      message: on
        ? `已为 ${loc?.name ?? replica.locationId} 注入演练故障，下一次执行将返回失败回执`
        : `${loc?.name ?? replica.locationId} 的演练故障已关闭`,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* 执行（模拟；不触碰任何真实存储）                                          */
/* ------------------------------------------------------------------------- */

/** 可执行副本：在任务目标中、未删除、未处于法律保留。 */
export function actionableReplicas(state: TrackerState, taskId: string): Replica[] {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return [];
  return replicasOf(state, task.versionId).filter(
    (r) =>
      task.targetReplicaIds.includes(r.id) &&
      r.state !== "deleted" &&
      !isHeld(state, r.id) &&
      latestReceiptForReplica(state, task.id, r.id)?.outcome !== "succeeded",
  );
}

export function beginRun(state: TrackerState, taskId: string, actor = "演练执行器"): OpResult {
  return mutate(state, (draft) => {
    const task = draft.tasks.find((t) => t.id === taskId);
    if (!task) return { level: "error", message: "任务不存在" };
    if (task.status === "cancelled") {
      return { level: "error", message: "任务已取消，请重新发起删除请求" };
    }
    if (task.isRunning) return { level: "error", message: "任务正在执行中" };
    const actionable = actionableReplicas(draft, taskId);
    if (!actionable.length) {
      return { level: "error", message: "没有可执行的副本（可能已全部确认或均处于法律保留）" };
    }
    task.isRunning = true;
    task.status = "running";
    for (const r of actionable) r.state = "deleting";
    taskEvent(
      draft,
      task,
      "started",
      `开始第 ${task.events.filter((e) => e.type === "started").length + 1} 次执行，${actionable.length} 个副本`,
    );
    audit(
      draft,
      "开始删除演练",
      `任务 ${task.id}：${actionable.length} 个副本（模拟执行，未连接真实存储）`,
      actor,
    );
    return { level: "ok", message: `开始执行 ${actionable.length} 个副本` };
  });
}

/** 执行单个副本，生成一条该存储位置专属回执。失败历史只追加，不覆盖。 */
export function executeAttempt(
  state: TrackerState,
  taskId: string,
  replicaId: string,
): OpResult {
  return mutate(state, (draft) => {
    const task = draft.tasks.find((t) => t.id === taskId);
    if (!task) return { level: "error", message: "任务不存在" };
    if (!task.isRunning) return { level: "error", message: "任务不在执行状态" };
    const replica = draft.replicas.find((r) => r.id === replicaId);
    if (!replica) return { level: "error", message: "副本不存在" };
    if (isHeld(draft, replicaId)) {
      return { level: "error", message: "副本处于法律保留，拒绝执行" };
    }
    const loc = draft.locations.find((l) => l.id === replica.locationId);
    const prior = draft.receipts.filter(
      (r) => r.taskId === taskId && r.replicaId === replicaId,
    );
    const attempt = prior.length + 1;
    const failed = replica.faultInjected || replica.state === "held";
    const receipt: Receipt = {
      id: allocId(draft, "rcp"),
      taskId,
      replicaId,
      locationId: replica.locationId,
      locationName: loc?.name ?? replica.locationId,
      attempt,
      outcome: failed ? "failed" : "succeeded",
      at: stamp(draft),
      message: failed
        ? `拒绝移除：${loc?.name ?? replica.locationId} 演练故障注入，未取得确认`
        : `已确认移除：${loc?.name ?? replica.locationId} 校验通过（演练，未触碰真实存储）`,
    };
    draft.receipts.push(receipt);
    task.receiptIds.push(receipt.id);
    replica.lastReceiptId = receipt.id;
    replica.state = failed ? "failed" : "deleted";
    if (failed && !task.events.some((e) => e.type === "failed" && e.detail.includes(receipt.id))) {
      taskEvent(
        draft,
        task,
        "failed",
        `${receipt.locationName} 第 ${attempt} 次执行失败（回执 ${receipt.id}），失败历史保留`,
      );
    }
    return {
      level: failed ? "warn" : "ok",
      message: `${receipt.locationName}：${receipt.outcome === "failed" ? "失败回执已记录" : "成功回执已记录"}`,
    };
  });
}

/** 收尾：按当前副本覆盖度判定状态。只有全部副本确认才 completed。 */
export function finishRun(state: TrackerState, taskId: string): OpResult {
  return mutate(state, (draft) => {
    const task = draft.tasks.find((t) => t.id === taskId);
    if (!task) return { level: "error", message: "任务不存在" };
    task.isRunning = false;
    for (const replica of replicasOf(draft, task.versionId)) {
      if (replica.state === "deleting") replica.state = "pending";
    }
    const coverage = taskCoverage(draft, task.id);
    if (coverage.fullyConfirmed) {
      taskEvent(
        draft,
        task,
        "completed",
        `全部 ${coverage.total} 个当前副本均已取得成功回执，任务完成`,
      );
      audit(
        draft,
        "演练完成",
        `任务 ${task.id}：${coverage.total}/${coverage.total} 个副本确认，方可显示完成`,
      );
    } else {
      const names = coverage.unconfirmed.map((u) => `${u.locationName}（${u.reason}）`);
      taskEvent(
        draft,
        task,
        "failed",
        `未完成：仍有 ${coverage.unconfirmed.length} 个副本未确认 —— ${names.join("；")}`,
      );
      audit(
        draft,
        "演练未完成",
        `任务 ${task.id}：${coverage.confirmed}/${coverage.total} 确认；未确认来源：${names.join("；")}`,
      );
    }
    syncTask(draft, task);
    return {
      level: coverage.fullyConfirmed ? "ok" : "warn",
      message: coverage.fullyConfirmed
        ? "全部当前副本已确认，任务完成"
        : `未完成：仍有 ${coverage.unconfirmed.length} 个副本未确认`,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* 派生视图                                                                   */
/* ------------------------------------------------------------------------- */

export interface VersionView {
  version: DatasetVersion;
  expiry: IsoDate;
  daysLeft: number;
  urgency: ReturnType<typeof retentionStatus>["urgency"];
  replicas: Replica[];
  task: DeletionTask | undefined;
  latestTask: DeletionTask | undefined;
  coverage: TaskCoverage | undefined;
  heldCount: number;
  discoveredCount: number;
  failedCount: number;
  cleared: boolean;
  label: string;
}

export function versionView(state: TrackerState, version: DatasetVersion): VersionView {
  const expiry = expiryOfVersion(version);
  const status = retentionStatus(version.createdAt, version.retentionDays, state.clock);
  const replicas = replicasOf(state, version.id);
  const task = activeTaskFor(state, version.id);
  const latestTask = allTasksFor(state, version.id).at(-1);
  const coverage = task ? taskCoverage(state, task.id) : undefined;
  const heldCount = replicas.filter((r) => isHeld(state, r.id)).length;
  const discoveredCount = replicas.filter((r) => r.state === "discovered").length;
  const failedCount = replicas.filter((r) => r.state === "failed").length;
  const cleared = replicas.length > 0 && replicas.every((r) => r.state === "deleted");

  let label: string;
  if (cleared) label = "已清空";
  else if (heldCount > 0) label = "法律保留阻断";
  else if (task?.status === "completed") label = "已完成";
  else if (task?.status === "failed") label = "执行未完成";
  else if (task?.status === "running") label = "执行中";
  else if (task?.status === "planned") label = "计划待执行";
  else if (task?.status === "cancelled") label = "计划已取消";
  else if (latestTask?.status === "cancelled") label = "计划已取消";
  else label = expiry <= state.clock ? "待排期" : "未到期";

  return {
    version,
    expiry,
    daysLeft: status.daysLeft,
    urgency: status.urgency,
    replicas,
    task,
    latestTask,
    coverage,
    heldCount,
    discoveredCount,
    failedCount,
    cleared,
    label,
  };
}

export interface PendingItem {
  replica: Replica;
  version: DatasetVersion;
  location: StorageLocation | undefined;
  expiry: IsoDate;
  daysLeft: number;
  reason: string;
  blocked: boolean;
}

/**
 * 待处理项 = 到期版本（含已过期/今日到期）上尚未确认的副本；
 * 以及任何版本上"后来发现"的副本（即使尚未到期，也进入待办观察）。
 */
export function pendingItems(state: TrackerState): PendingItem[] {
  const items: PendingItem[] = [];
  for (const version of state.versions) {
    const expiry = expiryOfVersion(version);
    const due = expiry <= state.clock;
    const status = retentionStatus(version.createdAt, version.retentionDays, state.clock);
    for (const replica of replicasOf(state, version.id)) {
      if (replica.state === "deleted") continue;
      const held = isHeld(state, replica.id);
      const actionable = due || replica.state === "discovered";
      if (!actionable && !held) continue;
      if (!actionable && held) continue; // 未到期且保留中的副本暂不待办
      const loc = state.locations.find((l) => l.id === replica.locationId);
      let reason: string;
      if (held) reason = "法律保留，禁止执行";
      else if (replica.state === "discovered") reason = "后来发现的新副本，待并入任务";
      else if (replica.state === "failed") reason = "上次执行失败，待重试";
      else reason = "尚未执行";
      items.push({
        replica,
        version,
        location: loc,
        expiry,
        daysLeft: status.daysLeft,
        reason,
        blocked: held,
      });
    }
  }
  return items.sort(
    (a, b) =>
      a.expiry.localeCompare(b.expiry) ||
      a.version.datasetName.localeCompare(b.version.datasetName),
  );
}

export interface UpcomingItem {
  view: VersionView;
}

/** 即将过期：14 天内到期（含已过期），且尚未清空的版本。 */
export function upcomingVersions(state: TrackerState, horizonDays = 14): VersionView[] {
  return state.versions
    .map((v) => versionView(state, v))
    .filter((view) => view.daysLeft <= horizonDays && !view.cleared)
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

export interface TimelineEntry {
  id: string;
  at: string;
  kind: "audit" | "task" | "receipt" | "retention" | "hold";
  title: string;
  detail: string;
  tone: "neutral" | "good" | "warning" | "critical";
  versionId?: string;
}

export function timeline(state: TrackerState, versionId?: string): TimelineEntry[] {
  const rows: TimelineEntry[] = [];
  for (const entry of state.audit) {
    if (versionId) continue;
    rows.push({
      id: entry.id,
      at: entry.at,
      kind: "audit",
      title: entry.action,
      detail: `${entry.detail} · ${entry.actor}`,
      tone: auditTone(entry.action),
    });
  }
  for (const version of state.versions) {
    if (versionId && version.id !== versionId) continue;
    for (const change of version.retentionChanges) {
      rows.push({
        id: change.id,
        at: change.recordedAt,
        kind: "retention",
        title: "保留期延长",
        detail: `${version.datasetName} ${version.versionLabel}：${change.previousDays} → ${change.nextDays} 天（生效 ${change.effectiveAt}）· ${change.note}`,
        tone: "warning",
        versionId: version.id,
      });
    }
    for (const task of allTasksFor(state, version.id)) {
      for (const event of task.events) {
        rows.push({
          id: event.id,
          at: event.at,
          kind: "task",
          title: `任务 ${task.id} · ${taskEventTitle(event.type)}`,
          detail: event.detail,
          tone:
            event.type === "failed" ? "critical"
            : event.type === "completed" ? "good"
            : event.type === "cancelled" || event.type === "held" ? "warning"
            : "neutral",
          versionId: version.id,
        });
      }
    }
  }
  for (const hold of state.holds) {
    if (versionId && hold.versionId !== versionId) continue;
    rows.push({
      id: `${hold.id}-open`,
      at: hold.openedAt,
      kind: "hold",
      title: "施加法律保留",
      detail: hold.reason,
      tone: "warning",
      versionId: hold.versionId,
    });
    if (hold.releasedAt) {
      rows.push({
        id: `${hold.id}-close`,
        at: hold.releasedAt,
        kind: "hold",
        title: "解除法律保留",
        detail: `保留记录 ${hold.id} 解除`,
        tone: "neutral",
        versionId: hold.versionId,
      });
    }
  }
  for (const receipt of state.receipts) {
    const task = state.tasks.find((t) => t.id === receipt.taskId);
    if (versionId && task?.versionId !== versionId) continue;
    rows.push({
      id: receipt.id,
      at: receipt.at,
      kind: "receipt",
      title: `${receipt.locationName} 回执 · 第 ${receipt.attempt} 次`,
      detail: receipt.message,
      tone: receipt.outcome === "succeeded" ? "good" : "critical",
      versionId: task?.versionId,
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

function auditTone(action: string): TimelineEntry["tone"] {
  if (action.includes("未完成") || action.includes("失败")) return "critical";
  if (action.includes("完成")) return "good";
  if (action.includes("保留") || action.includes("延长") || action.includes("取消")) return "warning";
  return "neutral";
}

function taskEventTitle(type: TaskEvent["type"]): string {
  switch (type) {
    case "created": return "计划建立";
    case "reused-request": return "重复请求复用";
    case "replica-added": return "副本并入";
    case "cancelled": return "计划取消";
    case "started": return "开始执行";
    case "failed": return "执行未完成";
    case "completed": return "确认完成";
    case "held": return "法律保留";
    case "released": return "保留解除";
  }
}

/* ------------------------------------------------------------------------- */
/* 快照 / 导入导出                                                            */
/* ------------------------------------------------------------------------- */

export function toSnapshot(state: TrackerState, label: string): SnapshotData {
  return {
    id: `snap-${state.seq}`,
    label,
    takenAt: `${state.clock}T12:00:00.000Z`,
    clock: state.clock,
    versions: clone(state.versions),
    replicas: clone(state.replicas),
    tasks: clone(state.tasks),
    receipts: clone(state.receipts),
    holds: clone(state.holds),
  };
}

export function setClock(state: TrackerState, clock: IsoDate): OpResult {
  return mutate(state, (draft) => {
    const previous = draft.clock;
    draft.clock = clock;
    audit(draft, "调整模拟时钟", `模拟日期 ${previous} → ${clock}`);
    return { level: "ok", message: `模拟日期已设为 ${clock}` };
  });
}

export function advanceClock(state: TrackerState, days: number): OpResult {
  return setClock(state, addDays(state.clock, days));
}
