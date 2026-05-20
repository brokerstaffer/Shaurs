-- Additive: second intro source (Corofy). Safe to re-run.
--
-- Adds a per-source intro count + last-intro timestamp to weekly_metrics so the
-- existing MasterInbox columns (intros, last_intro_at) stay intact. The
-- dashboard's derive() sums the two sources at read time.

alter table weekly_metrics
  add column if not exists intros_corofy int not null default 0,
  add column if not exists last_corofy_intro_at timestamptz;

-- Expand sync_runs.source check constraint to allow 'corofy'.
alter table sync_runs drop constraint if exists sync_runs_source_check;
alter table sync_runs add constraint sync_runs_source_check
  check (source in ('instantly','masterinbox','bison','corofy'));
