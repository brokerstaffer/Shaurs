export type Plan = 'minimum' | 'production' | 'partner';

export type CampaignStatus = 'running' | 'paused' | 'finished';

export interface InstantlyCampaign {
  id: string;
  name: string;
  status: CampaignStatus | null;
  emails_sent_total: number;
  campaign_size: number;
  progress_pct: number; // 0-100
}

export interface Client {
  id: string;
  name: string;
  plan: Plan;
  weekly_target: number;
  start_date: string | null; // ISO date
  instantly_campaign_ids: string[];
  masterinbox_identifier: string | null;
  campaign_size: number;
}

export interface WeeklyMetric {
  client_id: string;
  week_key: string; // YYYY-MM-DD (Monday)
  emails_sent: number;
  intros: number;
  last_intro_at: string | null;
}

export interface DashboardClient extends Client {
  campaigns: InstantlyCampaign[];
  metrics: WeeklyMetric;
}

export const PLAN_LABEL: Record<Plan, string> = {
  minimum: 'Minimum',
  production: 'Production',
  partner: 'Partner',
};

export const PLAN_BADGE_CLASS: Record<Plan, string> = {
  minimum: 'plan-min',
  production: 'plan-prod',
  partner: 'plan-partner',
};

export const PLAN_DEFAULT_TARGET: Record<Plan, number> = {
  minimum: 1,
  production: 3,
  partner: 6,
};
