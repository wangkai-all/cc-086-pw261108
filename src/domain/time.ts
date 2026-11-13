import type { IsoDate } from "./types";

/** 纯日历日运算：一律用 UTC 正午做锚点，避免 DST / 时区把日期挪一天。 */
function toUtcNoon(iso: IsoDate): Date {
  return new Date(`${iso.slice(0, 10)}T12:00:00.000Z`);
}

export function formatDate(iso: IsoDate): IsoDate {
  return iso.slice(0, 10);
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  const d = toUtcNoon(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = toUtcNoon(from).getTime();
  const b = toUtcNoon(to).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function expiryFor(createdAt: IsoDate, retentionDays: number): IsoDate {
  return addDays(formatDate(createdAt), retentionDays);
}

export function formatTimestamp(iso: string): string {
  if (!iso) return "";
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return time ? `${date} ${time}` : date;
}

export type Urgency = "overdue" | "due" | "due-soon" | "not-due";

export interface RetentionStatus {
  expiry: IsoDate;
  daysLeft: number;
  urgency: Urgency;
}

/** daysLeft < 0 即已过期；= 0 今日到期；<= 14 天视为"即将过期"。 */
export function retentionStatus(
  createdAt: IsoDate,
  retentionDays: number,
  today: IsoDate,
): RetentionStatus {
  const expiry = expiryFor(createdAt, retentionDays);
  const daysLeft = daysBetween(today, expiry);
  let urgency: Urgency;
  if (daysLeft < 0) urgency = "overdue";
  else if (daysLeft === 0) urgency = "due";
  else if (daysLeft <= 14) urgency = "due-soon";
  else urgency = "not-due";
  return { expiry, daysLeft, urgency };
}

export function urgencyLabel(u: Urgency): string {
  switch (u) {
    case "overdue": return "已过期";
    case "due": return "今日到期";
    case "due-soon": return "即将过期";
    case "not-due": return "未到期";
  }
}
