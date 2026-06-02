-- Manual per-client hide flag. Lets ops hide a client whose service is
-- paused without losing historical metrics. Default false so existing rows
-- stay visible.

alter table clients
  add column if not exists hidden boolean not null default false;

-- Partial index on hidden=true keeps "show hidden" lookups cheap as the
-- table grows; the vast majority of rows will have hidden=false.
create index if not exists clients_hidden_idx on clients (hidden) where hidden = true;
