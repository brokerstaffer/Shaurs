// Server-side data loader for the dashboard. Reads from Supabase, falls back
// to seed data if the DB hasn't been provisioned yet (so the page renders
// even before migrations run).

import { getSupabase } from './supabase';
import { generateSeed } from './seed';
import type { DashboardClient, InstantlyCampaign, Plan, WeeklyMetric } from './types';
import { weekKey } from './derive';

interface ClientRow {
  id: string;
  name: string;
  plan: Plan;
  weekly_target: number;
  start_date: string | null;
  instantly_campaign_ids: string[];
  masterinbox_identifier: string | null;
  campaign_size: number;
}

interface MetricRow extends WeeklyMetric {}

interface CampaignRow extends InstantlyCampaign {}

export async function loadDashboardClients(weekKeyValue?: string): Promise<{
  clients: DashboardClient[];
  source: 'supabase' | 'seed';
  error?: string;
}> {
  const wk = weekKeyValue ?? weekKey(new Date());

  let sb;
  try {
    sb = getSupabase();
  } catch (err) {
    // Env vars missing — fall back to seed for local preview.
    return { clients: generateSeed(), source: 'seed', error: (err as Error).message };
  }

  const [clientsRes, metricsRes, campaignsRes] = await Promise.all([
    sb.from('clients').select('*').order('name'),
    sb.from('weekly_metrics').select('*').eq('week_key', wk),
    sb.from('instantly_campaigns').select('*'),
  ]);

  if (clientsRes.error) {
    return {
      clients: generateSeed(),
      source: 'seed',
      error: clientsRes.error.message,
    };
  }

  const clients = (clientsRes.data ?? []) as ClientRow[];
  if (clients.length === 0) {
    // DB exists but no clients seeded yet — render empty rather than seed,
    // so the user sees the empty-state CTA.
    return { clients: [], source: 'supabase' };
  }

  const metricsByClient = new Map<string, MetricRow>(
    ((metricsRes.data ?? []) as MetricRow[]).map((m) => [m.client_id, m])
  );
  const campaignsById = new Map<string, CampaignRow>(
    ((campaignsRes.data ?? []) as CampaignRow[]).map((c) => [c.id, c])
  );

  const dashboardClients: DashboardClient[] = clients.map((c) => {
    const linkedCampaigns = (c.instantly_campaign_ids ?? [])
      .map((id) => campaignsById.get(id))
      .filter((x): x is CampaignRow => Boolean(x));

    const metrics: WeeklyMetric = metricsByClient.get(c.id) ?? {
      client_id: c.id,
      week_key: wk,
      emails_sent: 0,
      intros: 0,
      last_intro_at: null,
    };

    return {
      id: c.id,
      name: c.name,
      plan: c.plan,
      weekly_target: c.weekly_target,
      start_date: c.start_date,
      instantly_campaign_ids: c.instantly_campaign_ids ?? [],
      masterinbox_identifier: c.masterinbox_identifier,
      campaign_size: c.campaign_size ?? 0,
      campaigns: linkedCampaigns,
      metrics,
    };
  });

  return { clients: dashboardClients, source: 'supabase' };
}
