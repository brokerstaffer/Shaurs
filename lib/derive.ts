import type { DashboardClient } from './types';

export function getMondayOf(d: Date | string): Date {
  const date = new Date(d);
  const day = date.getDay();
  date.setDate(date.getDate() - day + (day === 0 ? -6 : 1));
  date.setHours(0, 0, 0, 0);
  return date;
}

export function weekKey(d: Date | string): string {
  return getMondayOf(d).toISOString().split('T')[0];
}

export function addDays(d: Date | string, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatWeek(monday: Date): string {
  return `${fmtDate(monday)} – ${fmtDate(addDays(monday, 6))}`;
}

export function isCurrentWeek(key: string): boolean {
  return key === weekKey(new Date());
}

export function daysSinceLastIntro(lastIntroAt: string | null | undefined): number | null {
  if (!lastIntroAt) return null;
  const last = new Date(lastIntroAt);
  last.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - last.getTime()) / 86400000);
}

export interface DerivedRow {
  emails: number;
  intros: number;
  hasEmails: boolean;
  hasIntros: boolean;
  metTarget: boolean;
  status: 'risk' | 'ok' | 'pending';
  convPct: number | null;
  convClass: 'good' | 'mid' | 'low' | 'none';
  leftThisWeek: number; // 0 if met
  daysSince: number | null;
  campaignsAvgPct: number;
}

export function derive(c: DashboardClient): DerivedRow {
  const m = c.metrics;
  const hasEmails = m.emails_sent > 0;
  const hasIntros = m.intros > 0 || m.last_intro_at !== null;
  // For status thresholds we treat the metric as known if any sync has happened.
  // The dashboard sets emails_sent/intros to 0 when no data, which is meaningful in itself.
  const intros = m.intros;
  const emails = m.emails_sent;

  const metTarget = c.weekly_target > 0 && intros >= c.weekly_target;
  // Per spec: At Risk if below half of weekly target, On Track otherwise.
  const status: 'risk' | 'ok' | 'pending' = c.weekly_target === 0
    ? 'pending'
    : intros < c.weekly_target / 2
      ? 'risk'
      : 'ok';

  let convPct: number | null = null;
  let convClass: 'good' | 'mid' | 'low' | 'none' = 'none';
  if (emails > 0) {
    convPct = (intros / emails) * 100;
    convClass = convPct >= 5 ? 'good' : convPct >= 2 ? 'mid' : 'low';
  }

  const leftThisWeek = Math.max(0, c.weekly_target - intros);

  const campaignsAvgPct = c.campaigns.length > 0
    ? c.campaigns.reduce((a, b) => a + (b.progress_pct || 0), 0) / c.campaigns.length
    : 0;

  return {
    emails,
    intros,
    hasEmails,
    hasIntros,
    metTarget,
    status,
    convPct,
    convClass,
    leftThisWeek,
    daysSince: daysSinceLastIntro(m.last_intro_at),
    campaignsAvgPct,
  };
}
