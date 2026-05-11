// Sync worker: pulls fresh data from Instantly + MasterInbox, upserts into Supabase.
// Backfills the last N weeks of weekly_metrics so the dashboard can navigate
// historical weeks without hitting the third-party APIs again.

import { getSupabase } from '../lib/supabase';
import {
  campaignSize,
  dailyAnalytics,
  listAnalytics,
  listCampaigns,
  mapStatus,
  progressPct,
} from '../lib/instantly';
import { addDays, getMondayOf, weekKey } from '../lib/derive';
import { findLabelId, listAllProspects } from '../lib/masterinbox';
import { autoMatchCampaignIds } from '../lib/matchCampaigns';
import { HISTORICAL_WEEKS } from '../lib/types';

interface SyncResult {
  instantly: { ok: boolean; error?: string; campaigns?: number; weeksBackfilled?: number };
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

// All ISO Mondays for the visible window, oldest → newest.
function backfillWindow(): { mondayKeys: string[]; rangeStart: string; rangeEnd: string } {
  const today = new Date();
  const thisMonday = getMondayOf(today);
  const earliest = addDays(thisMonday, -7 * (HISTORICAL_WEEKS - 1));
  const mondayKeys: string[] = [];
  for (let i = 0; i < HISTORICAL_WEEKS; i++) {
    mondayKeys.push(weekKey(addDays(earliest, 7 * i)));
  }
  const rangeStart = weekKey(earliest);
  // End of current week: next Monday minus 1 day = Sunday.
  const rangeEnd = addDays(thisMonday, 6).toISOString().split('T')[0];
  return { mondayKeys, rangeStart, rangeEnd };
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

    const campaignRows = campaigns.map((c) => {
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
    if (campaignRows.length > 0) {
      const { error } = await sb.from('instantly_campaigns').upsert(campaignRows);
      if (error) throw new Error(error.message);
    }

    // AUTO-RELINK every client to its matching campaigns on every sync, using
    // the same whole-name-match rule the seed script and the modal use.
    // Self-heals delete-then-readd: the modal's autoMatch runs against the
    // page's snapshot of campaigns, which can be stale if the user just
    // deleted a client whose orphans were cleaned up. The sync's view is
    // authoritative — re-derive ids from the fresh campaign list.
    const namedCampaigns = campaigns.map((c) => ({ id: c.id, name: c.name }));
    const { data: clientsForRelink } = await sb
      .from('clients')
      .select('id, name, instantly_campaign_ids');
    if (clientsForRelink) {
      for (const c of clientsForRelink as { id: string; name: string; instantly_campaign_ids: string[] }[]) {
        const expected = autoMatchCampaignIds(c.name, namedCampaigns).sort();
        const current = [...(c.instantly_campaign_ids ?? [])].sort();
        const same = expected.length === current.length && expected.every((id, i) => id === current[i]);
        if (!same) {
          await sb.from('clients').update({ instantly_campaign_ids: expected }).eq('id', c.id);
        }
      }
    }

    // Pull each linked campaign's daily-analytics across the entire backfill
    // window once, then bucket per ISO Monday locally. One API call per campaign.
    const { mondayKeys, rangeStart, rangeEnd } = backfillWindow();

    const { data: clients } = await sb
      .from('clients')
      .select('id, instantly_campaign_ids');
    if (!clients) {
      await sb.from('sync_runs').update({ ok: true, finished_at: new Date().toISOString() }).eq('id', run?.id);
      return { ok: true, campaigns: campaignRows.length, weeksBackfilled: 0 };
    }

    // Collect all unique campaign ids referenced by clients.
    const linkedIds = new Set<string>();
    for (const c of clients as { instantly_campaign_ids: string[] }[]) {
      (c.instantly_campaign_ids ?? []).forEach((id) => linkedIds.add(id));
    }

    // campaignId -> weekKey -> sent
    const campaignWeekly = new Map<string, Map<string, number>>();
    for (const cid of linkedIds) {
      try {
        const days = await dailyAnalytics(cid, rangeStart, rangeEnd);
        const buckets = new Map<string, number>();
        for (const d of days) {
          if (!d.date) continue;
          const wk = weekKey(d.date);
          buckets.set(wk, (buckets.get(wk) ?? 0) + (d.sent ?? 0));
        }
        campaignWeekly.set(cid, buckets);
      } catch (err) {
        console.warn(`daily-analytics failed for ${cid}:`, (err as Error).message);
        campaignWeekly.set(cid, new Map());
      }
    }

    // For each client × each week, sum across linked campaigns and upsert.
    const upserts: { client_id: string; week_key: string; emails_sent: number }[] = [];
    for (const c of clients as { id: string; instantly_campaign_ids: string[] }[]) {
      for (const wk of mondayKeys) {
        let total = 0;
        for (const cid of c.instantly_campaign_ids ?? []) {
          total += campaignWeekly.get(cid)?.get(wk) ?? 0;
        }
        upserts.push({ client_id: c.id, week_key: wk, emails_sent: total });
      }
    }

    // Upsert in batches; preserve intros + last_intro_at by passing only emails_sent
    // and relying on the unique constraint to merge.
    if (upserts.length > 0) {
      const { error } = await sb
        .from('weekly_metrics')
        .upsert(upserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
      if (error) throw new Error(error.message);
    }

    await sb.from('sync_runs').update({ ok: true, finished_at: new Date().toISOString() }).eq('id', run?.id);
    return { ok: true, campaigns: campaignRows.length, weeksBackfilled: mondayKeys.length };
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
  if (!process.env.MASTERINBOX_API_KEY) return { ok: true, skipped: true };

  const sb = getSupabase();
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'masterinbox' })
    .select('id')
    .single();

  try {
    const introLabelId = await findLabelId('Introduction');
    if (introLabelId === null) {
      throw new Error('"Introduction" label not found in MasterInbox workspace');
    }

    const prospects = await listAllProspects(100);
    const intros = prospects.filter((p) => p.labels?.includes(introLabelId) && p.campaign_id);

    const { mondayKeys } = backfillWindow();
    const validWeekSet = new Set(mondayKeys);

    // Pick the most reliable "this prospect became an Introduction at T"
    // timestamp. last_message is when the most recent email arrived for the
    // prospect — this is what the MasterInbox UI shows in its date column,
    // and stays put unless the conversation continues. updated_at is too
    // noisy (any edit bumps it), so we only fall back to it if last_message
    // and last_received_at are both missing.
    const introTime = (p: typeof intros[number]): number =>
      p.last_message ?? p.last_received_at ?? p.updated_at;

    // (campaign_id, weekKey) -> { count, latest_ms }
    const byCampaignWeek = new Map<string, { count: number; latest: number }>();
    // campaign_id -> latest_ms (any time, for "Last Intro" fallback)
    const allTimeLatest = new Map<string, number>();

    for (const p of intros) {
      const t = introTime(p);
      const wk = weekKey(new Date(t));

      const allKey = p.campaign_id!;
      if ((allTimeLatest.get(allKey) ?? 0) < t) allTimeLatest.set(allKey, t);

      if (!validWeekSet.has(wk)) continue;
      const key = `${p.campaign_id}|${wk}`;
      const cur = byCampaignWeek.get(key) ?? { count: 0, latest: 0 };
      cur.count++;
      if (t > cur.latest) cur.latest = t;
      byCampaignWeek.set(key, cur);
    }

    const { data: clients } = await sb
      .from('clients')
      .select('id, instantly_campaign_ids');
    if (clients) {
      const upserts: {
        client_id: string;
        week_key: string;
        intros: number;
        last_intro_at: string | null;
      }[] = [];
      for (const c of clients as { id: string; instantly_campaign_ids: string[] }[]) {
        const linkedAllTimeLatest = (c.instantly_campaign_ids ?? [])
          .map((cid) => allTimeLatest.get(cid) ?? 0)
          .reduce((a, b) => Math.max(a, b), 0);

        for (const wk of mondayKeys) {
          let count = 0;
          let latest = 0;
          for (const cid of c.instantly_campaign_ids ?? []) {
            const stats = byCampaignWeek.get(`${cid}|${wk}`);
            if (stats) {
              count += stats.count;
              if (stats.latest > latest) latest = stats.latest;
            }
          }
          // Last Intro: prefer this week's latest, else fall back to all-time
          const ts = latest > 0 ? latest : linkedAllTimeLatest;
          upserts.push({
            client_id: c.id,
            week_key: wk,
            intros: count,
            last_intro_at: ts > 0 ? new Date(ts).toISOString() : null,
          });
        }
      }
      if (upserts.length > 0) {
        const { error } = await sb
          .from('weekly_metrics')
          .upsert(upserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
        if (error) throw new Error(error.message);
      }
    }

    await sb.from('sync_runs').update({ ok: true, finished_at: new Date().toISOString() }).eq('id', run?.id);
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
