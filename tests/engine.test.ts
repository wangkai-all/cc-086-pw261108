import { describe, expect, it } from "vitest";
import { seedState } from "../src/data/seed";
import {
  actionableReplicas,
  activeTaskFor,
  beginRun,
  discoverReplica,
  executeAttempt,
  extendRetention,
  finishRun,
  importDataset,
  latestReceiptForReplica,
  pendingItems,
  placeHold,
  releaseHold,
  requestDeletion,
  setClock,
  taskCoverage,
  versionView,
} from "../src/domain/engine";
import { addDays, daysBetween, expiryFor, retentionStatus } from "../src/domain/time";
import type { TrackerState } from "../src/domain/types";

function apply(state: TrackerState, result: { state: TrackerState; notice: { level: string } }) {
  expect(result.notice.level).not.toBe("error");
  return result.state;
}

function withImport(state: TrackerState, opts: Partial<Parameters<typeof importDataset>[1]> = {}) {
  return apply(
    state,
    importDataset(state, {
      datasetName: "测试数据集",
      datasetId: "ds-test",
      versionLabel: "v1",
      createdAt: addDays(state.clock, -30),
      retentionDays: 30,
      recordCount: 100,
      locationIds: ["loc-main-hz", "loc-replica-sh"],
      ...opts,
    }),
  );
}

function lastVersion(state: TrackerState) {
  return state.versions[state.versions.length - 1];
}

describe("期限计算", () => {
  it("到期日 = 创建日 + 保留天数，且跨月正确", () => {
    expect(expiryFor("2026-11-13", 30)).toBe("2026-12-13");
    expect(expiryFor("2026-12-20", 20)).toBe("2027-01-09");
    expect(daysBetween("2026-11-13", "2026-11-14")).toBe(1);
  });

  it("14 天内为即将过期，0 天今日到期，负数已过期", () => {
    expect(retentionStatus("2026-01-01", 330, "2026-11-13").urgency).toBe("due-soon");
    expect(retentionStatus("2026-10-14", 30, "2026-11-13").urgency).toBe("due");
    expect(retentionStatus("2026-09-01", 30, "2026-11-13").urgency).toBe("overdue");
  });

  it("导入后立即按期限推导待办状态", () => {
    const state = withImport(seedState());
    const view = versionView(state, lastVersion(state));
    expect(view.expiry).toBe(state.clock);
    expect(view.label).toBe("待排期");
  });
});

describe("导入", () => {
  it("为每个副本位置各建一条副本记录", () => {
    const state = withImport(seedState(), { locationIds: ["loc-main-hz", "loc-cold-bj", "loc-vault-sz"] });
    const version = lastVersion(state);
    const replicas = state.replicas.filter((r) => r.versionId === version.id);
    expect(replicas.map((r) => r.locationId)).toEqual(["loc-main-hz", "loc-cold-bj", "loc-vault-sz"]);
    expect(replicas.every((r) => r.state === "pending")).toBe(true);
  });

  it("拒绝非法期限与空副本位置", () => {
    const base = seedState();
    const invalidDays = importDataset(base, {
      datasetName: "x", datasetId: "x", versionLabel: "v1", createdAt: base.clock,
      retentionDays: 0, recordCount: 1, locationIds: ["loc-main-hz"],
    });
    expect(invalidDays.notice.level).toBe("error");
    const noLocations = importDataset(base, {
      datasetName: "x", datasetId: "x", versionLabel: "v1", createdAt: base.clock,
      retentionDays: 30, recordCount: 1, locationIds: [],
    });
    expect(noLocations.notice.level).toBe("error");
  });
});

describe("删除请求幂等", () => {
  it("重复请求复用同一任务，只累加请求次数并留痕", () => {
    const state = withImport(seedState());
    const version = lastVersion(state);
    const first = apply(state, requestDeletion(state, version.id));
    const task = activeTaskFor(first, version.id)!;
    const second = apply(first, requestDeletion(first, version.id));
    const tasks = second.tasks.filter((t) => t.versionId === version.id);
    expect(tasks).toHaveLength(1);
    expect(activeTaskFor(second, version.id)!.id).toBe(task.id);
    expect(activeTaskFor(second, version.id)!.requestCount).toBe(2);
    expect(activeTaskFor(second, version.id)!.events.some((e) => e.type === "reused-request")).toBe(true);
  });

  it("后来发现的新副本并入现有任务，原有回执仍可查", () => {
    const state = withImport(seedState());
    const version = lastVersion(state);
    let current = apply(state, requestDeletion(state, version.id));
    const taskId = activeTaskFor(current, version.id)!.id;
    current = apply(current, beginRun(current, taskId));
    const targets = actionableReplicas(current, taskId);
    for (const replica of targets) current = apply(current, executeAttempt(current, taskId, replica.id));
    current = apply(current, finishRun(current, taskId));
    expect(current.tasks.find((t) => t.id === taskId)!.status).toBe("completed");

    const receiptsBefore = current.receipts.filter((r) => r.taskId === taskId).length;
    current = apply(current, discoverReplica(current, version.id, "loc-tape-overseas"));

    const task = current.tasks.find((t) => t.id === taskId)!;
    expect(task.status).toBe("planned");
    expect(task.targetReplicaIds.some((id) => current.replicas.find((r) => r.id === id)?.locationId === "loc-tape-overseas")).toBe(true);
    expect(current.receipts.filter((r) => r.taskId === taskId)).toHaveLength(receiptsBefore);
    expect(current.receipts.filter((r) => r.taskId === taskId).every((r) => r.outcome === "succeeded")).toBe(true);
  });
});

describe("执行与回执", () => {
  it("任一副本失败时不得显示完成，并能指出未确认来源", () => {
    const base = withImport(seedState());
    const version = lastVersion(base);
    let state = apply(base, requestDeletion(base, version.id));
    const taskId = activeTaskFor(state, version.id)!.id;
    const faulty = state.replicas.find(
      (r) => r.versionId === version.id && r.locationId === "loc-replica-sh",
    )!;
    state = apply(state, setFaultForTest(state, faulty.id));

    state = apply(state, beginRun(state, taskId));
    for (const replica of actionableReplicas(state, taskId)) {
      state = apply(state, executeAttempt(state, taskId, replica.id));
    }
    state = apply(state, finishRun(state, taskId));

    const task = state.tasks.find((t) => t.id === taskId)!;
    expect(task.status).not.toBe("completed");
    expect(task.status).toBe("failed");
    const coverage = taskCoverage(state, taskId);
    expect(coverage.fullyConfirmed).toBe(false);
    const locationName = state.locations.find((l) => l.id === "loc-replica-sh")!.name;
    expect(coverage.unconfirmed.map((u) => u.locationName)).toContain(locationName);
    expect(coverage.unconfirmed.some((u) => u.reason.includes("执行失败"))).toBe(true);
    expect(task.events.some((e) => e.type === "failed")).toBe(true);
  });

  it("重复执行保留失败历史，回执按尝试次数追加", () => {
    const base = withImport(seedState());
    const version = lastVersion(base);
    let state = apply(base, requestDeletion(base, version.id));
    const taskId = activeTaskFor(state, version.id)!.id;
    const faulty = state.replicas.find(
      (r) => r.versionId === version.id && r.locationId === "loc-replica-sh",
    )!;
    state = apply(state, setFaultForTest(state, faulty.id));
    state = apply(state, beginRun(state, taskId));
    for (const replica of actionableReplicas(state, taskId)) {
      state = apply(state, executeAttempt(state, taskId, replica.id));
    }
    state = apply(state, finishRun(state, taskId));
    const failedReceipt = latestReceiptForReplica(state, taskId, faulty.id)!;
    expect(failedReceipt.outcome).toBe("failed");

    state = apply(state, beginRun(state, taskId));
    state = apply(state, executeAttempt(state, taskId, faulty.id));
    state = apply(state, finishRun(state, taskId));

    const history = state.receipts.filter((r) => r.taskId === taskId && r.replicaId === faulty.id);
    expect(history).toHaveLength(2);
    expect(history[0].outcome).toBe("failed");
    expect(history[1].attempt).toBe(2);
    expect(history[0].id).not.toBe(history[1].id);
  });

  it("只有全部当前副本确认后才显示完成", () => {
    const base = withImport(seedState());
    const version = lastVersion(base);
    let state = apply(base, requestDeletion(base, version.id));
    const taskId = activeTaskFor(state, version.id)!.id;
    state = apply(state, beginRun(state, taskId));
    const first = actionableReplicas(state, taskId)[0];
    state = apply(state, executeAttempt(state, taskId, first.id));
    state = apply(state, finishRun(state, taskId));
    expect(state.tasks.find((t) => t.id === taskId)!.status).not.toBe("completed");

    state = apply(state, beginRun(state, taskId));
    for (const replica of actionableReplicas(state, taskId)) {
      state = apply(state, executeAttempt(state, taskId, replica.id));
    }
    state = apply(state, finishRun(state, taskId));
    expect(state.tasks.find((t) => t.id === taskId)!.status).toBe("completed");
    expect(versionView(state, lastVersion(state)).label).toBe("已清空");
  });
});

describe("期限延长", () => {
  it("取消尚未执行的计划并留痕", () => {
    const base = withImport(seedState());
    const version = lastVersion(base);
    let state = apply(base, requestDeletion(base, version.id));
    const taskId = activeTaskFor(state, version.id)!.id;
    state = apply(state, extendRetention(state, version.id, 90, "合规复核延期"));

    const task = state.tasks.find((t) => t.id === taskId)!;
    expect(task.status).toBe("cancelled");
    expect(task.cancelReason).toContain("延长");
    expect(task.events.some((e) => e.type === "cancelled")).toBe(true);
    const changed = lastVersion(state);
    expect(changed.retentionDays).toBe(90);
    expect(changed.retentionChanges[0]).toMatchObject({ previousDays: 30, nextDays: 90 });
    expect(pendingItems(state).some((i) => i.version.id === version.id)).toBe(false);
  });

  it("已执行过的计划不会被取消，失败历史不被抹除", () => {
    const base = withImport(seedState());
    const version = lastVersion(base);
    let state = apply(base, requestDeletion(base, version.id));
    const taskId = activeTaskFor(state, version.id)!.id;
    const faulty = state.replicas.find(
      (r) => r.versionId === version.id && r.locationId === "loc-replica-sh",
    )!;
    state = apply(state, setFaultForTest(state, faulty.id));
    state = apply(state, beginRun(state, taskId));
    for (const replica of actionableReplicas(state, taskId)) {
      state = apply(state, executeAttempt(state, taskId, replica.id));
    }
    state = apply(state, finishRun(state, taskId));
    const receipts = state.receipts.length;

    state = apply(state, extendRetention(state, version.id, 120));
    const task = state.tasks.find((t) => t.id === taskId)!;
    expect(task.status).not.toBe("cancelled");
    expect(state.receipts).toHaveLength(receipts);
  });

  it("拒绝缩短或非正数期限", () => {
    const state = withImport(seedState());
    const version = lastVersion(state);
    expect(extendRetention(state, version.id, 10).notice.level).toBe("error");
    expect(extendRetention(state, version.id, 0).notice.level).toBe("error");
  });
});

describe("法律保留", () => {
  it("保留中的副本不进入删除执行，覆盖度保持未确认", () => {
    const base = seedState();
    let state = setClock(base, "2027-01-05").state;
    const version = state.versions.find((v) => v.id === "ver-1001")!;
    const heldReplica = state.replicas.find(
      (r) => r.versionId === version.id && r.state === "pending",
    )!;
    state = apply(state, placeHold(state, heldReplica.id, "诉讼保全"));
    expect(state.replicas.find((r) => r.id === heldReplica.id)!.state).toBe("held");

    state = apply(state, requestDeletion(state, version.id));
    const taskId = activeTaskFor(state, version.id)!.id;
    expect(actionableReplicas(state, taskId).some((r) => r.id === heldReplica.id)).toBe(false);
    state = apply(state, beginRun(state, taskId));
    expect(actionableReplicas(state, taskId).every((r) => r.id !== heldReplica.id)).toBe(true);
    for (const r of actionableReplicas(state, taskId)) {
      state = apply(state, executeAttempt(state, taskId, r.id));
    }
    state = apply(state, finishRun(state, taskId));
    const coverage = taskCoverage(state, taskId);
    expect(coverage.fullyConfirmed).toBe(false);
    const blocked = coverage.unconfirmed.find((u) => u.replicaId === heldReplica.id)!;
    expect(blocked.reason).toContain("保留");
  });

  it("解除保留后按当前期限重新生成待办并留痕", () => {
    // 新导入一个即将到期的版本：排期后不执行，施加保留，再延长期限取消旧计划。
    let state = withImport(seedState(), {
      datasetName: "保留解除样例",
      createdAt: addDays(seedState().clock, -28),
      retentionDays: 30,
      locationIds: ["loc-main-hz", "loc-replica-sh"],
    });
    const versionId = lastVersion(state).id;
    state = apply(state, requestDeletion(state, versionId));
    const cancelledTask = activeTaskFor(state, versionId)!;
    const held = state.replicas.find((r) => r.versionId === versionId)!;
    state = apply(state, placeHold(state, held.id, "监管问询"));

    state = apply(state, extendRetention(state, versionId, 400, "调查期间延长"));
    expect(state.tasks.find((t) => t.id === cancelledTask.id)!.status).toBe("cancelled");

    // 新到期日已过：解除保留应当按"当前期限"新建待办，而不是复活旧计划。
    const versionNow = state.versions.find((v) => v.id === versionId)!;
    state = setClock(state, addDays(expiryFor(versionNow.createdAt, versionNow.retentionDays), 1)).state;
    const hold = state.holds.find((h) => h.replicaId === held.id && !h.releasedAt)!;
    const before = state.tasks.length;
    state = apply(state, releaseHold(state, hold.id, "调查结束"));

    const task = activeTaskFor(state, versionId);
    expect(task).toBeDefined();
    expect(task!.id).not.toBe(cancelledTask.id);
    expect(task!.plannedExpiry).toBe(expiryFor(versionNow.createdAt, versionNow.retentionDays));
    expect(task!.events.some((e) => e.detail.includes("按当前期限"))).toBe(true);
    expect(state.tasks.length).toBe(before + 1);
    expect(state.holds.find((h) => h.id === hold.id)!.releasedAt).not.toBeNull();
    // 被取消的旧计划与取消原因仍可查
    const old = state.tasks.find((t) => t.id === cancelledTask.id)!;
    expect(old.cancelReason).toContain("延长");
  });

  it("活跃任务存在时，解除保留把副本并回现有任务", () => {
    let state = setClock(seedState(), "2027-01-05").state;
    const version = state.versions.find((v) => v.id === "ver-1004")!;
    const hold = state.holds.find((h) => h.versionId === version.id)!;
    const taskBefore = activeTaskFor(state, version.id)!;
    state = apply(state, requestDeletion(state, version.id));
    const task = activeTaskFor(state, version.id)!;
    state = apply(state, releaseHold(state, hold.id));
    const after = activeTaskFor(state, version.id)!;
    expect(after.id).toBe(task.id);
    expect(after.targetReplicaIds).toContain(hold.replicaId);
    expect(state.replicas.find((r) => r.id === hold.replicaId)!.state).not.toBe("held");
  });
});

function setFaultForTest(state: TrackerState, replicaId: string) {
  const { state: next } = { state: structuredClone(state) };
  const replica = next.replicas.find((r) => r.id === replicaId)!;
  replica.faultInjected = true;
  return { state: next, notice: { level: "ok" } };
}
