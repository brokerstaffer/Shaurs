-- Shaurs / BrokerStaffer Client Health Dashboard
-- Run this once in the Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null check (plan in ('minimum','production','partner')),
  weekly_target int not null check (weekly_target >= 0),
  start_date date,
  instantly_campaign_ids text[] not null default '{}',
  masterinbox_identifier text,
  campaign_size int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists clients_name_idx on clients (name);

create table if not exists weekly_metrics (
  client_id uuid not null references clients(id) on delete cascade,
  week_key date not null,
  emails_sent int not null default 0,
  intros int not null default 0,
  last_intro_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (client_id, week_key)
);

create index if not exists weekly_metrics_week_idx on weekly_metrics (week_key);

create table if not exists instantly_campaigns (
  id text primary key,
  name text not null,
  status text,
  emails_sent_total int not null default 0,
  campaign_size int not null default 0,
  progress_pct numeric(5,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('instantly','masterinbox')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  error text
);

create index if not exists sync_runs_started_idx on sync_runs (started_at desc);

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists clients_updated_at on clients;
create trigger clients_updated_at before update on clients
  for each row execute function set_updated_at();

drop trigger if exists weekly_metrics_updated_at on weekly_metrics;
create trigger weekly_metrics_updated_at before update on weekly_metrics
  for each row execute function set_updated_at();

drop trigger if exists instantly_campaigns_updated_at on instantly_campaigns;
create trigger instantly_campaigns_updated_at before update on instantly_campaigns
  for each row execute function set_updated_at();
