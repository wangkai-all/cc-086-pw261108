import { useMemo, useState } from "react";
import { formatTimestamp } from "../domain/time";
import type { Receipt, Replica } from "../domain/types";

/* ------------------------------------------------------------------------- */
/* 基础元件                                                                   */
/* ------------------------------------------------------------------------- */

export type StatusTone = "ok" | "warn" | "bad" | "muted";

export function StatusDot({ tone }: { tone: StatusTone }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />;
}

export function StatusChip({
  tone,
  children,
  icon,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  icon?: string;
}) {
  return (
    <span className={`chip chip-${tone}`}>
      <span aria-hidden="true">{icon ?? iconFor(tone)}</span>
      {children}
    </span>
  );
}

function iconFor(tone: StatusTone): string {
  switch (tone) {
    case "ok": return "✓";
    case "warn": return "!";
    case "bad": return "✕";
    case "muted": return "·";
  }
}

export function StatTile({
  label,
  value,
  unit,
  sub,
  tone = "muted",
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub?: string;
  tone?: StatusTone;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </span>
      {sub ? (
        <span className={`stat-sub stat-sub-${tone}`}>
          {tone !== "muted" ? <StatusDot tone={tone} /> : null}
          {sub}
        </span>
      ) : null}
    </div>
  );
}

/** 细分段条：一整个任务按状态拆分；颜色之外总伴随数字文本。 */
export function CoverageBar({
  segments,
  total,
  ariaLabel,
}: {
  segments: { key: string; value: number; tone: "ok" | "bad" | "warn" | "muted"; label: string }[];
  total: number;
  ariaLabel: string;
}) {
  return (
    <div className="coverage" role="img" aria-label={ariaLabel}>
      <div className="coverage-track">
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <span
              key={s.key}
              className={`coverage-seg cov-${s.tone}`}
              style={{ flexGrow: s.value }}
              title={`${s.label}：${s.value} / ${total}`}
            />
          ))}
        {total === 0 ? <span className="coverage-empty" /> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* 距到期天数 · 发散条形                                                      */
/* ------------------------------------------------------------------------- */

export interface ExpiryDatum {
  id: string;
  label: string;
  sublabel: string;
  daysLeft: number;
  expiry: string;
  copies: string;
}

export function ExpiryChart({ data }: { data: ExpiryDatum[] }) {
  const [hover, setHover] = useState<{ datum: ExpiryDatum; x: number; y: number } | null>(null);
  const [showTable, setShowTable] = useState(false);
  const maxAbs = useMemo(
    () => Math.max(1, ...data.map((d) => Math.abs(d.daysLeft))),
    [data],
  );
  /**
   * 轴域：以 0 为对称中心。条最长为轴域的一半，最长条只占 70%，
   * 这样条端标签（"−50 天"）不会顶出绘图区。
   */
  const { limit, tickStep } = useMemo(() => {
    const base = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    const unit = base.find((c) => maxAbs / c <= 6) ?? 1000;
    let axisLimit = Math.max(unit, Math.ceil(maxAbs / unit) * unit);
    while (maxAbs / axisLimit > 0.7) axisLimit += unit;
    const tickUnit = base.find((c) => (2 * axisLimit) / c <= 8) ?? 1000;
    return { limit: axisLimit, tickStep: tickUnit };
  }, [maxAbs]);
  const scale = (value: number) => 50 + (value / limit) * 50;

  const ticks = useMemo(() => {
    if (!data.length) return [];
    const bound = Math.floor(limit / tickStep) * tickStep;
    const out: number[] = [];
    for (let v = -bound; v <= bound; v += tickStep) out.push(v);
    return out;
  }, [limit, tickStep, data.length]);

  if (!data.length) {
    return <p className="empty">当前筛选范围内没有即将过期的数据版本。</p>;
  }

  return (
    <figure className="chart">
      <div className="chart-head">
        <div>
          <h3 className="chart-title">距到期天数</h3>
          <p className="chart-sub">今天为 0 天；左侧是已过期天数，右侧是剩余天数。</p>
        </div>
        <button
          className="ghost-btn"
          type="button"
          aria-expanded={showTable}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? "收起数据表" : "查看数据表"}
        </button>
      </div>

      <div className="legend">
        <span className="legend-item">
          <span className="legend-swatch swatch-overdue" /> 已过期
        </span>
        <span className="legend-item">
          <span className="legend-swatch swatch-remaining" /> 尚未到期
        </span>
      </div>

      <div className="diverging" onMouseLeave={() => setHover(null)}>
        <div className="axis-layer" aria-hidden="true">
          {ticks.map((t) => (
            <div
              key={t}
              className={`gridline ${t === 0 ? "gridline-zero" : ""}`}
              style={{ left: `${scale(t)}%` }}
            >
              <span className="tick">{t === 0 ? "今天" : `${t > 0 ? "+" : ""}${t}`}</span>
            </div>
          ))}
        </div>

        {data.map((d) => {
          const overdue = d.daysLeft < 0;
          const width = Math.max((Math.abs(d.daysLeft) / limit) * 50, 0.6);
          const tip = scale(d.daysLeft);
          const showTipLabel = overdue ? tip >= 26 : tip <= 80;
          return (
            <div key={d.id} className="div-row">
              <div className="div-label">
                <span className="div-label-main">{d.label}</span>
                <span className="div-label-sub">{d.sublabel}</span>
              </div>
              <div className="div-plot">
                <span
                  className={`div-bar ${overdue ? "bar-overdue" : "bar-remaining"}`}
                  style={{
                    width: `${width}%`,
                    left: overdue ? `${scale(d.daysLeft)}%` : "50%",
                  }}
                  tabIndex={0}
                  role="img"
                  aria-label={`${d.label} ${d.sublabel}，${overdue ? `已过期 ${Math.abs(d.daysLeft)} 天` : `剩余 ${d.daysLeft} 天`}，到期日 ${d.expiry}，${d.copies}`}
                  onMouseEnter={(e) => setHover({ datum: d, x: e.clientX, y: e.clientY })}
                  onMouseMove={(e) => setHover({ datum: d, x: e.clientX, y: e.clientY })}
                  onFocus={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    setHover({ datum: d, x: box.left, y: box.top });
                  }}
                  onBlur={() => setHover(null)}
                />
                <span
                  className={`div-value ${overdue ? "value-overdue" : ""}`}
                  style={
                    showTipLabel
                      ? overdue
                        ? { right: `${100 - tip}%`, marginRight: 7 }
                        : { left: `${tip}%`, marginLeft: 7 }
                      : overdue
                        ? { left: 6 }
                        : { right: 6 }
                  }
                  aria-hidden="true"
                >
                  {overdue ? `−${Math.abs(d.daysLeft)} 天` : `剩 ${d.daysLeft} 天`}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {showTable ? (
        <div className="table-wrap chart-table">
          <table>
            <thead>
              <tr>
                <th scope="col">数据版本</th>
                <th scope="col">到期日</th>
                <th scope="col" className="num">距到期（天）</th>
                <th scope="col">副本状态</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.id}>
                  <td>{d.label}</td>
                  <td className="mono">{d.expiry}</td>
                  <td className="num mono">{d.daysLeft}</td>
                  <td className="muted">{d.copies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {hover ? (
        <div
          className="tooltip"
          style={{ left: Math.min(hover.x + 14, window.innerWidth - 250), top: hover.y + 14 }}
          role="tooltip"
        >
          <div className="tooltip-value">
            {hover.datum.daysLeft < 0
              ? `已过期 ${Math.abs(hover.datum.daysLeft)} 天`
              : `剩余 ${hover.datum.daysLeft} 天`}
          </div>
          <div className="tooltip-name">{hover.datum.label}</div>
          <div className="tooltip-line">
            <span className="tooltip-key">到期日</span>
            <span className="mono">{hover.datum.expiry}</span>
          </div>
          <div className="tooltip-line">
            <span className="tooltip-key">副本</span>
            <span>{hover.datum.copies}</span>
          </div>
        </div>
      ) : null}
    </figure>
  );
}

/* ------------------------------------------------------------------------- */
/* 回执                                                                       */
/* ------------------------------------------------------------------------- */

export function ReceiptRow({ receipt }: { receipt: Receipt }) {
  const tone: StatusTone =
    receipt.outcome === "succeeded" ? "ok" : receipt.outcome === "failed" ? "bad" : "muted";
  return (
    <div className={`receipt receipt-${tone}`}>
      <div className="receipt-head">
        <StatusChip tone={tone}>
          {receipt.outcome === "succeeded" ? "成功" : receipt.outcome === "failed" ? "失败" : "未执行"}
        </StatusChip>
        <span className="receipt-loc">{receipt.locationName}</span>
        <span className="receipt-attempt mono">
          {receipt.attempt > 0 ? `第 ${receipt.attempt} 次` : "—"}
        </span>
        <span className="receipt-at mono">{formatTimestamp(receipt.at)}</span>
      </div>
      <p className="receipt-msg">{receipt.message}</p>
      <span className="receipt-id mono">{receipt.id}</span>
    </div>
  );
}
