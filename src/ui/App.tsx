import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LOCATIONS,
  seedState,
} from "../data/seed";
import {
  actionableReplicas,
  activeTaskFor,
  advanceClock,
  allTasksFor,
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
  setFaultInjection,
  taskCoverage,
  timeline,
  upcomingVersions,
  versionView,
} from "../domain/engine";
import { diffStates, diffToCsv, countDiff, type DiffRow } from "../domain/diff";
import { addDays, daysBetween, expiryFor, formatTimestamp } from "../domain/time";
import type {
  DatasetVersion,
  DeletionTask,
  Replica,
  SnapshotData,
  StorageLocation,
  TrackerState,
} from "../domain/types";
import { CoverageBar, ExpiryChart, ReceiptRow, StatusChip, StatTile, type ExpiryDatum } from "./components";
import { commit, initSession, selectedVersion, type SessionState } from "./store";

const TABS = [
  { id: "overview", label: "总览" },
  { id: "pending", label: "即将过期与待处理" },
  { id: "plans", label: "删除计划与回执" },
  { id: "diff", label: "差异与导出" },
  { id: "timeline", label: "时间线" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function App() {
  const [session, setSession] = useState<SessionState>(() => initSession(seedState()));
  const [tab, setTab] = useState<TabId>("overview");
  const nonce = useRef(0);
  const state = session.tracker;

  const run = useCallback(
    (label: string, fn: (s: TrackerState) => ReturnType<typeof requestDeletion>) => {
      nonce.current += 1;
      setSession((prev) => commit(prev, label, fn, nonce.current));
    },
    [],
  );

  const toast = session.toast;
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setSession((prev) => (prev.toast?.nonce === toast.nonce ? { ...prev, toast: null } : prev)), 4200);
    return () => clearTimeout(id);
  }, [toast]);

  const views = useMemo(() => state.versions.map((v) => versionView(state, v)), [state]);
  const upcoming = useMemo(() => upcomingVersions(state), [state]);
  const pending = useMemo(() => pendingItems(state), [state]);
  const selected = selectedVersion(state, session.selectedVersionId);

  const kpis = useMemo(() => {
    const overdue = views.filter((v) => v.daysLeft < 0 && !v.cleared).length;
    const dueSoon = views.filter((v) => v.daysLeft >= 0 && v.daysLeft <= 14 && !v.cleared).length;
    const openReplicas = state.replicas.filter((r) => r.state !== "deleted").length;
    const held = state.replicas.filter((r) => r.state === "held").length;
    const completedTasks = state.tasks.filter((t) => t.status === "completed").length;
    const tasksNeedingAttention = state.tasks.filter(
      (t) => t.status === "failed" || (t.status === "planned" && t.receiptIds.length > 0),
    ).length;
    return { overdue, dueSoon, openReplicas, held, completedTasks, tasksNeedingAttention };
  }, [views, state]);

  const expiryData: ExpiryDatum[] = useMemo(
    () =>
      views
        .filter((v) => !v.cleared)
        .map((v) => ({
          id: v.version.id,
          label: `${v.version.datasetName} ${v.version.versionLabel}`,
          sublabel: `${v.replicas.length} 个副本`,
          daysLeft: v.daysLeft,
          expiry: v.expiry,
          copies: v.coverage
            ? `${v.coverage.confirmed}/${v.coverage.total} 已确认`
            : `${v.replicas.filter((r) => r.state !== "deleted").length} 个未处置`,
        }))
        .sort((a, b) => a.daysLeft - b.daysLeft),
    [views],
  );

  return (
    <div className="app-shell">
      <Header
        state={state}
        onClock={(next) => run(`调整模拟日期 ${next}`, (s) => setClock(s, next))}
        onAdvance={(days) => run(`推进 ${days} 天`, (s) => advanceClock(s, days))}
        onReset={() => {
          nonce.current += 1;
          setSession({
            ...initSession(seedState()),
            toast: { level: "ok", message: "已回到演示基线（所有状态重置）", nonce: nonce.current },
          });
          setTab("overview");
        }}
        toast={toast}
      />

      <nav className="tabs" aria-label="视图">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "tab-active" : ""}`}
            type="button"
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "pending" && pending.length ? (
              <span className="tab-count">{pending.length}</span>
            ) : null}
            {t.id === "plans" && kpis.tasksNeedingAttention ? (
              <span className="tab-count tab-count-alert">{kpis.tasksNeedingAttention}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <main className="main">
        {tab === "overview" ? (
          <section className="view" aria-labelledby="overview-title">
            <div className="view-head">
              <div>
                <h1 id="overview-title" className="view-title">总览</h1>
                <p className="view-sub">
                  虚构数据集演练环境 · 模拟日期 <span className="mono">{state.clock}</span> ·
                  不连接任何真实存储，也不执行真实删除
                </p>
              </div>
              <div className="kpis">
                <StatTile label="已过期未清空" value={kpis.overdue} sub="需要处置" tone={kpis.overdue ? "bad" : "ok"} />
                <StatTile label="14 天内到期" value={kpis.dueSoon} sub="即将过期" tone={kpis.dueSoon ? "warn" : "ok"} />
                <StatTile label="未确认副本" value={kpis.openReplicas} sub={`其中 ${kpis.held} 个受法律保留`} tone={kpis.openReplicas ? "warn" : "ok"} />
                <StatTile label="已完成计划" value={kpis.completedTasks} sub="全部副本确认方计入" tone="ok" />
              </div>
            </div>

            <div className="grid-two">
              <Card title="即将过期" sub="14 天内到期（含已过期），尚未清空的版本">
                {upcoming.length === 0 ? (
                  <p className="empty">14 天内没有即将到期的版本。</p>
                ) : (
                  <ul className="mini-list">
                    {upcoming.slice(0, 5).map((v) => (
                      <li key={v.version.id} className="mini-row">
                        <span className="mini-name">{v.version.datasetName} <span className="muted">{v.version.versionLabel}</span></span>
                        <span className={`mini-days ${v.daysLeft < 0 ? "text-bad" : "text-warn"}`}>
                          {v.daysLeft < 0 ? `过期 ${-v.daysLeft} 天` : `剩 ${v.daysLeft} 天`}
                        </span>
                        <button
                          className="linkish"
                          type="button"
                          onClick={() => {
                            setSession((s) => ({ ...s, selectedVersionId: v.version.id }));
                            setTab("pending");
                          }}
                        >
                          查看待处理
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="期限与副本分布" sub="每个版本按当前副本覆盖度">
                <ExpiryChart data={expiryData} />
              </Card>
            </div>

            <Card title="待处理队列" sub="到期版本上尚未确认的副本，以及后来发现的新副本">
              <PendingTable
                items={pending.slice(0, 8)}
                state={state}
                onSelect={(versionId) => {
                  setSession((s) => ({ ...s, selectedVersionId: versionId }));
                  setTab("plans");
                }}
                onRequest={(versionId) => run("提交删除请求", (s) => requestDeletion(s, versionId))}
              />
            </Card>

            <ImportCard
              state={state}
              onImport={(input) => {
                run(`导入数据集「${input.datasetName} ${input.versionLabel}」`, (s) => importDataset(s, input));
              }}
            />
          </section>
        ) : null}

        {tab === "pending" ? (
          <section className="view" aria-labelledby="pending-title">
            <div className="view-head">
              <div>
                <h1 id="pending-title" className="view-title">即将过期与待处理</h1>
                <p className="view-sub">按到期日排序；法律保留中的副本单列，不进入执行队列。</p>
              </div>
              <div className="inline-filters">
                <select
                  className="select"
                  aria-label="按版本筛选"
                  value={session.selectedVersionId ?? ""}
                  onChange={(e) => setSession((s) => ({ ...s, selectedVersionId: e.target.value || null }))}
                >
                  <option value="">全部版本</option>
                  {state.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.datasetName} {v.versionLabel}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid-two">
              <Card title="即将过期" sub="14 天内到期与已过期且未清空">
                {upcoming.length === 0 ? <p className="empty">没有即将过期的版本。</p> : (
                  <ul className="mini-list">
                    {upcoming.map((v) => (
                      <li key={v.version.id} className="mini-row">
                        <span className="mini-name">{v.version.datasetName} <span className="muted">{v.version.versionLabel}</span></span>
                        <span className="mono muted">{v.expiry}</span>
                        <span className={`mini-days ${v.daysLeft < 0 ? "text-bad" : "text-warn"}`}>
                          {v.daysLeft < 0 ? `过期 ${-v.daysLeft} 天` : `剩 ${v.daysLeft} 天`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="期限提醒" sub="14 天阈值内的版本按当前期限推导">
                <ExpiryChart data={expiryData.filter((d) => d.daysLeft <= 14)} />
              </Card>
            </div>

            <Card title="待处理明细" sub="每个副本一条；任一副本未确认即保持待办">
              <PendingTable
                items={pending.filter((i) => !session.selectedVersionId || i.version.id === session.selectedVersionId)}
                state={state}
                onSelect={(versionId) => setSession((s) => ({ ...s, selectedVersionId: versionId }))}
                onRequest={(versionId) => run("提交删除请求", (s) => requestDeletion(s, versionId))}
                onReleaseHold={(holdId) => run("解除法律保留", (s) => releaseHold(s, holdId))}
                showHoldActions
              />
            </Card>
          </section>
        ) : null}

        {tab === "plans" ? (
          <PlansView state={state} run={run} selectedId={session.selectedVersionId} onSelect={(id) => setSession((s) => ({ ...s, selectedVersionId: id }))} />
        ) : null}

        {tab === "diff" ? (
          <DiffView state={state} snapshots={session.snapshots} onSnapshot={(label) => setSession((s) => commit(s, label, () => ({ state: s.tracker, notice: { level: "ok", message: label } }), (nonce.current += 1)))} onEvidence={(label) => {
            nonce.current += 1;
            setSession((s) => ({ ...s, snapshots: [...s.snapshots, { ...buildSnapshot(s.tracker, label) }].slice(-12), toast: { level: "ok", message: `已记录基线：${label}`, nonce: nonce.current } }));
          }} />
        ) : null}

        {tab === "timeline" ? (
          <TimelineView state={state} selectedId={session.selectedVersionId} onSelect={(id) => setSession((s) => ({ ...s, selectedVersionId: id }))} />
        ) : null}
      </main>

      <footer className="footer">
        <span>留痕 · 数据保留追踪台</span>
        <span className="muted">所有数据集、存储位置与回执均为虚构样例；执行只在本次会话内模拟，不写入任何真实存储。</span>
        <span className="mono muted">状态操作 {state.seq} 次 · 快照 {session.snapshots.length} 份</span>
      </footer>
    </div>
  );
}

function buildSnapshot(state: TrackerState, label: string): SnapshotData {
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

/* ------------------------------------------------------------------------- */

function Header({
  state,
  onClock,
  onAdvance,
  onReset,
  toast,
}: {
  state: TrackerState;
  onClock: (next: string) => void;
  onAdvance: (days: number) => void;
  onReset: () => void;
  toast: (SessionState["toast"] & object) | null;
}) {
  const [draft, setDraft] = useState(state.clock);
  useEffect(() => setDraft(state.clock), [state.clock]);
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">留</span>
        <div>
          <h1 className="brand-title">数据保留追踪台</h1>
          <p className="brand-sub">期限 · 副本 · 删除计划 · 回执留痕</p>
        </div>
      </div>
      <div className="clock-controls">
        <span className="clock-label">模拟日期</span>
        <input
          type="date"
          className="input date-input"
          aria-label="模拟日期"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== state.clock && onClock(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
        />
        <button className="btn btn-quiet" type="button" onClick={() => onAdvance(7)}>+7 天</button>
        <button className="btn btn-quiet" type="button" onClick={() => onAdvance(30)}>+30 天</button>
        <button className="btn btn-quiet" type="button" onClick={onReset}>重置演示</button>
      </div>
      {toast ? (
        <div className={`toast toast-${toast.level}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      ) : null}
    </header>
  );
}

/* ------------------------------------------------------------------------- */

function Card({
  title,
  sub,
  children,
  aside,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="card-title">{title}</h2>
          {sub ? <p className="card-sub">{sub}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------------- */

function PendingTable({
  items,
  state,
  onSelect,
  onRequest,
  onReleaseHold,
  showHoldActions,
}: {
  items: ReturnType<typeof pendingItems>;
  state: TrackerState;
  onSelect: (versionId: string) => void;
  onRequest: (versionId: string) => void;
  onReleaseHold?: (holdId: string) => void;
  showHoldActions?: boolean;
}) {
  if (!items.length) return <p className="empty">没有待处理的副本。</p>;
  const holdFor = (replicaId: string) =>
    state.holds.find((h) => h.replicaId === replicaId && !h.releasedAt);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">数据版本</th>
            <th scope="col">存储位置</th>
            <th scope="col">到期日</th>
            <th scope="col">状态</th>
            <th scope="col">待处理原因</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const hold = holdFor(item.replica.id);
            return (
              <tr key={item.replica.id} className={item.blocked ? "row-blocked" : ""}>
                <td>
                  <button className="linkish" type="button" onClick={() => onSelect(item.version.id)}>
                    {item.version.datasetName}
                  </button>
                  <span className="muted"> {item.version.versionLabel}</span>
                </td>
                <td>{item.location?.name ?? item.replica.locationId}</td>
                <td className="mono">
                  {item.expiry}
                  <span className={`muted ${item.daysLeft < 0 ? "text-bad" : ""}`}> · {item.daysLeft < 0 ? `过期 ${-item.daysLeft} 天` : `剩 ${item.daysLeft} 天`}</span>
                </td>
                <td>
                  {item.blocked ? (
                    <StatusChip tone="warn">法律保留</StatusChip>
                  ) : item.replica.state === "failed" ? (
                    <StatusChip tone="bad">失败待重试</StatusChip>
                  ) : item.replica.state === "discovered" ? (
                    <StatusChip tone="warn">新发现</StatusChip>
                  ) : (
                    <StatusChip tone="muted">待处置</StatusChip>
                  )}
                </td>
                <td className="muted">{hold && item.blocked ? `${item.reason} · ${hold.reason}` : item.reason}</td>
                <td className="actions">
                  {showHoldActions && hold && onReleaseHold ? (
                    <button className="btn btn-small" type="button" onClick={() => onReleaseHold(hold.id)}>
                      解除保留
                    </button>
                  ) : null}
                  {!item.blocked ? (
                    <button className="btn btn-small btn-primary" type="button" onClick={() => onRequest(item.version.id)}>
                      排入删除
                    </button>
                  ) : (
                    <span className="muted small">保留期间禁止执行</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function PlansView({
  state,
  run,
  selectedId,
  onSelect,
}: {
  state: TrackerState;
  run: (label: string, fn: (s: TrackerState) => ReturnType<typeof requestDeletion>) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const versions = state.versions;
  const activeVersion = versions.find((v) => v.id === selectedId) ?? versions[0];
  if (!activeVersion) return <p className="empty">尚未导入任何数据版本。</p>;
  const view = versionView(state, activeVersion);
  const tasks = allTasksFor(state, activeVersion.id);
  const task = view.task;

  return (
    <section className="view" aria-labelledby="plans-title">
      <div className="view-head">
        <div>
          <h1 id="plans-title" className="view-title">删除计划与回执</h1>
          <p className="view-sub">按数据版本为单位记录目标副本与逐项结果；任一副本失败都不显示彻底删除。</p>
        </div>
        <select
          className="select"
          aria-label="选择数据版本"
          value={activeVersion.id}
          onChange={(e) => onSelect(e.target.value)}
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.datasetName} {v.versionLabel}
            </option>
          ))}
        </select>
      </div>

      <VersionHero state={state} version={activeVersion} />

      <Card
        title="计划与执行"
        sub="同一版本的重复请求复用同一任务；后来发现的副本并入现有任务"
        aside={
          <div className="actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => run("提交删除请求", (s) => requestDeletion(s, activeVersion.id))}
            >
              {task ? "再次请求删除（复用）" : "生成删除计划"}
            </button>
            {task && task.status === "cancelled" ? (
              <span className="muted small">最近计划已取消，需重新排期</span>
            ) : null}
          </div>
        }
      >
        {tasks.length === 0 ? (
          <p className="empty">该版本尚无删除计划。提交请求后将按当前期限排期。</p>
        ) : (
          <div className="task-stack">
            {tasks
              .slice()
              .reverse()
              .map((t) => (
                <TaskCard key={t.id} state={state} task={t} run={run} />
              ))}
          </div>
        )}
      </Card>

      <ReplicaPanel state={state} version={activeVersion} run={run} />

      <Card title="逐位置回执" sub="每个存储位置单独一条回执；重复执行只追加，失败历史不清空">
        {task ? <ReceiptsForTask state={state} task={task} /> : <p className="empty">尚无任务回执。</p>}
        <HistoricalReceipts state={state} version={activeVersion} currentTaskId={task?.id} />
      </Card>
    </section>
  );
}

function TargetList({ state, task }: { state: TrackerState; task: DeletionTask }) {
  const replicas = state.replicas.filter((r) => r.versionId === task.versionId);
  if (!replicas.length) return null;
  return (
    <div className="targets" aria-label="逐副本结果">
      {replicas.map((r) => {
        const loc = state.locations.find((l) => l.id === r.locationId);
        const inTarget = task.targetReplicaIds.includes(r.id);
        const latest = latestReceiptForReplica(state, task.id, r.id);
        const hold = state.holds.find((h) => h.replicaId === r.id && !h.releasedAt);
        const tone =
          hold ? "warn"
          : latest?.outcome === "succeeded" || r.state === "deleted" ? "ok"
          : latest?.outcome === "failed" ? "bad"
          : "muted";
        const status =
          hold ? "法律保留"
          : latest?.outcome === "succeeded" || r.state === "deleted" ? "已确认"
          : latest?.outcome === "failed" ? "失败"
          : !inTarget ? "未排入" : "待执行";
        return (
          <div key={r.id} className={`target target-${tone}`}>
            <span className={`dot dot-${tone}`} aria-hidden="true" />
            <span className="target-loc">{loc?.name ?? r.locationId}</span>
            <span className="target-status small">{status}</span>
            <span className="target-id mono">{r.id}</span>
            {latest ? <span className="target-rcp mono">{latest.id}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function ImportCard({
  state,
  onImport,
}: {
  state: TrackerState;
  onImport: (input: Parameters<typeof importDataset>[1]) => void;
}) {
  const [name, setName] = useState("");
  const [label, setLabel] = useState("v1");
  const [days, setDays] = useState("30");
  const [createdAt, setCreatedAt] = useState(state.clock);
  const [records, setRecords] = useState("1000");
  const [locations, setLocations] = useState<string[]>(["loc-main-hz"]);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setLocations((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Card title="导入虚构数据集" sub="为每个选中的副本位置生成一条记录；到期后进入待处理队列">
      <form
        className="import-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return setError("请填写数据集名称");
          if (!locations.length) return setError("至少选择一个副本位置");
          const parsedDays = Number(days);
          if (!Number.isFinite(parsedDays) || parsedDays <= 0) return setError("保留期限必须为正整数");
          setError(null);
          onImport({
            datasetName: name.trim(),
            datasetId: "",
            versionLabel: label.trim() || "v1",
            createdAt,
            retentionDays: parsedDays,
            recordCount: Number(records) || 0,
            locationIds: locations,
          });
          setName("");
        }}
      >
        <div className="form-row">
          <label className="field">
            <span className="field-label">数据集名称</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 月度对账快照" />
          </label>
          <label className="field field-narrow">
            <span className="field-label">版本标识</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field field-narrow">
            <span className="field-label">创建日期</span>
            <input className="input" type="date" value={createdAt} onChange={(e) => setCreatedAt(e.target.value)} />
          </label>
          <label className="field field-narrow">
            <span className="field-label">保留期限（天）</span>
            <input className="input" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <label className="field field-narrow">
            <span className="field-label">记录数</span>
            <input className="input" type="number" min={0} value={records} onChange={(e) => setRecords(e.target.value)} />
          </label>
        </div>
        <fieldset className="location-picker">
          <legend className="field-label">副本位置</legend>
          {state.locations.map((loc) => (
            <label key={loc.id} className={`loc-chip ${locations.includes(loc.id) ? "loc-chip-on" : ""}`}>
              <input type="checkbox" checked={locations.includes(loc.id)} onChange={() => toggle(loc.id)} />
              {loc.name}
            </label>
          ))}
        </fieldset>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="actions">
          <button className="btn btn-primary" type="submit">导入数据集</button>
          <span className="muted small">
            仅生成演练数据；不写入任何真实存储。
          </span>
        </div>
      </form>
    </Card>
  );
}

function RunButton({
  state,
  task,
  run,
}: {
  state: TrackerState;
  task: DeletionTask;
  run: (label: string, fn: (s: TrackerState) => ReturnType<typeof requestDeletion>) => void;
}) {
  const [running, setRunning] = useState(false);
  const timer = useRef<number | null>(null);

  const execute = useCallback(async () => {
    if (running) return;
    setRunning(true);
    let current = state;
    const begun = beginRun(current, task.id);
    if (begun.notice.level === "error") {
      run("开始执行失败", () => begun);
      setRunning(false);
      return;
    }
    run("开始删除演练", () => begun);
    current = begun.state;
    const queue = actionableReplicas(current, task.id);
    for (const replica of queue) {
      const location = current.locations.find((l) => l.id === replica.locationId);
      await new Promise<void>((resolve) => {
        timer.current = window.setTimeout(resolve, location?.latencyMs ?? 500);
      });
      run(`执行 ${location?.name ?? replica.locationId}`, (s) => executeAttempt(s, task.id, replica.id));
    }
    run("收尾", (s) => finishRun(s, task.id));
    setRunning(false);
  }, [state, task.id, running, run]);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return (
    <button
      className="btn btn-accent"
      type="button"
      onClick={execute}
      disabled={running || task.isRunning}
    >
      {running ? "演练执行中…" : task.isRunning ? "执行中…" : "执行删除演练"}
    </button>
  );
}

function TaskCard({
  state,
  task,
  run,
}: {
  state: TrackerState;
  task: DeletionTask;
  run: (label: string, fn: (s: TrackerState) => ReturnType<typeof requestDeletion>) => void;
}) {
  const coverage = taskCoverage(state, task.id);
  const isActive = activeTaskFor(state, task.versionId)?.id === task.id;
  const statusTone =
    task.status === "completed" ? "ok"
    : task.status === "failed" ? "bad"
    : task.status === "cancelled" ? "muted"
    : task.status === "held" ? "warn"
    : task.status === "running" ? "warn"
    : "muted";
  const statusLabel =
    task.status === "completed" ? "完成（全部副本确认）"
    : task.status === "failed" ? "未完成 · 有副本失败"
    : task.status === "cancelled" ? "计划已取消"
    : task.status === "held" ? "被法律保留阻断"
    : task.status === "running" ? "执行中"
    : "计划待执行";

  const unconfirmed = coverage.unconfirmed;

  return (
    <article className={`task ${isActive ? "task-active" : ""}`} aria-label={`任务 ${task.id}`}>
      <div className="task-head">
        <div className="task-id">
          <span className="mono">{task.id}</span>
          <StatusChip tone={statusTone}>{statusLabel}</StatusChip>
          {task.requestCount > 1 ? (
            <span className="muted small">请求复用 {task.requestCount} 次</span>
          ) : null}
        </div>
        <span className="muted small">建立于 {formatTimestamp(task.createdAt)} · 计划依据到期日 {task.plannedExpiry}</span>
      </div>

      <div className="task-meter">
        <CoverageBar
          total={coverage.total}
          ariaLabel={`任务 ${task.id} 覆盖度：${coverage.confirmed} 个确认，${unconfirmed.length} 个未确认，共 ${coverage.total} 个当前副本`}
          segments={[
            { key: "ok", value: coverage.confirmed, tone: "ok", label: "已确认" },
            { key: "bad", value: unconfirmed.filter((u) => u.state === "failed").length, tone: "bad", label: "失败待确认" },
            { key: "warn", value: coverage.held, tone: "warn", label: "法律保留" },
            { key: "muted", value: unconfirmed.filter((u) => u.state !== "failed" && u.state !== "held").length, tone: "muted", label: "待执行" },
          ]}
        />
        <span className="task-fraction mono">
          {coverage.confirmed} / {coverage.total}
        </span>
      </div>

      <div className="task-meta">
        <span>目标副本 {task.targetReplicaIds.length} 个</span>
        <span>当前未确认 {unconfirmed.length} 个</span>
        <span>回执 {task.receiptIds.length} 条</span>
      </div>

      <TargetList state={state} task={task} />

      {coverage.fullyConfirmed ? (
        <p className="verdict verdict-ok">
          <span aria-hidden="true">✓</span> 全部 {coverage.total} 个当前副本均已取得成功回执，可显示完成。
        </p>
      ) : (
        <div className="verdict verdict-warn">
          <p>
            <span aria-hidden="true">!</span>{" "}
            {task.status === "cancelled"
              ? `计划已取消，未执行：${task.cancelReason ?? "—"}`
              : `不得显示完成：仍有 ${unconfirmed.length} 个副本未确认`}
          </p>
          {unconfirmed.length ? (
            <ul className="unconfirmed">
              {unconfirmed.map((u) => (
                <li key={u.replicaId}>
                  <span className="unconfirmed-loc">{u.locationName}</span>
                  <span className="muted"> · {u.reason}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      {task.cancelReason ? (
        <p className="cancel-note">
          取消于 {task.cancelledAt ? formatTimestamp(task.cancelledAt) : "—"}：{task.cancelReason}
        </p>
      ) : null}

      <div className="task-events">
        {task.events.map((e) => (
          <div key={e.id} className="event-line">
            <span className="mono muted">{formatTimestamp(e.at)}</span>
            <span>{e.detail}</span>
          </div>
        ))}
      </div>

      {isActive && !coverage.fullyConfirmed && task.status !== "cancelled" ? (
        <div className="task-actions">
          {actionableReplicas(state, task.id).length ? (
            <RunButton state={state} task={task} run={run} />
          ) : (
            <span className="muted small">没有可执行副本（均已确认或均受保留）</span>
          )}
        </div>
      ) : (
        <div className="task-actions">
          <button
            className="btn btn-small"
            type="button"
            onClick={() => run(`重新请求删除 ${task.versionId}`, (s) => requestDeletion(s, task.versionId))}
          >
            对此任务重新请求（复用或重开）
          </button>
        </div>
      )}
    </article>
  );
}

function ReceiptsForTask({ state, task }: { state: TrackerState; task: DeletionTask }) {
  const receipts = state.receipts
    .filter((r) => r.taskId === task.id)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!receipts.length) return <p className="empty">该任务尚无回执。</p>;
  return (
    <div className="receipt-list">
      {receipts.map((r) => (
        <ReceiptRow key={r.id} receipt={r} />
      ))}
    </div>
  );
}

function HistoricalReceipts({
  state,
  version,
  currentTaskId,
}: {
  state: TrackerState;
  version: DatasetVersion;
  currentTaskId?: string;
}) {
  const tasks = allTasksFor(state, version.id).filter((t) => t.id !== currentTaskId);
  if (!tasks.length) return null;
  return (
    <div className="history-block">
      <h4 className="subhead">历史计划回执（保留可查）</h4>
      {tasks.map((t) => (
        <div key={t.id} className="history-task">
          <span className="mono muted">{t.id}</span> · {t.status}
          <div className="receipt-list">
            {state.receipts
              .filter((r) => r.taskId === t.id)
              .map((r) => (
                <ReceiptRow key={r.id} receipt={r} />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function VersionHero({ state, version }: { state: TrackerState; version: DatasetVersion }) {
  const view = versionView(state, version);
  return (
    <Card
      title={`${version.datasetName} · ${version.versionLabel}`}
      sub={`${version.recordCount.toLocaleString()} 条记录 · 创建于 ${version.createdAt} · 保留 ${version.retentionDays} 天`}
      aside={
        <div className="hero-side">
          <span className={`hero-days ${view.daysLeft < 0 ? "text-bad" : view.daysLeft <= 14 ? "text-warn" : "text-muted"}`}>
            {view.daysLeft < 0 ? `过期 ${-view.daysLeft} 天` : view.daysLeft === 0 ? "今日到期" : `剩 ${view.daysLeft} 天`}
          </span>
          <span className="muted mono">到期 {view.expiry}</span>
        </div>
      }
    >
      <div className="meta-row">
        <span><StatusChip tone={view.cleared ? "ok" : view.heldCount ? "warn" : view.failedCount ? "bad" : "muted"}>{view.label}</StatusChip></span>
        <span className="muted">副本 {view.replicas.length} 个 · 已确认 {view.coverage?.confirmed ?? 0} 个 · 保留阻断 {view.heldCount} 个</span>
      </div>
      {version.retentionChanges.length ? (
        <div className="retention-history">
          <h4 className="subhead">期限变更</h4>
          {version.retentionChanges.map((c) => (
            <div key={c.id} className="event-line">
              <span className="mono muted">{c.effectiveAt}</span>
              <span>{c.previousDays} → {c.nextDays} 天 · {c.note}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function ReplicaPanel({
  state,
  version,
  run,
}: {
  state: TrackerState;
  version: DatasetVersion;
  run: (label: string, fn: (s: TrackerState) => ReturnType<typeof requestDeletion>) => void;
}) {
  const [discoverLoc, setDiscoverLoc] = useState("");
  const [holdReplica, setHoldReplica] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [extendDays, setExtendDays] = useState(String(version.retentionDays + 30));

  const replicas = state.replicas.filter((r) => r.versionId === version.id);
  const task = activeTaskFor(state, version.id);
  const availableLocations = LOCATIONS.filter(
    (l) => !replicas.some((r) => r.locationId === l.id),
  );
  const holdable = replicas.filter((r) => r.state !== "deleted" && r.state !== "held");

  return (
    <div className="grid-two">
      <Card title="副本清单" sub="每个存储位置一行；回执按存储位置单独记录">
        {replicas.length === 0 ? <p className="empty">该版本没有登记副本。</p> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">存储位置</th>
                  <th scope="col">状态</th>
                  <th scope="col">最近回执</th>
                  <th scope="col">保留</th>
                </tr>
              </thead>
              <tbody>
                {replicas.map((r) => {
                  const receipt = state.receipts.find((x) => x.id === r.lastReceiptId);
                  const hold = state.holds.find((h) => h.replicaId === r.id && !h.releasedAt);
                  const loc = state.locations.find((l) => l.id === r.locationId);
                  return (
                    <tr key={r.id}>
                      <td>
                        <span>{loc?.name ?? r.locationId}</span>
                        <span className="muted mono"> · {r.id}</span>
                      </td>
                      <td>
                        <StatusChip
                          tone={r.state === "deleted" ? "ok" : r.state === "failed" ? "bad" : r.state === "held" ? "warn" : "muted"}
                        >
                          {r.state === "deleted" ? "已确认移除"
                            : r.state === "failed" ? "执行失败"
                            : r.state === "held" ? "法律保留"
                            : r.state === "deleting" ? "执行中"
                            : r.state === "discovered" ? "新发现"
                            : "待处置"}
                        </StatusChip>
                      </td>
                      <td className="mono small">
                        {receipt ? (
                          <span className={receipt.outcome === "failed" ? "text-bad" : "muted"}>
                            {receipt.id} · {receipt.outcome === "succeeded" ? "成功" : receipt.outcome === "failed" ? "失败" : "未执行"}
                          </span>
                        ) : "—"}
                      </td>
                      <td>
                        {hold ? (
                          <div className="hold-cell">
                            <span className="small">{hold.reason}</span>
                            <button className="linkish small" type="button" onClick={() => run("解除法律保留", (s) => releaseHold(s, hold.id))}>
                              解除
                            </button>
                          </div>
                        ) : r.state === "deleted" ? (
                          <span className="muted small">不可施加</span>
                        ) : (
                          <button
                            className="linkish small"
                            type="button"
                            onClick={() => {
                              setHoldReplica(r.id);
                              setHoldReason("");
                            }}
                          >
                            施加保留
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="form-block">
          <h4 className="subhead">后来发现新副本</h4>
          <div className="form-row">
            <select
              className="select"
              aria-label="新副本存储位置"
              value={discoverLoc}
              onChange={(e) => setDiscoverLoc(e.target.value)}
            >
              <option value="">选择存储位置…</option>
              {availableLocations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <button
              className="btn"
              type="button"
              disabled={!discoverLoc}
              onClick={() => {
                run(`发现新副本 ${discoverLoc}`, (s) => discoverReplica(s, version.id, discoverLoc));
                setDiscoverLoc("");
              }}
            >
              登记新副本
            </button>
          </div>
          <p className="hint">
            新副本会并入现有任务并重新待办；原有回执保持可查。
            {task ? ` 当前任务 ${task.id}。` : " 当前没有活动任务。"}
          </p>
        </div>

        {holdReplica ? (
          <div className="form-block">
            <h4 className="subhead">施加法律保留</h4>
            <div className="form-row">
              <select
                className="select"
                aria-label="保留副本"
                value={holdReplica}
                onChange={(e) => setHoldReplica(e.target.value)}
              >
                {holdable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {state.locations.find((l) => l.id === r.locationId)?.name ?? r.locationId}
                  </option>
                ))}
              </select>
              <input
                className="input"
                placeholder="保留案由"
                aria-label="保留案由"
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
              />
              <button
                className="btn"
                type="button"
                onClick={() => {
                  run("施加法律保留", (s) => placeHold(s, holdReplica, holdReason));
                  setHoldReplica("");
                  setHoldReason("");
                }}
              >
                确认保留
              </button>
            </div>
          </div>
        ) : null}
      </Card>

      <Card title="期限管理" sub="期限延长后立即取消尚未执行的计划，并留痕">
        <div className="form-block">
          <span className="muted small">当前保留期 {version.retentionDays} 天 · 到期 {expiryFor(version.createdAt, version.retentionDays)}</span>
          <div className="form-row">
            <input
              className="input"
              type="number"
              min={version.retentionDays + 1}
              aria-label="新的保留天数"
              value={extendDays}
              onChange={(e) => setExtendDays(e.target.value)}
            />
            <button
              className="btn btn-primary"
              type="button"
              onClick={() =>
                run(`延长保留期至 ${extendDays} 天`, (s) =>
                  extendRetention(s, version.id, Number(extendDays), "演练：保留期延长"),
                )
              }
            >
              延长保留期
            </button>
          </div>
          <p className="hint">仅支持延长；缩短期限请新建版本。已执行过的计划不会取消，回执不得被抹掉。</p>
        </div>

        <div className="form-block">
          <h4 className="subhead">演练故障注入</h4>
          {replicas.filter((r) => r.state !== "deleted").length === 0 ? (
            <p className="muted small">没有可注入的副本。</p>
          ) : (
            replicas
              .filter((r) => r.state !== "deleted")
              .map((r) => (
                <div key={r.id} className="toggle-row">
                  <span>{state.locations.find((l) => l.id === r.locationId)?.name ?? r.locationId}</span>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={r.faultInjected}
                      onChange={(e) => run("切换演练故障", (s) => setFaultInjection(s, r.id, e.target.checked))}
                    />
                    <span className="switch-track" aria-hidden="true" />
                    <span className="small">{r.faultInjected ? "下一次执行将失败" : "正常"}</span>
                  </label>
                </div>
              ))
          )}
          <p className="hint">用于验证：任一副本失败时，任务不得显示彻底删除。</p>
        </div>

        <div className="form-block">
          <h4 className="subhead">法律保留</h4>
          {state.holds.filter((h) => h.versionId === version.id).length === 0 ? (
            <p className="muted small">该版本没有保留记录。</p>
          ) : (
            state.holds
              .filter((h) => h.versionId === version.id)
              .map((h) => (
                <div key={h.id} className="hold-row">
                  <span className="mono small">{h.id}</span>
                  <span>{h.reason}</span>
                  <span className={`small ${h.releasedAt ? "muted" : "text-warn"}`}>
                    {h.releasedAt ? `已解除 ${formatTimestamp(h.releasedAt)}` : "保留中"}
                  </span>
                  {!h.releasedAt ? (
                    <button className="linkish small" type="button" onClick={() => run("解除法律保留", (s) => releaseHold(s, h.id))}>
                      解除
                    </button>
                  ) : null}
                </div>
              ))
          )}
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function DiffView({
  state,
  snapshots,
  onEvidence,
}: {
  state: TrackerState;
  snapshots: SnapshotData[];
  onSnapshot: (label: string) => void;
  onEvidence: (label: string) => void;
}) {
  const [baseId, setBaseId] = useState(snapshots[0]?.id ?? "");
  const base = snapshots.find((s) => s.id === baseId) ?? snapshots[0];
  const current = buildSnapshot(state, "当前状态");
  const rows = useMemo(() => (base ? diffStates(base, current) : []), [base, current]);
  const counts = countDiff(rows);
  const [scope, setScope] = useState<"all" | DiffRow["scope"]>("all");
  const filtered = rows.filter((r) => scope === "all" || r.scope === scope);

  const downloadCsv = () => {
    const csv = diffToCsv(filtered);
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `retention-diff-${state.clock}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="view" aria-labelledby="diff-title">
      <div className="view-head">
        <div>
          <h1 id="diff-title" className="view-title">差异与导出</h1>
          <p className="view-sub">对比基线快照与当前状态；导出 CSV，涵盖期限、副本、任务与回执。</p>
        </div>
        <div className="actions">
          <button className="btn" type="button" onClick={() => onEvidence(`基线 ${state.clock}`)}>记录当前为基线</button>
          <button className="btn btn-primary" type="button" onClick={downloadCsv} disabled={!filtered.length}>
            导出差异 CSV
          </button>
        </div>
      </div>

      <Card
        title="对比基线"
        sub={`${base?.label ?? "—"} · 记录于 ${base ? formatTimestamp(base.takenAt) : "—"} → 当前状态 ${state.clock}`}
        aside={
          <select className="select" aria-label="选择基线快照" value={baseId} onChange={(e) => setBaseId(e.target.value)}>
            {snapshots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {s.clock}
              </option>
            ))}
          </select>
        }
      >
        <div className="diff-summary">
          <StatTile label="新增" value={counts.added} sub="基线之后出现" tone={counts.added ? "ok" : "muted"} />
          <StatTile label="移除" value={counts.removed} sub="当前已不存在" tone={counts.removed ? "warn" : "muted"} />
          <StatTile label="变更" value={counts.changed} sub="字段值发生变化" tone={counts.changed ? "warn" : "muted"} />
        </div>

        <div className="inline-filters" role="tablist" aria-label="差异范围">
          {(["all", "version", "replica", "task", "receipt", "hold"] as const).map((s) => (
            <button
              key={s}
              className={`pill ${scope === s ? "pill-active" : ""}`}
              type="button"
              aria-pressed={scope === s}
              onClick={() => setScope(s)}
            >
              {scopeLabel(s)} {s === "all" ? rows.length : rows.filter((r) => r.scope === s).length}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <p className="empty">基线以来没有差异。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">范围</th>
                  <th scope="col">对象</th>
                  <th scope="col">字段</th>
                  <th scope="col">变更前</th>
                  <th scope="col">变更后</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.key}>
                    <td className="muted">{scopeLabel(r.scope)}</td>
                    <td>
                      <span>{r.objectLabel}</span>
                    </td>
                    <td>{r.field}</td>
                    <td className="diff-before">{r.before}</td>
                    <td className={r.kind === "added" ? "diff-added" : r.kind === "removed" ? "diff-removed" : "diff-after"}>
                      {r.after}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="快照" sub="每次成功操作自动记录快照，最多保留 12 份">
        <div className="snapshot-list">
          {snapshots.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`snapshot ${s.id === baseId ? "snapshot-active" : ""}`}
              onClick={() => setBaseId(s.id)}
            >
              <span>{s.label}</span>
              <span className="mono muted">{s.clock}</span>
              <span className="muted small">任务 {s.tasks.length} · 回执 {s.receipts.length}</span>
            </button>
          ))}
        </div>
      </Card>
    </section>
  );
}

function scopeLabel(s: DiffRow["scope"] | "all"): string {
  switch (s) {
    case "all": return "全部";
    case "version": return "版本";
    case "replica": return "副本";
    case "task": return "任务";
    case "receipt": return "回执";
    case "hold": return "保留";
  }
}

/* ------------------------------------------------------------------------- */

function TimelineView({
  state,
  selectedId,
  onSelect,
}: {
  state: TrackerState;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const entries = useMemo(() => timeline(state, selectedId ?? undefined), [state, selectedId]);
  const [kind, setKind] = useState<"all" | "task" | "receipt" | "hold" | "retention" | "audit">("all");
  const filtered = entries.filter((e) => kind === "all" || e.kind === kind);
  return (
    <section className="view" aria-labelledby="timeline-title">
      <div className="view-head">
        <div>
          <h1 id="timeline-title" className="view-title">时间线</h1>
          <p className="view-sub">按时间倒序；包含期限变更、计划事件、逐位置回执与审计记录。</p>
        </div>
        <select className="select" aria-label="按数据版本筛选时间线" value={selectedId ?? ""} onChange={(e) => onSelect(e.target.value)}>
          <option value="">全部版本</option>
          {state.versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.datasetName} {v.versionLabel}
            </option>
          ))}
        </select>
      </div>

      <div className="inline-filters">
        {(["all", "task", "receipt", "hold", "retention", "audit"] as const).map((k) => (
          <button key={k} className={`pill ${kind === k ? "pill-active" : ""}`} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
            {timelineKindLabel(k)}
          </button>
        ))}
      </div>

      <Card title="事件" sub={`${filtered.length} 条事件`}>
        {filtered.length === 0 ? <p className="empty">没有匹配的事件。</p> : (
          <div className="timeline">
            {filtered.map((entry) => (
              <div key={entry.id} className={`tl-entry tl-${entry.tone}`}>
                <div className="tl-rail">
                  <span className={`tl-dot tone-${entry.tone}`} aria-hidden="true" />
                </div>
                <div className="tl-body">
                  <div className="tl-head">
                    <span className="tl-title">{entry.title}</span>
                    <span className="mono muted">{formatTimestamp(entry.at)}</span>
                  </div>
                  <p className="tl-detail">{entry.detail}</p>
                  <span className="tl-kind muted small">{timelineKindLabel(entry.kind)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}

function timelineKindLabel(k: string): string {
  switch (k) {
    case "all": return "全部";
    case "task": return "任务";
    case "receipt": return "回执";
    case "hold": return "保留";
    case "retention": return "期限";
    case "audit": return "审计";
    default: return k;
  }
}
