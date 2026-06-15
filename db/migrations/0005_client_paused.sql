-- Two additive changes:
--
-- 1. clients.client_paused — manual "service temporarily paused" flag.
--    Distinct from `hidden` (permanent) and from "Campaign Paused"
--    (derived from campaign statuses). Behaves like hidden in UX:
--    excluded from default views, visible only under the "Client Paused"
--    filter.
--
-- 2. bison_campaigns.int_id — Bison's integer campaign id, needed because
--    Bison's per-campaign endpoints (/api/campaigns/{id}/...) reject the
--    UUID we currently key by. Storing the int id alongside the uuid lets
--    us call those endpoints without a separate lookup.

alter table clients
  add column if not exists client_paused boolean not null default false;

create index if not exists clients_client_paused_idx
  on clients (client_paused) where client_paused = true;

alter table bison_campaigns
  add column if not exists int_id integer;
