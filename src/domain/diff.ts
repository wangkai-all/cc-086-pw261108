import { expiryFor, formatTimestamp } from "./time";
import type { SnapshotData, TrackerState, TrackerState as _T } from "./types";

export type DiffKind = "added" | "removed" | "changed";

export interface DiffRow {
  key: string;
  scope: "version" | "replica" | "task" | "receipt" | "hold";
  objectLabel: string;
  field: string;
  before: string;
  after: string;
  kind: DiffKind;
}

type DiffInput = {
  key: string;
  scope: DiffRow["scope"];
  objectLabel: string;
  field: string;
  before: unknown;
  after: unknown;
  kind?: DiffKind;
};

function s(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join("、") : "—";
  return String(value);
}

function push(rows: DiffRow[], row: DiffInput): void {
  const before = s(row.before);
  const after = s(row.after);
  if (before === after && !row.kind) return;
  rows.push({
    ...row,
    before,
    after,
    kind:
      row.kind ??
      (before === "—" ? "added" : after === "—" ? "removed" : "changed"),
  });
}

/** 两组快照/当前状态之间的结构化差异。用于导出"变更差异"。 */
/** 差异表中的原始状态值统一转成中文，避免把内部枚举直接暴露给读者。 */
export function statusLabel(value: string): string {
  switch (value) {
    case "pending": return "待处置";
    case "deleted": return "已确认移除";
    case "failed": return "执行失败";
    case "held": return "法律保留";
    case "deleting": return "执行中";
    case "discovered": return "新发现";
    case "planned": return "计划待执行";
    case "completed": return "已完成";
    case "cancelled": return "已取消";
    case "held-by-law": return "法律保留";
    case "succeeded": return "成功";
    case "skipped": return "未执行";
    default: return value;
  }
}

export function diffStates(before: SnapshotData, after: SnapshotData): DiffRow[] {
  const rows: DiffRow[] = [];
  const a = {
    versions: new Map(before.versions.map((v) => [v.id, v])),
    replicas: new Map(before.replicas.map((r) => [r.id, r])),
    tasks: new Map(before.tasks.map((t) => [t.id, t])),
    receipts: new Map(before.receipts.map((r) => [r.id, r])),
    holds: new Map(before.holds.map((h) => [h.id, h])),
  };
  const b = {
    versions: new Map(after.versions.map((v) => [v.id, v])),
    replicas: new Map(after.replicas.map((r) => [r.id, r])),
    tasks: new Map(after.tasks.map((t) => [t.id, t])),
    receipts: new Map(after.receipts.map((r) => [r.id, r])),
    holds: new Map(after.holds.map((h) => [h.id, h])),
  };

  for (const [id, version] of b.versions) {
    const prev = a.versions.get(id);
    const label = `${version.datasetName} ${version.versionLabel}`;
    if (!prev) {
      rows.push({
        key: `version:${id}`,
        scope: "version",
        objectLabel: label,
        field: "数据版本",
        before: "—",
        after: "新增版本",
        kind: "added",
      });
      continue;
    }
    push(rows, {
      key: `version:${id}:retention`,
      scope: "version",
      objectLabel: label,
      field: "保留期（天）",
      before: prev.retentionDays,
      after: version.retentionDays,
    });
    push(rows, {
      key: `version:${id}:expiry`,
      scope: "version",
      objectLabel: label,
      field: "到期日",
      before: expiryFor(prev.createdAt, prev.retentionDays),
      after: expiryFor(version.createdAt, version.retentionDays),
    });
  }
  for (const [id, prev] of a.versions) {
    if (b.versions.has(id)) continue;
    rows.push({
      key: `version:${id}`,
      scope: "version",
      objectLabel: `${prev.datasetName} ${prev.versionLabel}`,
      field: "数据版本",
      before: "存在",
      after: "—",
      kind: "removed",
    });
  }

  for (const [id, replica] of b.replicas) {
    const prev = a.replicas.get(id);
    const label = `${replica.versionId} / ${replica.locationId}（${id}）`;
    if (!prev) {
      rows.push({
        key: `replica:${id}`,
        scope: "replica",
        objectLabel: label,
        field: "副本",
        before: "—",
        after: `新增，状态 ${statusLabel(replica.state)}`,
        kind: "added",
      });
      continue;
    }
    push(rows, {
      key: `replica:${id}:state`,
      scope: "replica",
      objectLabel: label,
      field: "处置状态",
      before: statusLabel(prev.state),
      after: statusLabel(replica.state),
    });
    const wasHeld = prev.state === "held";
    const isHeld = replica.state === "held";
    if (wasHeld !== isHeld) {
      rows.push({
        key: `replica:${id}:holder`,
        scope: "replica",
        objectLabel: label,
        field: "法律保留",
        before: wasHeld ? "保留中" : "未保留",
        after: isHeld ? "保留中" : "已解除",
        kind: "changed",
      });
    }
    if (prev.faultInjected !== replica.faultInjected) {
      rows.push({
        key: `replica:${id}:fault`,
        scope: "replica",
        objectLabel: label,
        field: "演练故障",
        before: prev.faultInjected ? "注入" : "关闭",
        after: replica.faultInjected ? "注入" : "关闭",
        kind: "changed",
      });
    }
  }

  for (const [id, task] of b.tasks) {
    const prev = a.tasks.get(id);
    if (!prev) {
      rows.push({
        key: `task:${id}`,
        scope: "task",
        objectLabel: `任务 ${id}`,
        field: "删除任务",
        before: "—",
        after: `新增，状态 ${statusLabel(task.status)}`,
        kind: "added",
      });
      continue;
    }
    push(rows, {
      key: `task:${id}:status`,
      scope: "task",
      objectLabel: `任务 ${id}`,
      field: "任务状态",
      before: statusLabel(prev.status),
      after: statusLabel(task.status),
    });
    push(rows, {
      key: `task:${id}:targets`,
      scope: "task",
      objectLabel: `任务 ${id}`,
      field: "目标副本",
      before: prev.targetReplicaIds,
      after: task.targetReplicaIds,
    });
    push(rows, {
      key: `task:${id}:requests`,
      scope: "task",
      objectLabel: `任务 ${id}`,
      field: "请求次数",
      before: prev.requestCount,
      after: task.requestCount,
    });
    push(rows, {
      key: `task:${id}:cancel`,
      scope: "task",
      objectLabel: `任务 ${id}`,
      field: "取消原因",
      before: prev.cancelReason ?? "—",
      after: task.cancelReason ?? "—",
    });
  }

  for (const [id, receipt] of b.receipts) {
    if (a.receipts.has(id)) continue;
    rows.push({
      key: `receipt:${id}`,
      scope: "receipt",
      objectLabel: `${receipt.locationName} · 第 ${receipt.attempt} 次（${id}）`,
      field: "回执",
      before: "—",
      after: `${statusLabel(receipt.outcome)}：${receipt.message}`,
      kind: "added",
    });
  }

  for (const [id, hold] of b.holds) {
    const prev = a.holds.get(id);
    const label = `保留 ${id} / ${hold.replicaId}`;
    if (!prev) {
      rows.push({
        key: `hold:${id}`,
        scope: "hold",
        objectLabel: label,
        field: "法律保留",
        before: "—",
        after: `新增：${hold.reason}`,
        kind: "added",
      });
      continue;
    }
    push(rows, {
      key: `hold:${id}:released`,
      scope: "hold",
      objectLabel: label,
      field: "解除时间",
      before: prev.releasedAt ? formatTimestamp(prev.releasedAt) : "未解除",
      after: hold.releasedAt ? formatTimestamp(hold.releasedAt) : "未解除",
    });
  }

  return rows;
}

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
}

export function countDiff(rows: DiffRow[]): DiffCounts {
  return rows.reduce<DiffCounts>(
    (acc, row) => {
      acc[row.kind] += 1;
      return acc;
    },
    { added: 0, removed: 0, changed: 0 },
  );
}

export function snapshotFromState(state: TrackerState, label = "当前状态"): SnapshotData {
  return {
    id: `snap-${state.seq}`,
    label,
    takenAt: `${state.clock}T12:00:00.000Z`,
    clock: state.clock,
    versions: structuredClone(state.versions),
    replicas: structuredClone(state.replicas),
    tasks: structuredClone(state.tasks),
    receipts: structuredClone(state.receipts),
    holds: structuredClone(state.holds),
  };
}

export function diffToCsv(rows: DiffRow[]): string {
  const header = ["范围", "对象", "字段", "变更前", "变更后", "类型"];
  const lines = [header.join(",")];
  const scopeLabel: Record<string, string> = {
    version: "数据版本",
    replica: "副本",
    task: "删除任务",
    receipt: "回执",
    hold: "法律保留",
  };
  const kindLabel: Record<string, string> = {
    added: "新增",
    removed: "移除",
    changed: "变更",
  };
  for (const row of rows) {
    lines.push(
      [
        scopeLabel[row.scope] ?? row.scope,
        row.objectLabel,
        row.field,
        row.before,
        row.after,
        kindLabel[row.kind] ?? row.kind,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

function csvCell(value: string): string {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 差异按对象汇总，便于导出时按版本审阅。 */
export function groupDiff(rows: DiffRow[]): Map<string, DiffRow[]> {
  const groups = new Map<string, DiffRow[]>();
  for (const row of rows) {
    const group = row.objectLabel.split(" / ")[0];
    const list = groups.get(group) ?? [];
    list.push(row);
    groups.set(group, list);
  }
  return groups;
}
