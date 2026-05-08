'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  addDays,
  derive,
  formatWeek,
  getMondayOf,
  isCurrentWeek,
  weekKey,
} from '@/lib/derive';
import {
  PLAN_BADGE_CLASS,
  PLAN_DEFAULT_TARGET,
  PLAN_LABEL,
  type DashboardClient,
  type Plan,
} from '@/lib/types';

type Filter = 'all' | 'risk' | 'ok';

interface Props {
  initialClients: DashboardClient[];
  dataSource?: 'supabase' | 'seed';
}

interface ModalState {
  open: boolean;
  editingId: string | null;
  name: string;
  plan: Plan;
  startDate: string;
  weeklyTarget: number;
  selectedCampaignIds: string[];
  masterinboxIdentifier: string;
}

const emptyModal: ModalState = {
  open: false,
  editingId: null,
  name: '',
  plan: 'production',
  startDate: '',
  weeklyTarget: PLAN_DEFAULT_TARGET.production,
  selectedCampaignIds: [],
  masterinboxIdentifier: '',
};

export default function Dashboard({ initialClients, dataSource }: Props) {
  const [clients, setClients] = useState<DashboardClient[]>(initialClients);
  const [currentMonday, setCurrentMonday] = useState<Date>(() => getMondayOf(new Date()));
  const [filter, setFilter] = useState<Filter>('all');
  const [sortByLeft, setSortByLeft] = useState(false);
  const [campaignSelections, setCampaignSelections] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(emptyModal);
  const [refreshing, setRefreshing] = useState(false);

  // Set initial start date for the modal once on mount.
  useEffect(() => {
    setModal((m) => ({ ...m, startDate: new Date().toISOString().split('T')[0] }));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const key = weekKey(currentMonday);
  const isCurrent = isCurrentWeek(key);

  const visible = useMemo(() => {
    let list = clients.filter((c) => {
      const d = derive(c);
      if (filter === 'all') return true;
      if (filter === 'risk') return d.status === 'risk';
      if (filter === 'ok') return d.status === 'ok';
      return true;
    });
    if (sortByLeft) {
      list = [...list].sort((a, b) => derive(b).leftThisWeek - derive(a).leftThisWeek);
    }
    return list;
  }, [clients, filter, sortByLeft]);

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
      const d = derive(c);
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
      conv: convDen > 0 ? ((convNum / convDen) * 100).toFixed(1) + '%' : '—',
    };
  }, [clients]);

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
      startDate: new Date().toISOString().split('T')[0],
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
      selectedCampaignIds: [...c.instantly_campaign_ids],
      masterinboxIdentifier: c.masterinbox_identifier ?? '',
    });
  }

  function closeModal() {
    setModal((m) => ({ ...m, open: false, editingId: null }));
  }

  async function saveClient() {
    const name = modal.name.trim();
    if (!name) return;
    const payload = {
      name,
      plan: modal.plan,
      weekly_target: modal.weeklyTarget,
      start_date: modal.startDate || null,
      instantly_campaign_ids: modal.selectedCampaignIds,
      masterinbox_identifier: modal.masterinboxIdentifier || null,
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
          list.map((c) =>
            c.id === modal.editingId ? { ...c, ...payload, masterinbox_identifier: payload.masterinbox_identifier } : c
          )
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
            campaigns: [],
            metrics: {
              client_id: client.id,
              week_key: key,
              emails_sent: 0,
              intros: 0,
              last_intro_at: null,
            },
          },
        ]);
        setToast('Client added');
      }
      closeModal();
    } catch (err) {
      setToast(`Save failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  async function deleteClient(id: string) {
    if (!confirm('Remove this client?')) return;
    try {
      const res = await fetch(`/api/clients?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      setClients((list) => list.filter((c) => c.id !== id));
      setToast('Client removed');
    } catch (err) {
      setToast(`Delete failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch('/api/sync/run', { method: 'POST' });
      if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
      setToast('Sync triggered');
      // In real deployment, page is server-rendered from Supabase on next load.
      // Here we just acknowledge.
    } catch (err) {
      setToast(`Sync error: ${(err as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  // Sort clients with all visible campaigns aggregated for the modal multi-select.
  const allKnownCampaigns = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    clients.forEach((c) =>
      c.campaigns.forEach((camp) => {
        if (!seen.has(camp.id)) seen.set(camp.id, { id: camp.id, name: camp.name });
      })
    );
    return [...seen.values()];
  }, [clients]);

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
          <SummaryCard label="Avg Conv." cls="n-conv" num={summary.conv} sub="email → intro" />
        </div>

        <div className="table-wrap">
          <div className="table-header">
            <div>
              <div className="table-title">Client Health</div>
              <div className="table-subtitle">
                {isCurrent ? 'Live data from Instantly · MasterInbox' : `Week of ${formatWeek(currentMonday)}`}
              </div>
            </div>
            <div className="filter-pills">
              <button className={'fpill' + (filter === 'all' ? ' active' : '')} onClick={() => setFilter('all')}>All</button>
              <button className={'fpill f-risk' + (filter === 'risk' ? ' active' : '')} onClick={() => setFilter('risk')}>At Risk</button>
              <button className={'fpill f-ok' + (filter === 'ok' ? ' active' : '')} onClick={() => setFilter('ok')}>On Track</button>
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
                    <th>Client</th>
                    <th>Emails Sent</th>
                    <th>Intros This Week</th>
                    <th>Conv. Rate</th>
                    <th
                      className={'sortable' + (sortByLeft ? ' sorted' : '')}
                      onClick={() => setSortByLeft((v) => !v)}
                    >
                      Left This Week <em className="sort-icon">{sortByLeft ? '↓' : '↕'}</em>
                    </th>
                    <th>Campaign (Instantly)</th>
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
                      campaignSelection={campaignSelections[c.id] ?? '__avg__'}
                      onCampaignChange={(camp) =>
                        setCampaignSelections((prev) => ({ ...prev, [c.id]: camp }))
                      }
                      onEdit={() => openEditModal(c)}
                      onDelete={() => deleteClient(c.id)}
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

          <div className="form-group">
            <label>Linked Instantly Campaigns</label>
            {allKnownCampaigns.length === 0 ? (
              <div className="form-help">No campaigns synced yet. Run a sync to populate this list.</div>
            ) : (
              <div className="multi-list">
                {allKnownCampaigns.map((camp) => (
                  <label key={camp.id}>
                    <input
                      type="checkbox"
                      checked={modal.selectedCampaignIds.includes(camp.id)}
                      onChange={(e) =>
                        setModal((m) => ({
                          ...m,
                          selectedCampaignIds: e.target.checked
                            ? [...m.selectedCampaignIds, camp.id]
                            : m.selectedCampaignIds.filter((x) => x !== camp.id),
                        }))
                      }
                    />
                    {camp.name}
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="form-group">
            <label>MasterInbox Identifier</label>
            <input
              type="text"
              value={modal.masterinboxIdentifier}
              placeholder="campaign id, list, or tag — TBD after API discovery"
              onChange={(e) => setModal((m) => ({ ...m, masterinboxIdentifier: e.target.value }))}
            />
            <div className="form-help">How this client is identified in MasterInbox. Field name will be locked once we confirm the API.</div>
          </div>

          <div className="modal-actions">
            <button className="btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn-primary" onClick={saveClient}>
              {modal.editingId ? 'Save Changes' : 'Add Client'}
            </button>
          </div>
        </div>
      </div>

      <div className={'toast' + (toast ? ' show' : '')}>{toast ?? ''}</div>
    </>
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
  campaignSelection,
  onCampaignChange,
  onEdit,
  onDelete,
}: {
  client: DashboardClient;
  campaignSelection: string;
  onCampaignChange: (id: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const d = derive(client);

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

  // conv cell
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

  // campaign cell — dropdown selector + bar
  let campaignCell: React.ReactNode;
  if (client.campaigns.length === 0) {
    campaignCell = <span className="api-none">—</span>;
  } else {
    const selected =
      campaignSelection === '__avg__'
        ? null
        : client.campaigns.find((c) => c.id === campaignSelection) ?? null;

    const sent = selected ? selected.emails_sent_total : client.campaigns.reduce((a, b) => a + b.emails_sent_total, 0);
    const size = selected ? selected.campaign_size : client.campaigns.reduce((a, b) => a + b.campaign_size, 0);
    const pct = selected ? selected.progress_pct : Math.round(d.campaignsAvgPct);
    const finished = selected ? selected.status === 'finished' : client.campaigns.every((c) => c.status === 'finished');
    const paused = selected ? selected.status === 'paused' : !finished && client.campaigns.every((c) => c.status === 'paused');
    const pbClass = finished ? 'pf-complete' : paused ? 'pf-stalled' : 'pf-active';
    const tagClass = finished ? 'ct-complete' : paused ? 'ct-stalled' : 'ct-active';
    const tagLabel = finished ? 'Finished' : paused ? 'Paused' : 'Running';

    campaignCell = (
      <div className="monthly-cell">
        <select
          className="campaign-select"
          value={campaignSelection}
          onChange={(e) => onCampaignChange(e.target.value)}
        >
          <option value="__avg__">All campaigns (avg)</option>
          {client.campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <div className="monthly-label">
          <span className="monthly-count">
            {sent.toLocaleString()} / {size.toLocaleString()}
          </span>
          <span className="monthly-pct">{Math.round(pct)}%</span>
        </div>
        <div className="progress-track">
          <div className={`progress-fill ${pbClass}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className={`campaign-tag ${tagClass}`}>
          <span className="ct-dot" />
          {tagLabel}
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

  // campaigns under client name
  const camps = client.campaigns;
  const campsHTML = camps.length > 0 && (
    <div className="client-camps">
      <span className="camps-count">{camps.length === 1 ? '1 campaign' : `${camps.length} campaigns`}</span>
      {camps.map((c) => (
        <div key={c.id} className={`camp-row is-${c.status}`}>
          <span className="camp-dot" />
          {c.name}
        </div>
      ))}
    </div>
  );

  const since = client.start_date
    ? new Date(client.start_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <tr>
      <td>
        <div className="client-name">{client.name}</div>
        {since && <div className="client-since">Since {since}</div>}
        {campsHTML}
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
          <button className="btn-icon del" title="Remove" onClick={onDelete}>🗑</button>
        </div>
      </td>
    </tr>
  );
}
