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
import { listIntroductionLeads, type MasterInboxLead } from '../lib/masterinbox';

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
    const monday = weekKey(new Date());
    const sunday = addDays(monday, 6).toISOString().split('T')[0];
    const leads = await listIntroductionLeads(monday, sunday);

    const byIdent = new Map<string, { count: number; latest: string | null }>();
    leads.forEach((lead: MasterInboxLead) => {
      const id = lead.client_identifier;
      if (!id) return;
      const cur = byIdent.get(id) ?? { count: 0, latest: null };
      cur.count++;
      if (lead.labeled_at && (!cur.latest || lead.labeled_at > cur.latest)) {
        cur.latest = lead.labeled_at;
      }
      byIdent.set(id, cur);
    });

    const { data: clients } = await sb.from('clients').select('id, masterinbox_identifier');
    if (clients) {
      for (const c of clients as { id: string; masterinbox_identifier: string | null }[]) {
        if (!c.masterinbox_identifier) continue;
        const stats = byIdent.get(c.masterinbox_identifier) ?? { count: 0, latest: null };
        await sb.from('weekly_metrics').upsert(
          {
            client_id: c.id,
            week_key: monday,
            intros: stats.count,
            last_intro_at: stats.latest,
          },
          { onConflict: 'client_id,week_key', ignoreDuplicates: false }
        );
      }
    }

    await sb
      .from('sync_runs')
      .update({ ok: true, finished_at: new Date().toISOString() })
      .eq('id', run?.id);
    return { ok: true, intros: leads.length };
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
