-- Persist Corofy portal state on the clients row.
--
-- Background: the web service's Railway edge is blocked from calling
-- Corofy's /api/clients/portals endpoint (same constraint that blocked the
-- web from calling /api/clients/intros earlier — only sync-worker's edge
-- reaches Corofy). So instead of fetching portals on every page load, the
-- sync-worker writes the result into these columns, and the dashboard just
-- reads them.

alter table clients
  add column if not exists portal_active boolean not null default false,
  add column if not exists portal_synced_at timestamptz;
