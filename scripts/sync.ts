// Sync worker: pulls fresh data from Instantly + EmailBison + MasterInbox,
// upserts into Supabase. Backfills the last N weeks of weekly_metrics so the
// dashboard can navigate historical weeks without hitting the third-party APIs
// again.

import { getSupabase } from '../lib/supabase';
import {
  campaignSize,
  dailyAnalytics,
  listAnalytics,
  listCampaigns,
  mapStatus,
  progressPct,
} from '../lib/instantly';
import {
  bisonCampaignSize,
  bisonDailySent,
  bisonProgressPct,
  listBisonCampaigns,
  mapBisonStatus,
} from '../lib/bison';
import { addDays, getMondayOf, weekKey } from '../lib/derive';
import { findLabelId, listAllProspects } from '../lib/masterinbox';
import { autoMatchCampaignIds } from '../lib/matchCampaigns';
import { HISTORICAL_WEEKS } from '../lib/types';

interface SyncResult {
  instantly: { ok: boolean; error?: string; campaigns?: number; weeksBackfilled?: number };
  bison: { ok: boolean; error?: string; campaigns?: number; weeksBackfilled?: number; skipped?: boolean };
  masterinbox: { ok: boolean; error?: string; intros?: number; skipped?: boolean };
}

export async function runSync(): Promise<SyncResult> {
  const result: SyncResult = {
    instantly: { ok: false },
    bison: { ok: false },
    masterinbox: { ok: false },
  };
  result.instantly = await runInstantly();
  result.bison = await runBison();
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

// Decide the new status_changed_at value for a campaign. Returns undefined to
// mean "leave the existing DB value alone" (no field in the upsert payload).
//
//   1. Real transition observed (prev status differs from new) → now()
//   2. Status is paused/finished AND no stamp on file yet → seed from the
//      vendor's updated_at. Covers both "first time we see this campaign" AND
//      "existing row from before the migration added status_changed_at".
//   3. Otherwise → undefined (preserve current value).
function deriveStatusChangedAt(
  newStatus: 'running' | 'paused' | 'finished' | null,
  prevStatus: string | null | undefined,
  prevStatusChangedAt: string | null | undefined,
  apiUpdatedAt: string | null | undefined
): string | null | undefined {
  const prev = prevStatus ?? null;
  const next = newStatus ?? null;
  const isTransition = prevStatus !== undefined && prev !== next;
  if (isTransition) return new Date().toISOString();
  if ((next === 'paused' || next === 'finished') && !prevStatusChangedAt) {
    return apiUpdatedAt ?? new Date().toISOString();
  }
  return undefined;
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

    // Load existing rows to detect status transitions.
    const { data: existingRows } = await sb
      .from('instantly_campaigns')
      .select('id, status, status_changed_at');
    const existingById = new Map<string, { status: string | null; status_changed_at: string | null }>(
      ((existingRows ?? []) as { id: string; status: string | null; status_changed_at: string | null }[]).map(
        (r) => [r.id, { status: r.status, status_changed_at: r.status_changed_at }]
      )
    );

    const campaignRows = campaigns.map((c) => {
      const a = analyticsById.get(c.id);
      const newStatus = mapStatus(c.status ?? a?.campaign_status);
      const prev = existingById.get(c.id);
      const stamp = deriveStatusChangedAt(
        newStatus,
        prev ? prev.status : undefined,
        prev?.status_changed_at,
        c.timestamp_updated
      );
      const base: {
        id: string;
        name: string;
        status: ReturnType<typeof mapStatus>;
        emails_sent_total: number;
        campaign_size: number;
        progress_pct: number;
        status_changed_at?: string | null;
      } = {
        id: c.id,
        name: c.name,
        status: newStatus,
        emails_sent_total: a?.emails_sent_count ?? 0,
        campaign_size: a ? campaignSize(a) : 0,
        progress_pct: a ? Number(progressPct(a).toFixed(2)) : 0,
      };
      // Only include status_changed_at in the upsert payload when we actually
      // want to write it (undefined means "leave existing value alone").
      if (stamp !== undefined) base.status_changed_at = stamp;
      return base;
    });
    if (campaignRows.length > 0) {
      const { error } = await sb.from('instantly_campaigns').upsert(campaignRows);
      if (error) throw new Error(error.message);
    }

    // AUTO-RELINK every client to its matching campaigns on every sync.
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

    // For each client × each week, sum across linked Instantly campaigns and upsert.
    // NOTE: emails_sent here is the Instantly subtotal. runBison() ADDs to this
    // row in a second upsert (read-modify-write) so the final value is the
    // combined cross-source total.
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

async function runBison(): Promise<SyncResult['bison']> {
  if (!process.env.BISON_API_KEY) return { ok: true, skipped: true };

  const sb = getSupabase();
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'bison' })
    .select('id')
    .single();

  try {
    const campaigns = await listBisonCampaigns();

    // Load existing rows to detect status transitions.
    const { data: existingRows } = await sb
      .from('bison_campaigns')
      .select('id, status, status_changed_at');
    const existingById = new Map<string, { status: string | null; status_changed_at: string | null }>(
      ((existingRows ?? []) as { id: string; status: string | null; status_changed_at: string | null }[]).map(
        (r) => [r.id, { status: r.status, status_changed_at: r.status_changed_at }]
      )
    );

    const campaignRows = campaigns.map((c) => {
      const newStatus = mapBisonStatus(c.status);
      const prev = existingById.get(c.uuid);
      const stamp = deriveStatusChangedAt(
        newStatus,
        prev ? prev.status : undefined,
        prev?.status_changed_at,
        c.updated_at
      );
      const base: {
        id: string;
        name: string;
        status: ReturnType<typeof mapBisonStatus>;
        emails_sent_total: number;
        campaign_size: number;
        progress_pct: number;
        status_changed_at?: string | null;
      } = {
        id: c.uuid,
        name: c.name,
        status: newStatus,
        emails_sent_total: c.emails_sent ?? 0,
        campaign_size: bisonCampaignSize(c),
        progress_pct: Number(bisonProgressPct(c).toFixed(2)),
      };
      if (stamp !== undefined) base.status_changed_at = stamp;
      return base;
    });
    if (campaignRows.length > 0) {
      const { error } = await sb.from('bison_campaigns').upsert(campaignRows);
      if (error) throw new Error(error.message);
    }

    // Auto-relink Bison campaigns to clients using the same whole-name match.
    const namedCampaigns = campaigns.map((c) => ({ id: c.uuid, name: c.name }));
    const { data: clientsForRelink } = await sb
      .from('clients')
      .select('id, name, bison_campaign_ids');
    if (clientsForRelink) {
      for (const c of clientsForRelink as { id: string; name: string; bison_campaign_ids: string[] }[]) {
        const expected = autoMatchCampaignIds(c.name, namedCampaigns).sort();
        const current = [...(c.bison_campaign_ids ?? [])].sort();
        const same = expected.length === current.length && expected.every((id, i) => id === current[i]);
        if (!same) {
          await sb.from('clients').update({ bison_campaign_ids: expected }).eq('id', c.id);
        }
      }
    }

    const { mondayKeys, rangeStart, rangeEnd } = backfillWindow();

    const { data: clients } = await sb
      .from('clients')
      .select('id, bison_campaign_ids');
    if (!clients) {
      await sb.from('sync_runs').update({ ok: true, finished_at: new Date().toISOString() }).eq('id', run?.id);
      return { ok: true, campaigns: campaignRows.length, weeksBackfilled: 0 };
    }

    const linkedIds = new Set<string>();
    for (const c of clients as { bison_campaign_ids: string[] }[]) {
      (c.bison_campaign_ids ?? []).forEach((id) => linkedIds.add(id));
    }

    const campaignWeekly = new Map<string, Map<string, number>>();
    for (const cid of linkedIds) {
      try {
        const days = await bisonDailySent(cid, rangeStart, rangeEnd);
        const buckets = new Map<string, number>();
        for (const d of days) {
          if (!d.date) continue;
          const wk = weekKey(d.date);
          buckets.set(wk, (buckets.get(wk) ?? 0) + (d.sent ?? 0));
        }
        campaignWeekly.set(cid, buckets);
      } catch (err) {
        console.warn(`bison daily-sent failed for ${cid}:`, (err as Error).message);
        campaignWeekly.set(cid, new Map());
      }
    }

    // Read existing weekly_metrics rows so we can ADD Bison sent on top of the
    // Instantly subtotal that runInstantly already wrote. Avoids the two
    // sources clobbering each other.
    const earliestKey = mondayKeys[0];
    const { data: existingMetrics } = await sb
      .from('weekly_metrics')
      .select('client_id, week_key, emails_sent')
      .gte('week_key', earliestKey);
    const existingByKey = new Map<string, number>();
    for (const m of (existingMetrics ?? []) as { client_id: string; week_key: string; emails_sent: number }[]) {
      existingByKey.set(`${m.client_id}|${m.week_key}`, m.emails_sent ?? 0);
    }

    const upserts: { client_id: string; week_key: string; emails_sent: number }[] = [];
    for (const c of clients as { id: string; bison_campaign_ids: string[] }[]) {
      for (const wk of mondayKeys) {
        let bisonTotal = 0;
        for (const cid of c.bison_campaign_ids ?? []) {
          bisonTotal += campaignWeekly.get(cid)?.get(wk) ?? 0;
        }
        if (bisonTotal === 0) continue; // nothing to add for this cell
        const prev = existingByKey.get(`${c.id}|${wk}`) ?? 0;
        upserts.push({ client_id: c.id, week_key: wk, emails_sent: prev + bisonTotal });
      }
    }

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

    const introTime = (p: typeof intros[number]): number =>
      p.last_message ?? p.last_received_at ?? p.updated_at;

    const byCampaignWeek = new Map<string, { count: number; latest: number }>();
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
      .select('id, instantly_campaign_ids, bison_campaign_ids');
    if (clients) {
      const upserts: {
        client_id: string;
        week_key: string;
        intros: number;
        last_intro_at: string | null;
      }[] = [];
      for (const c of clients as { id: string; instantly_campaign_ids: string[]; bison_campaign_ids: string[] }[]) {
        // Union both sources — MasterInbox prospect.campaign_id will match
        // whichever vendor the email came from (Instantly UUIDs and Bison
        // UUIDs can't collide).
        const allLinked = [...(c.instantly_campaign_ids ?? []), ...(c.bison_campaign_ids ?? [])];

        const linkedAllTimeLatest = allLinked
          .map((cid) => allTimeLatest.get(cid) ?? 0)
          .reduce((a, b) => Math.max(a, b), 0);

        for (const wk of mondayKeys) {
          let count = 0;
          let latest = 0;
          for (const cid of allLinked) {
            const stats = byCampaignWeek.get(`${cid}|${wk}`);
            if (stats) {
              count += stats.count;
              if (stats.latest > latest) latest = stats.latest;
            }
          }
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
      const allOk =
        r.instantly.ok &&
        r.bison.ok &&
        r.masterinbox.ok;
      process.exit(allOk ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
