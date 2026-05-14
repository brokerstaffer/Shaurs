-- Additive migration: EmailBison campaign source + status-change tracking.
-- Safe to re-run. Does not touch existing rows or columns.

-- Bison campaign cache (mirrors instantly_campaigns; Bison IDs are integers but
-- we store as text for uniformity with the existing instantly_campaigns.id text PK).
create table if not exists bison_campaigns (
  id text primary key,
  name text not null,
  status text,
  emails_sent_total int not null default 0,
  campaign_size int not null default 0,
  progress_pct numeric(5,2) not null default 0,
  status_changed_at timestamptz,
  updated_at timestamptz not null default now()
);

drop trigger if exists bison_campaigns_updated_at on bison_campaigns;
create trigger bison_campaigns_updated_at before update on bison_campaigns
  for each row execute function set_updated_at();

-- Add status_changed_at to existing instantly_campaigns too.
alter table instantly_campaigns
  add column if not exists status_changed_at timestamptz;

-- Per-client Bison campaign linkage (parallel to instantly_campaign_ids).
alter table clients
  add column if not exists bison_campaign_ids text[] not null default '{}';

-- Expand sync_runs.source check constraint to allow 'bison'.
alter table sync_runs drop constraint if exists sync_runs_source_check;
alter table sync_runs add constraint sync_runs_source_check
  check (source in ('instantly','masterinbox','bison'));
