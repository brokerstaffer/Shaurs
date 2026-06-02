'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addDays,
  derive,
  formatWeek,
  getMondayOf,
  isCurrentWeek,
  weekKey,
} from '@/lib/derive';
import { autoMatchCampaignIds } from '@/lib/matchCampaigns';
import {
  PLAN_BADGE_CLASS,
  PLAN_DEFAULT_TARGET,
  PLAN_LABEL,
  type BisonCampaign,
  type CampaignSource,
  type DashboardClient,
  type InstantlyCampaign,
  type Plan,
} from '@/lib/types';

type Filter = 'all' | 'risk' | 'ok' | 'active' | 'paused' | 'inactive' | 'hidden';

interface Props {
  initialClients: DashboardClient[];
  allInstantlyCampaigns: InstantlyCampaign[];
  allBisonCampaigns: BisonCampaign[];
  dataSource?: 'supabase' | 'seed';
}

// Used only for popup rendering — annotates which source a campaign came from
// so we can show a chip and key React lists across the union without collisions.
interface PopupCampaign {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'finished' | null;
  emails_sent_total: number;
  campaign_size: number;
  progress_pct: number;
  status_changed_at?: string | null;
  source: CampaignSource;
}

interface ModalState {
  open: boolean;
  editingId: string | null;
  name: string;
  plan: Plan;
  startDate: string;
  weeklyTarget: number;
}

const emptyModal: ModalState = {
  open: false,
  editingId: null,
  name: '',
  plan: 'production',
  startDate: '',
  weeklyTarget: PLAN_DEFAULT_TARGET.production,
};

// User-local "today" as YYYY-MM-DD. new Date().toISOString() returns UTC,
// which can be yesterday for IST users in the early morning — show local
// calendar date instead.
function todayLocalISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function Dashboard({ initialClients, allInstantlyCampaigns, allBisonCampaigns, dataSource }: Props) {
  const router = useRouter();
  const [clients, setClients] = useState<DashboardClient[]>(initialClients);
  const [currentMonday, setCurrentMonday] = useState<Date>(() => getMondayOf(new Date()));
  const [filter, setFilter] = useState<Filter>('all');
  const [sortByLeft, setSortByLeft] = useState(false);
  // 'campaigns' = sort by # active campaigns desc, total campaigns as tiebreaker.
  // null = default order (name asc, server-provided).
  const [sortByClient, setSortByClient] = useState<null | 'campaigns'>(null);
  const [campaignSelections, setCampaignSelections] = useState<Record<string, string>>({});
  const [campaignsPopupClientId, setCampaignsPopupClientId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(emptyModal);
  const [refreshing, setRefreshing] = useState(false);

  // When the server re-fetches the dashboard (e.g. after router.refresh()),
  // re-prime the local clients state from the new server props. Without this,
  // local edits via the modal would be overwritten too eagerly, but with this
  // any external change (new sync, manual SQL change) is reflected.
  useEffect(() => {
    setClients(initialClients);
  }, [initialClients]);

  // Set initial start date for the modal once on mount.
  useEffect(() => {
    setModal((m) => ({ ...m, startDate: todayLocalISO() }));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const key = weekKey(currentMonday);
  const isCurrent = isCurrentWeek(key);

  const visible = useMemo(() => {
    // "Hidden" is a filter mode: it shows ONLY hidden clients (and only those).
    // Every other filter implicitly excludes hidden clients.
    let list = clients.filter((c) => (filter === 'hidden' ? c.hidden : !c.hidden));
    list = list.filter((c) => {
      const d = derive(c, key);
      const allCampaigns = [...c.campaigns, ...c.bisonCampaigns];
      const hasRunning = allCampaigns.some((x) => x.status === 'running');
      const hasLaunched = allCampaigns.some(
        (x) => x.status === 'paused' || x.status === 'finished'
      );
      switch (filter) {
        case 'all':
        case 'hidden':
          return true;
        case 'risk':
          return d.status === 'risk';
        case 'ok':
          return d.status === 'ok';
        case 'active':
          return hasRunning;
        case 'paused':
          // Campaign was launched but isn't running now — matches the
          // "Campaign Paused" badge in the row.
          return !hasRunning && hasLaunched;
        case 'inactive':
          // No campaign ever launched — matches the "Not Active" badge.
          return !hasRunning && !hasLaunched;
        default:
          return true;
      }
    });
    if (sortByLeft) {
      list = [...list].sort((a, b) => derive(b, key).leftThisWeek - derive(a, key).leftThisWeek);
    } else if (sortByClient === 'campaigns') {
      const score = (c: DashboardClient) => {
        const all = [...c.campaigns, ...c.bisonCampaigns];
        const active = all.filter((x) => x.status === 'running').length;
        return { active, total: all.length };
      };
      list = [...list].sort((a, b) => {
        const sa = score(a);
        const sb = score(b);
        if (sb.active !== sa.active) return sb.active - sa.active;
        if (sb.total !== sa.total) return sb.total - sa.total;
        return a.name.localeCompare(b.name);
      });
    }
    return list;
  }, [clients, filter, sortByLeft, sortByClient, key]);

  const summary = useMemo(() => {
    let total = 0;
    let risk = 0;
    let ok = 0;
    let intros = 0;
    let emails = 0;
    let convNum = 0;
    let convDen = 0;
    clients.forEach((c) => {
      total++;
      const d = derive(c, key);
      if (d.status === 'risk') risk++;
      if (d.status === 'ok') ok++;
      intros += d.intros;
      emails += d.emails;
      if (d.emails > 0) {
        convNum += d.intros;
        convDen += d.emails;
      }
    });
    return {
      total,
      risk,
      ok,
      intros,
      emails,
      conv: convDen > 0 ? ((convNum / convDen) * 1000).toFixed(1) + '%' : '—',
    };
  }, [clients, key]);

  function changeWeek(dir: -1 | 1) {
    setCurrentMonday((d) => addDays(d, dir * 7));
  }
  function goToToday() {
    setCurrentMonday(getMondayOf(new Date()));
  }

  function openAddModal() {
    setModal({
      ...emptyModal,
      open: true,
      startDate: todayLocalISO(),
    });
  }

  function openEditModal(c: DashboardClient) {
    setModal({
      open: true,
      editingId: c.id,
      name: c.name,
      plan: c.plan,
      startDate: c.start_date ?? '',
      weeklyTarget: c.weekly_target,
    });
  }

  function closeModal() {
    setModal((m) => ({ ...m, open: false, editingId: null }));
  }

  async function saveClient() {
    const name = modal.name.trim();
    if (!name) return;
    // Auto-link any Instantly OR Bison campaign whose name contains this
    // client name (whole-name match + MANUAL_LINKS overrides). Same rule as
    // the seed script + auto-relink step in the sync worker.
    const linkedIds = autoMatchCampaignIds(name, allInstantlyCampaigns);
    const linkedBisonIds = autoMatchCampaignIds(name, allBisonCampaigns);
    const payload = {
      name,
      plan: modal.plan,
      weekly_target: modal.weeklyTarget,
      start_date: modal.startDate || null,
      instantly_campaign_ids: linkedIds,
      bison_campaign_ids: linkedBisonIds,
    };
    try {
      if (modal.editingId) {
        const res = await fetch('/api/clients', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: modal.editingId, ...payload }),
        });
        if (!res.ok) throw new Error(await res.text());
        setClients((list) =>
          list.map((c) => (c.id === modal.editingId ? { ...c, ...payload } : c))
        );
        setToast('Client updated');
      } else {
        const res = await fetch('/api/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
        const { client } = (await res.json()) as { client: { id: string } };
        setClients((list) => [
          ...list,
          {
            ...payload,
            id: client.id,
            campaign_size: 0,
            hidden: false,
            campaigns: [],
            bisonCampaigns: [],
            metricsByWeek: {},
          },
        ]);
        setToast('Client added');
      }
      closeModal();
      // Pull fresh server state so the row reflects newly-linked campaigns
      // and any metrics that already exist in Supabase.
      router.refresh();
    } catch (err) {
      setToast(`Save failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  async function deleteClient(id: string) {
    const client = clients.find((c) => c.id === id);
    const linkedCount =
      (client?.instantly_campaign_ids.length ?? 0) + (client?.bison_campaign_ids.length ?? 0);
    const detail = linkedCount > 0
      ? `Removing this client will also delete their weekly metrics and ${linkedCount} linked campaign cache row${linkedCount === 1 ? '' : 's'} (campaigns linked to no other client). Continue?`
      : `Remove this client? Their weekly metrics will also be deleted from Supabase.`;
    if (!confirm(detail)) return;
    try {
      const res = await fetch(`/api/clients?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      const result = (await res.json()) as { ok: boolean; orphansRemoved?: number };
      setClients((list) => list.filter((c) => c.id !== id));
      const removedParts = ['client', 'weekly metrics'];
      if (result.orphansRemoved && result.orphansRemoved > 0) {
        removedParts.push(`${result.orphansRemoved} orphan campaign${result.orphansRemoved === 1 ? '' : 's'}`);
      }
      setToast(`Removed: ${removedParts.join(' + ')}`);
      router.refresh();
    } catch (err) {
      setToast(`Delete failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  async function toggleHidden(id: string, hidden: boolean) {
    // Optimistic update; PATCH; roll back on failure.
    setClients((list) => list.map((c) => (c.id === id ? { ...c, hidden } : c)));
    try {
      const res = await fetch('/api/clients', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, hidden }),
      });
      if (!res.ok) throw new Error(await res.text());
      setToast(hidden ? 'Client hidden · Show Hidden to recover' : 'Client unhidden');
    } catch (err) {
      setClients((list) => list.map((c) => (c.id === id ? { ...c, hidden: !hidden } : c)));
      setToast(`Failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch('/api/sync/run', { method: 'POST' });
      if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
      const data = (await res.json()) as {
        ok: boolean;
        result?: {
          instantly?: { campaigns?: number };
          corofy?: { intros?: number; skipped?: boolean };
        };
      };
      // Re-fetch the server component so newly synced data shows up immediately.
      router.refresh();
      const r = data.result ?? {};
      const parts: string[] = [];
      if (r.instantly?.campaigns !== undefined) parts.push(`${r.instantly.campaigns} campaigns`);
      if (r.corofy?.skipped) parts.push('Corofy skipped');
      else if (r.corofy?.intros !== undefined) parts.push(`${r.corofy.intros} intros`);
      setToast(`Synced · ${parts.join(' · ')}`);
    } catch (err) {
      setToast(`Sync error: ${(err as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  // Preview the campaigns that will be auto-linked when saving. Updates live
  // as the user types so they can see what will happen.
  const previewLinkedCount = useMemo(() => {
    const i = autoMatchCampaignIds(modal.name, allInstantlyCampaigns).length;
    const b = autoMatchCampaignIds(modal.name, allBisonCampaigns).length;
    return i + b;
  }, [modal.name, allInstantlyCampaigns, allBisonCampaigns]);

  return (
    <>
      <header>
        <div className="logo">
          <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="48" height="48" rx="10" fill="#E3F0FF" />
            <path d="M24 10L10 22H14V38H22V30H26V38H34V22H38L24 10Z" fill="#1565C0" />
          </svg>
          <div className="logo-text">BROKER<br />STAFFER</div>
        </div>
        <div className="header-right">
          <div className="week-nav">
            <button className="week-nav-btn" onClick={() => changeWeek(-1)}>←</button>
            <div className={'week-nav-label' + (isCurrent ? ' is-current' : '')}>
              {isCurrent ? 'This Week' : formatWeek(currentMonday)}
            </div>
            <button
              className="week-nav-btn"
              onClick={() => changeWeek(1)}
              disabled={weekKey(addDays(currentMonday, 7)) > weekKey(new Date())}
            >
              →
            </button>
          </div>
          {!isCurrent && (
            <button className="btn-today" onClick={goToToday}>Today</button>
          )}
          <button className="btn-refresh" onClick={refresh} disabled={refreshing} title="Trigger sync now">
            {refreshing ? '…' : '↻'}
          </button>
          <button className="btn-add" onClick={openAddModal}>+ Add Client</button>
        </div>
      </header>

      <main>
        {!isCurrent && (
          <div className="past-week-banner show">📅 Viewing a past week — data is read-only.</div>
        )}

        <div className="summary">
          <SummaryCard label="Clients" cls="n-total" num={summary.total} sub="active" />
          <SummaryCard label="At Risk" cls="n-risk" num={summary.risk} sub="below half target" />
          <SummaryCard label="On Track" cls="n-ok" num={summary.ok} sub="meeting target this week" />
          <SummaryCard label="Intros Sent" cls="n-intros" num={summary.intros} sub="across all clients" />
          <SummaryCard
            label="Emails Sent"
            cls="n-emails"
            num={summary.emails.toLocaleString()}
            sub="across all clients"
          />
          <SummaryCard label="Avg Conv." cls="n-conv" num={summary.conv} sub="1k email → intro" />
        </div>

        <div className="table-wrap">
          <div className="table-header">
            <div>
              <div className="table-title">Client Health</div>
              <div className="table-subtitle">
                {isCurrent ? 'Live data from Instantly · Bison · MasterInbox' : `Week of ${formatWeek(currentMonday)}`}
              </div>
            </div>
            <div className="filter-pills">
              <button className={'fpill' + (filter === 'all' ? ' active' : '')} onClick={() => setFilter('all')}>All</button>
              <button className={'fpill f-risk' + (filter === 'risk' ? ' active' : '')} onClick={() => setFilter('risk')}>At Risk</button>
              <button className={'fpill f-ok' + (filter === 'ok' ? ' active' : '')} onClick={() => setFilter('ok')}>On Track</button>
              <button className={'fpill' + (filter === 'active' ? ' active' : '')} onClick={() => setFilter('active')} title="Clients with at least one running campaign">Active</button>
              <button className={'fpill' + (filter === 'paused' ? ' active' : '')} onClick={() => setFilter('paused')} title="Clients whose campaigns are paused or finished (no running)">Paused</button>
              <button className={'fpill' + (filter === 'inactive' ? ' active' : '')} onClick={() => setFilter('inactive')} title="Clients with no campaign launched yet">Inactive</button>
              <button className={'fpill' + (filter === 'hidden' ? ' active' : '')} onClick={() => setFilter('hidden')} title="Only hidden clients">Hidden</button>
            </div>
          </div>
          <div className="table-scroll">
            {visible.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📋</div>
                <h3>No clients yet</h3>
                <p>Add your first client to start tracking.</p>
                <button className="btn-add" onClick={openAddModal}>+ Add Client</button>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th
                      className={'sortable' + (sortByClient === 'campaigns' ? ' sorted' : '')}
                      onClick={() => {
                        setSortByClient((v) => (v === 'campaigns' ? null : 'campaigns'));
                        setSortByLeft(false);
                      }}
                      title="Sort by # of active campaigns"
                    >
                      Client <em className="sort-icon">{sortByClient === 'campaigns' ? '↓' : '↕'}</em>
                    </th>
                    <th>Emails Sent</th>
                    <th>Intros This Week</th>
                    <th>Conv. Rate</th>
                    <th
                      className={'sortable' + (sortByLeft ? ' sorted' : '')}
                      onClick={() => {
                        setSortByLeft((v) => !v);
                        setSortByClient(null);
                      }}
                    >
                      Left This Week <em className="sort-icon">{sortByLeft ? '↓' : '↕'}</em>
                    </th>
                    <th>Campaign Progress</th>
                    <th>Last Intro</th>
                    <th>Status</th>
                    <th>Plan</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <ClientRow
                      key={c.id}
                      client={c}
                      weekKey={key}
                      campaignSelection={campaignSelections[c.id] ?? '__avg__'}
                      onCampaignChange={(camp) =>
                        setCampaignSelections((prev) => ({ ...prev, [c.id]: camp }))
                      }
                      onShowCampaigns={() => setCampaignsPopupClientId(c.id)}
                      onEdit={() => openEditModal(c)}
                      onDelete={() => deleteClient(c.id)}
                      onToggleHidden={(h) => toggleHidden(c.id, h)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </main>

      <div
        className={'modal-overlay' + (modal.open ? ' open' : '')}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeModal();
        }}
      >
        <div className="modal">
          <h2>{modal.editingId ? 'Edit Client' : 'Add Client'}</h2>
          <p>{modal.editingId ? "Update this client's details." : "Enter the client's details to start tracking."}</p>

          <div className="form-group">
            <label>Client / Brokerage Name</label>
            <input
              type="text"
              value={modal.name}
              placeholder="e.g. Premier Metro Realty"
              onChange={(e) => setModal((m) => ({ ...m, name: e.target.value }))}
            />
            <div className="form-help">
              {modal.name.trim() === ''
                ? 'Instantly + Bison campaigns whose name contains this client name are auto-linked on save.'
                : previewLinkedCount === 0
                  ? `No campaign contains "${modal.name.trim()}" — this client will be saved without any linked campaigns.`
                  : `Will auto-link ${previewLinkedCount} matching campaign${previewLinkedCount === 1 ? '' : 's'}.`}
            </div>
          </div>

          <div className="form-group">
            <label>Plan</label>
            <select
              value={modal.plan}
              onChange={(e) => {
                const plan = e.target.value as Plan;
                setModal((m) => ({
                  ...m,
                  plan,
                  // Bump target to plan default only if user hasn't customized away from another plan default.
                  weeklyTarget:
                    Object.values(PLAN_DEFAULT_TARGET).includes(m.weeklyTarget)
                      ? PLAN_DEFAULT_TARGET[plan]
                      : m.weeklyTarget,
                }));
              }}
            >
              <option value="minimum">Minimum — 1 intro/week</option>
              <option value="production">Production — 3 intros/week</option>
              <option value="partner">Partner — 6 intros/week</option>
            </select>
          </div>

          <div className="form-group">
            <label>Weekly Intros Target</label>
            <input
              type="number"
              min={0}
              value={modal.weeklyTarget}
              onChange={(e) =>
                setModal((m) => ({ ...m, weeklyTarget: parseInt(e.target.value || '0', 10) }))
              }
            />
            <div className="form-help">Drives the At Risk / On Track status. Defaults to plan tier (1/3/6) but you can override.</div>
          </div>

          <div className="form-group">
            <label>Start Date</label>
            <input
              type="date"
              value={modal.startDate}
              onChange={(e) => setModal((m) => ({ ...m, startDate: e.target.value }))}
            />
          </div>


          <div className="modal-actions">
            <button className="btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn-primary" onClick={saveClient}>
              {modal.editingId ? 'Save Changes' : 'Add Client'}
            </button>
          </div>
        </div>
      </div>

      {campaignsPopupClientId && (() => {
        const c = clients.find((x) => x.id === campaignsPopupClientId);
        if (!c) return null;
        return (
          <CampaignsPopup
            client={c}
            onClose={() => setCampaignsPopupClientId(null)}
          />
        );
      })()}

      <div className={'toast' + (toast ? ' show' : '')}>{toast ?? ''}</div>
    </>
  );
}

function CampaignGroup({
  label,
  count,
  campaigns,
}: {
  label: string | null;
  count: number;
  campaigns: PopupCampaign[];
}) {
  return (
    <div className="camps-popup-group">
      {label && (
        <div className="camps-popup-group-header">
          <span className="camps-popup-group-label">{label}</span>
          <span className="camps-popup-group-count">{count}</span>
        </div>
      )}
      {campaigns.map((c) => (
        <CampaignRow key={`${c.source}:${c.id}`} c={c} />
      ))}
    </div>
  );
}

function CampaignRow({ c }: { c: PopupCampaign }) {
  const pct = Math.min(100, Math.max(0, Number(c.progress_pct ?? 0)));
  const sent = c.emails_sent_total?.toLocaleString() ?? '0';
  const total = c.campaign_size ?? 0;
  const completed = Math.round(total * (pct / 100));
  const rowCls =
    c.status === 'running'
      ? 'is-running'
      : c.status === 'paused'
        ? 'is-paused'
        : c.status === 'finished'
          ? 'is-finished'
          : 'is-draft';
  const statusLabel =
    c.status === 'paused'
      ? 'Campaign Paused'
      : c.status === 'finished'
        ? 'Finished'
        : c.status === 'running'
          ? 'Running'
          : 'Draft';
  return (
    <div className={`camps-popup-row ${rowCls}`}>
      <div className="camp-row-head">
        <div className="camp-info-name">{c.name}</div>
        <div className="camp-pct">{Math.round(pct)}%</div>
      </div>
      <div className="camp-mini-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="camp-row-foot">
        <span className="camp-row-stats">
          <strong>{completed.toLocaleString()}</strong> / {total.toLocaleString()} leads
          <span className="camp-row-sep">·</span>
          <strong>{sent}</strong> emails sent
        </span>
        <span className="camp-status-chip">
          <span className="chip-dot" />
          <span className="chip-label">{statusLabel}</span>
        </span>
      </div>
    </div>
  );
}

function CampaignsPopup({
  client,
  onClose,
}: {
  client: DashboardClient;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Surface ALL linked campaigns across both sources. Group by vendor so the
  // popup reads as two clean lists (Instantly first, then Bison) instead of an
  // interleaved one. Within each group, sort by status: running → paused →
  // finished, then most-recent transition first.
  const statusRank = (s: PopupCampaign['status']): number =>
    s === 'running' ? 0 : s === 'paused' ? 1 : s === 'finished' ? 2 : 3;
  const sortGroup = (group: PopupCampaign[]) =>
    [...group].sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      if (r !== 0) return r;
      const at = a.status_changed_at ? Date.parse(a.status_changed_at) : 0;
      const bt = b.status_changed_at ? Date.parse(b.status_changed_at) : 0;
      return bt - at;
    });
  const instantlyGroup = sortGroup(
    client.campaigns.map((c) => ({ ...c, source: 'instantly' as const }))
  );
  const bisonGroup = sortGroup(
    client.bisonCampaigns.map((c) => ({ ...c, source: 'bison' as const }))
  );
  const all: PopupCampaign[] = [...instantlyGroup, ...bisonGroup];

  // Only render section headers when BOTH sources have campaigns. If only one
  // is linked, the headers would be visual noise.
  const showHeaders = instantlyGroup.length > 0 && bisonGroup.length > 0;

  const running = all.filter((c) => c.status === 'running');
  const totalSent = running.reduce((a, b) => a + b.emails_sent_total, 0);
  const summary =
    running.length === 0
      ? 'No active campaigns'
      : `${totalSent.toLocaleString()} emails sent`;

  return (
    <div
      className="modal-overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal camps-popup">
        <div className="camps-popup-header">
          <div className="camps-popup-title">{client.name}</div>
          <div className="camps-popup-sub">
            {running.length} active {running.length === 1 ? 'campaign' : 'campaigns'}
            {running.length > 0 ? ` · ${summary}` : ''}
            {all.length > running.length && ` · ${all.length - running.length} paused / finished`}
          </div>
          {all.length > 0 && (
            <div className="camps-popup-note">
              Email counts include every sequence step + subsequences. Matches each vendor&apos;s campaign total, not its Step Analytics view.
            </div>
          )}
        </div>
        <div className="camps-popup-body">
          {all.length === 0 ? (
            <div className="empty-state" style={{ padding: '40px 20px' }}>
              <div className="empty-icon">⏸</div>
              <h3>No campaigns linked</h3>
              <p>This client has no linked campaigns yet.</p>
            </div>
          ) : (
            <>
              {instantlyGroup.length > 0 && (
                <CampaignGroup
                  label={showHeaders ? 'Instantly' : null}
                  count={instantlyGroup.length}
                  campaigns={instantlyGroup}
                />
              )}
              {bisonGroup.length > 0 && (
                <CampaignGroup
                  label={showHeaders ? 'Bison' : null}
                  count={bisonGroup.length}
                  campaigns={bisonGroup}
                />
              )}
            </>
          )}
        </div>
        <div className="camps-popup-footer">
          <button className="btn-secondary" onClick={onClose} style={{ flex: 'none', padding: '8px 18px' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  cls,
  num,
  sub,
}: {
  label: string;
  cls: string;
  num: number | string;
  sub: string;
}) {
  return (
    <div className="summary-card">
      <div className="summary-label">{label}</div>
      <div className={`summary-num ${cls}`}>{num}</div>
      <div className="summary-sub">{sub}</div>
    </div>
  );
}

function ClientRow({
  client,
  weekKey: wk,
  campaignSelection,
  onCampaignChange,
  onShowCampaigns,
  onEdit,
  onDelete,
  onToggleHidden,
}: {
  client: DashboardClient;
  weekKey: string;
  campaignSelection: string;
  onCampaignChange: (id: string) => void;
  onShowCampaigns: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleHidden: (hidden: boolean) => void;
}) {
  const d = derive(client, wk);
  // Per spec, the dashboard only reflects ACTIVE (running) campaigns:
  // count, dropdown options, and the "all campaigns (avg)" rollup all
  // exclude paused/finished campaigns. Union across Instantly + Bison sources.
  const activeCampaigns: (InstantlyCampaign | BisonCampaign)[] = [
    ...client.campaigns.filter((c) => c.status === 'running'),
    ...client.bisonCampaigns.filter((c) => c.status === 'running'),
  ];

  // emails cell
  const emailsCell = d.emails > 0 ? (
    <span className="api-num">{d.emails.toLocaleString()}</span>
  ) : (
    <span className="api-none">—</span>
  );

  // intros cell — read-only number from MasterInbox
  const introClass = client.weekly_target === 0 ? '' : d.metTarget ? 'ok' : 'risk';
  const introsCell = (
    <input
      type="number"
      readOnly
      className={`metric-input ${introClass}`}
      value={d.intros}
    />
  );

  // conv cell — intros as a percentage of emails sent
  const convCell =
    d.convPct === null ? (
      <span className="conv-rate conv-none">—</span>
    ) : (
      <span className={`conv-rate conv-${d.convClass}`}>{d.convPct.toFixed(1)}%</span>
    );

  // left pill
  const leftCell =
    client.weekly_target === 0 ? (
      <span className="left-none">—</span>
    ) : d.metTarget ? (
      <span className="left-pill left-done">✓ Done</span>
    ) : (
      <span className="left-pill left-short">{d.leftThisWeek} left</span>
    );

  // status badge
  const statusCell =
    d.status === 'pending' ? (
      <span className="status-badge s-pending"><span className="status-dot" />Pending</span>
    ) : d.status === 'risk' ? (
      <span className="status-badge s-risk"><span className="status-dot" />At Risk</span>
    ) : (
      <span className="status-badge s-ok"><span className="status-dot" />On Track</span>
    );

  // campaign cell — dropdown selector + bar (active campaigns only)
  let campaignCell: React.ReactNode;
  if (activeCampaigns.length === 0) {
    campaignCell = <span className="api-none">—</span>;
  } else {
    const selected =
      campaignSelection === '__avg__'
        ? null
        : activeCampaigns.find((c) => c.id === campaignSelection) ?? null;

    const sent = selected
      ? selected.emails_sent_total
      : activeCampaigns.reduce((a, b) => a + b.emails_sent_total, 0);

    // X / Y in the cell = completed leads / total leads. campaign_size is the
    // total (leads_count from Instantly); completed is back-computed from the
    // stored progress_pct. Two-decimal precision in DB keeps this exact.
    const totalLeads = selected
      ? selected.campaign_size
      : activeCampaigns.reduce((a, b) => a + b.campaign_size, 0);
    const completedLeads = selected
      ? Math.round(selected.campaign_size * (selected.progress_pct / 100))
      : activeCampaigns.reduce(
          (a, b) => a + Math.round(b.campaign_size * (b.progress_pct / 100)),
          0,
        );
    // Weighted % across multiple campaigns — sum-of-completed / sum-of-leads,
    // not the simple average of per-campaign rates (which would over-weight
    // small campaigns).
    const pct = selected
      ? selected.progress_pct
      : totalLeads > 0
        ? (completedLeads / totalLeads) * 100
        : 0;

    campaignCell = (
      <div className="monthly-cell">
        {activeCampaigns.length > 1 && (
          <select
            className="campaign-select"
            value={campaignSelection}
            onChange={(e) => onCampaignChange(e.target.value)}
          >
            <option value="__avg__">All active (avg)</option>
            {activeCampaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        <div className="monthly-label">
          <span className="monthly-count">
            {completedLeads.toLocaleString()} / {totalLeads.toLocaleString()}
          </span>
          <span className="monthly-pct">{Math.round(pct)}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill pf-active" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className="campaign-tag ct-active">
          <span className="ct-dot" />
          {sent.toLocaleString()} sent · Running
        </div>
      </div>
    );
  }

  // last intro cell
  let lastIntroCell: React.ReactNode;
  if (d.daysSince === null) {
    lastIntroCell = <span className="last-intro li-none">No data</span>;
  } else if (d.daysSince === 0) {
    lastIntroCell = <span className="last-intro li-fresh">Today</span>;
  } else if (d.daysSince === 1) {
    lastIntroCell = <span className="last-intro li-fresh">Yesterday</span>;
  } else if (d.daysSince <= 7) {
    lastIntroCell = <span className="last-intro li-fresh">{d.daysSince}d ago</span>;
  } else if (d.daysSince <= 14) {
    lastIntroCell = <span className="last-intro li-recent">{d.daysSince}d ago</span>;
  } else {
    lastIntroCell = <span className="last-intro li-stale">{d.daysSince}d ago</span>;
  }

  // Per spec, the dashboard only counts ACTIVE campaigns under each client.
  const campsCount = activeCampaigns.length;
  // When no campaign is running, split the empty-state label by whether any
  // campaign was ever launched. Paused or finished → "Campaign Paused".
  // Only draft / nothing linked → "Not Active".
  const hasLaunched =
    client.campaigns.some((c) => c.status === 'paused' || c.status === 'finished') ||
    client.bisonCampaigns.some((c) => c.status === 'paused' || c.status === 'finished');
  const campsLabel =
    campsCount > 0
      ? campsCount === 1
        ? '1 active campaign'
        : `${campsCount} active campaigns`
      : hasLaunched
        ? 'Campaign Paused'
        : 'Not Active';

  const since = client.start_date
    ? new Date(client.start_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <tr className={client.hidden ? 'is-hidden' : ''}>
      <td className="client-cell">
        <div className="client-name">
          {client.name}
          {client.hidden && <span className="hidden-badge">Hidden</span>}
        </div>
        {since && <div className="client-since">Since {since}</div>}
        <div
          className={
            'client-meta'
            + (campsCount === 0 ? ' is-empty' : '')
            + (campsCount === 0 ? (hasLaunched ? ' is-paused-camp' : ' is-not-launched') : '')
          }
          onClick={campsCount > 0 ? onShowCampaigns : undefined}
          role={campsCount > 0 ? 'button' : undefined}
          aria-label={
            campsCount > 0
              ? `View ${campsCount} active campaign${campsCount === 1 ? '' : 's'}`
              : campsLabel
          }
        >
          {campsCount > 0 && <span className="client-meta-dot" />}
          <span>{campsLabel}</span>
          {campsCount > 0 && <span className="client-meta-arrow">›</span>}
        </div>
      </td>
      <td>{emailsCell}</td>
      <td>{introsCell}</td>
      <td>{convCell}</td>
      <td>{leftCell}</td>
      <td>{campaignCell}</td>
      <td>{lastIntroCell}</td>
      <td>{statusCell}</td>
      <td><span className={`plan-badge ${PLAN_BADGE_CLASS[client.plan]}`}>{PLAN_LABEL[client.plan]}</span></td>
      <td>
        <div className="actions">
          <button className="btn-icon" title="Edit" onClick={onEdit}>✏️</button>
          <button
            className="btn-icon"
            title={client.hidden ? 'Unhide client' : 'Hide client'}
            onClick={() => onToggleHidden(!client.hidden)}
          >
            {client.hidden ? '👁' : '🙈'}
          </button>
          <button className="btn-icon del" title="Remove" onClick={onDelete}>🗑</button>
        </div>
      </td>
    </tr>
  );
}
