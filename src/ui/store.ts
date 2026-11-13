import { applyResult } from "./apply";
import type { Notice, OpResult } from "../domain/engine";
import { activeTaskFor, toSnapshot } from "../domain/engine";
import type { SnapshotData, TrackerState } from "../domain/types";

export interface SessionState {
  tracker: TrackerState;
  snapshots: SnapshotData[];
  selectedVersionId: string | null;
  toast: (Notice & { nonce: number }) | null;
}

export function initSession(state: TrackerState): SessionState {
  return {
    tracker: state,
    snapshots: [toSnapshot(state, "初始基线")],
    selectedVersionId: firstActionableVersionId(state),
    toast: null,
  };
}

/** 默认聚焦"最值得看"的版本：优先未完成/失败的计划，其次有保留的，最后是首个版本。 */
function firstActionableVersionId(state: TrackerState): string | null {
  const failed = state.tasks.find((t) => t.status === "failed");
  if (failed) return failed.versionId;
  const planned = state.tasks.find((t) => t.status === "planned" || t.status === "held");
  if (planned) return planned.versionId;
  const held = state.versions.find((v) =>
    state.replicas.some((r) => r.versionId === v.id && r.state === "held"),
  );
  if (held && activeTaskFor(state, held.id)) return held.id;
  return state.versions[0]?.id ?? null;
}

export function commit(
  session: SessionState,
  label: string,
  fn: (state: TrackerState) => OpResult,
  nonce: number,
): SessionState {
  const result = fn(session.tracker);
  const next = applyResult(session, result, nonce);
  if (result.notice.level === "error") return next;
  // 成功操作后，静默记录一个可回溯快照；保留最近 12 个。
  const snapshot = toSnapshot(result.state, label);
  const snapshots = [...session.snapshots, snapshot].slice(-12);
  return { ...next, snapshots };
}

export function pushSnapshot(session: SessionState, label: string): SessionState {
  const snapshot = toSnapshot(session.tracker, label);
  return { ...session, snapshots: [...session.snapshots, snapshot].slice(-12) };
}

export function selectedVersion(state: TrackerState, selectedVersionId: string | null) {
  return state.versions.find((v) => v.id === selectedVersionId) ?? state.versions[0] ?? null;
}
