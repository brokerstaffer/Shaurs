// Sync worker: pulls fresh data from Instantly + MasterInbox, upserts into Supabase.
//
// Usage:
//   - Triggered manually by `POST /api/sync/run` (also imported by route).
//   - Run on a Railway cron service: `tsx scripts/sync.ts` every 15 min.
//
// Environment required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   INSTANTLY_API_KEY,
//   MASTERINBOX_API_KEY  (optional until docs land — sync skips MasterInbox if missing)

import { getSupabase } from '../lib/supabase';
import {
  campaignSize,
  dailyAnalytics,
  listAnalytics,
  listCampaigns,
  mapStatus,
  progressPct,
} from '../lib/instantly';
import { addDays, weekKey } from '../lib/derive';
import { findLabelId, listAllProspects, filterIntros } from '../lib/masterinbox';

interface SyncResult {
  instantly: { ok: boolean; error?: string; campaigns?: number };
  masterinbox: { ok: boolean; error?: string; intros?: number; skipped?: boolean };
}

export async function runSync(): Promise<SyncResult> {
  const result: SyncResult = {
    instantly: { ok: false },
    masterinbox: { ok: false },
  };

  result.instantly = await runInstantly();
  result.masterinbox = await runMasterInbox();

  return result;
}

async function runInstantly(): Promise<SyncResult['instantly']> {
  const sb = getSupabase();
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'instantly' })
    .select('id')
    .single();

  try {
    const [campaigns, analytics] = await Promise.all([listCampaigns(), listAnalytics()]);

    const analyticsById = new Map(analytics.map((a) => [a.campaign_id, a]));

    const rows = campaigns.map((c) => {
      const a = analyticsById.get(c.id);
      return {
        id: c.id,
        name: c.name,
        status: mapStatus(c.status ?? a?.campaign_status),
        emails_sent_total: a?.emails_sent_count ?? 0,
        campaign_size: a ? campaignSize(a) : 0,
        progress_pct: a ? Number(progressPct(a).toFixed(2)) : 0,
      };
    });

    if (rows.length > 0) {
      const { error } = await sb.from('instantly_campaigns').upsert(rows);
      if (error) throw new Error(error.message);
    }

    // Per-week emails per client: sum daily-analytics across each client's
    // linked campaign IDs for the current ISO week.
    const monday = weekKey(new Date());
    const sunday = addDays(monday, 6).toISOString().split('T')[0];

    const { data: clients } = await sb
      .from('clients')
      .select('id, instantly_campaign_ids');

    if (clients && clients.length > 0) {
      // Walk each client and call daily-analytics per campaign.
      // Volume here is N_clients * avg_campaigns_per_client which is fine for ~24 clients.
      for (const c of clients as { id: string; instantly_campaign_ids: string[] }[]) {
        let total = 0;
        for (const cid of c.instantly_campaign_ids ?? []) {
          try {
            const days = await dailyAnalytics(cid, monday, sunday);
            total += days.reduce((acc, d) => acc + (d.sent ?? 0), 0);
          } catch (err) {
            // One bad campaign id shouldn't tank the whole sync — log and continue.
            console.warn(`daily-analytics failed for ${cid}:`, (err as Error).message);
          }
        }
        await sb.from('weekly_metrics').upsert(
          { client_id: c.id, week_key: monday, emails_sent: total },
          { onConflict: 'client_id,week_key', ignoreDuplicates: false }
        );
      }
    }

    await sb
      .from('sync_runs')
      .update({ ok: true, finished_at: new Date().toISOString() })
      .eq('id', run?.id);
    return { ok: true, campaigns: rows.length };
  } catch (err) {
    const message = (err as Error).message;
    await sb
      .from('sync_runs')
      .update({ ok: false, error: message, finished_at: new Date().toISOString() })
      .eq('id', run?.id);
    return { ok: false, error: message };
  }
}

async function runMasterInbox(): Promise<SyncResult['masterinbox']> {
  if (!process.env.MASTERINBOX_API_KEY) {
    return { ok: true, skipped: true };
  }

  const sb = getSupabase();
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'masterinbox' })
    .select('id')
    .single();

  try {
    // 1. Find the "Introduction" label id
    const introLabelId = await findLabelId('Introduction');
    if (introLabelId === null) {
      throw new Error('"Introduction" label not found in MasterInbox workspace');
    }

    // 2. Pull all prospects (server-side filters are silently ignored)
    const prospects = await listAllProspects(100);

    // 3. Filter to prospects labeled Introduction within current ISO week,
    //    using updated_at as the best available "labeled at" proxy.
    const monday = weekKey(new Date());
    const sundayDate = addDays(monday, 7); // exclusive end (next Monday 00:00)
    const startMs = new Date(monday + 'T00:00:00').getTime();
    const endMs = sundayDate.getTime();

    const intros = filterIntros(prospects, introLabelId, startMs, endMs);

    // 4. Roll up by Instantly campaign_id, since clients link to Instantly campaigns.
    const byCampaign = new Map<string, { count: number; latest: number | null }>();
    for (const p of intros) {
      if (!p.campaign_id) continue;
      const cur = byCampaign.get(p.campaign_id) ?? { count: 0, latest: null };
      cur.count++;
      if (!cur.latest || p.updated_at > cur.latest) cur.latest = p.updated_at;
      byCampaign.set(p.campaign_id, cur);
    }

    // For "Last Intro" we also want the most recent intro EVER, regardless of
    // week. Compute per-campaign max(updated_at) over all-time intros too.
    const allIntros = prospects.filter((p) => p.labels?.includes(introLabelId));
    const allTimeLatestByCampaign = new Map<string, number>();
    for (const p of allIntros) {
      if (!p.campaign_id) continue;
      const cur = allTimeLatestByCampaign.get(p.campaign_id) ?? 0;
      if (p.updated_at > cur) allTimeLatestByCampaign.set(p.campaign_id, p.updated_at);
    }

    // 5. Upsert per-client weekly metrics by summing across each client's
    //    linked Instantly campaigns.
    const { data: clients } = await sb
      .from('clients')
      .select('id, instantly_campaign_ids');
    if (clients) {
      for (const c of clients as { id: string; instantly_campaign_ids: string[] }[]) {
        let count = 0;
        let latestThisWeek: number | null = null;
        let latestAllTime: number | null = null;
        for (const cid of c.instantly_campaign_ids ?? []) {
          const week = byCampaign.get(cid);
          if (week) {
            count += week.count;
            if (week.latest && (!latestThisWeek || week.latest > latestThisWeek)) latestThisWeek = week.latest;
          }
          const all = allTimeLatestByCampaign.get(cid);
          if (all && (!latestAllTime || all > latestAllTime)) latestAllTime = all;
        }
        const lastIntroIso =
          (latestThisWeek ?? latestAllTime)
            ? new Date((latestThisWeek ?? latestAllTime) as number).toISOString()
            : null;
        await sb.from('weekly_metrics').upsert(
          {
            client_id: c.id,
            week_key: monday,
            intros: count,
            last_intro_at: lastIntroIso,
          },
          { onConflict: 'client_id,week_key', ignoreDuplicates: false }
        );
      }
    }

    await sb
      .from('sync_runs')
      .update({ ok: true, finished_at: new Date().toISOString() })
      .eq('id', run?.id);
    return { ok: true, intros: intros.length };
  } catch (err) {
    const message = (err as Error).message;
    await sb
      .from('sync_runs')
      .update({ ok: false, error: message, finished_at: new Date().toISOString() })
      .eq('id', run?.id);
    return { ok: false, error: message };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSync()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.instantly.ok && r.masterinbox.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
