// Server-side data loader. Pulls the last N weeks of metrics in a single
// query so the dashboard can switch weeks client-side without re-fetching.

import { getSupabase } from './supabase';
import { generateSeed } from './seed';
import {
  HISTORICAL_WEEKS,
  type DashboardClient,
  type InstantlyCampaign,
  type Plan,
  type WeeklyMetric,
} from './types';
import { addDays, getMondayOf, weekKey } from './derive';

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

export async function loadDashboardClients(): Promise<{
  clients: DashboardClient[];
  source: 'supabase' | 'seed';
  error?: string;
}> {
  let sb;
  try {
    sb = getSupabase();
  } catch (err) {
    return { clients: generateSeed(), source: 'seed', error: (err as Error).message };
  }

  // Sliding window: this Monday minus N-1 weeks.
  const earliestMonday = weekKey(addDays(getMondayOf(new Date()), -7 * (HISTORICAL_WEEKS - 1)));

  const [clientsRes, metricsRes, campaignsRes] = await Promise.all([
    sb.from('clients').select('*').order('name'),
    sb.from('weekly_metrics').select('*').gte('week_key', earliestMonday),
    sb.from('instantly_campaigns').select('*'),
  ]);

  if (clientsRes.error) {
    return { clients: generateSeed(), source: 'seed', error: clientsRes.error.message };
  }

  const clients = (clientsRes.data ?? []) as ClientRow[];
  if (clients.length === 0) return { clients: [], source: 'supabase' };

  const metricsByClient = new Map<string, Record<string, WeeklyMetric>>();
  for (const m of (metricsRes.data ?? []) as WeeklyMetric[]) {
    let bucket = metricsByClient.get(m.client_id);
    if (!bucket) {
      bucket = {};
      metricsByClient.set(m.client_id, bucket);
    }
    bucket[m.week_key] = m;
  }

  const campaignsById = new Map<string, InstantlyCampaign>(
    ((campaignsRes.data ?? []) as InstantlyCampaign[]).map((c) => [c.id, c])
  );

  const dashboardClients: DashboardClient[] = clients.map((c) => {
    const linkedCampaigns = (c.instantly_campaign_ids ?? [])
      .map((id) => campaignsById.get(id))
      .filter((x): x is InstantlyCampaign => Boolean(x));

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
      metricsByWeek: metricsByClient.get(c.id) ?? {},
    };
  });

  return { clients: dashboardClients, source: 'supabase' };
}
