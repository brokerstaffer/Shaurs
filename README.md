# Shaurs — BrokerStaffer Client Health Dashboard

Live client outreach health, sourced from **Instantly** (campaigns + emails sent) and **MasterInbox** (intros), persisted in **Supabase**, deployed on **Railway**.

## Stack

- Next.js 15 (App Router, TypeScript)
- Supabase (Postgres)
- Instantly API v2
- MasterInbox API
- Railway (web + cron)

## Local setup

```bash
npm install
cp .env.example .env.local   # then paste keys
```

### `.env.local`

```
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
INSTANTLY_API_KEY=<key>
MASTERINBOX_API_KEY=<key>
MASTERINBOX_BASE_URL=     # blank until docs land
SYNC_SECRET=              # optional — protects /api/sync/run
```

## One-time database setup

Open the Supabase SQL editor and run `db/migrations/0001_init.sql` once:

```
https://supabase.com/dashboard/project/<project-ref>/sql/new
```

Paste the contents of [db/migrations/0001_init.sql](db/migrations/0001_init.sql) and click **Run**.

## Seed the 24 active clients

```bash
npx tsx scripts/seed.ts
```

This pulls the live Instantly campaign list and auto-links each client to every campaign whose name contains the client's name (verbatim). Idempotent — re-run any time the campaign list changes.

## Run a sync

```bash
npx tsx scripts/sync.ts
```

Writes to `instantly_campaigns` and `weekly_metrics`. The `/api/sync/run` HTTP endpoint does the same thing and is what the dashboard's refresh button calls.

## Run the dashboard

```bash
npm run dev
# → http://localhost:3000
```

## Deploy on Railway

The project is already deployed at **https://web-production-d18b09.up.railway.app** (Railway project `brilliant-victory`, ID `fb1fcda3-0fcf-4df4-8e93-15cbed90ed31`). Two services:

| Service | Purpose | Start command |
|---|---|---|
| `web` | Next.js dashboard | `npm start` (from [railway.json](railway.json)) |
| `sync-worker` | Cron sync of Instantly + MasterInbox → Supabase | `npx tsx scripts/sync.ts` (set via `NIXPACKS_START_CMD`) |

### Re-deploying

```bash
# Set the project token once
export RAILWAY_TOKEN=<project-token>

# Push to a service from the project root
railway up --service web --ci
railway up --service sync-worker --detach
```

### Configuring the cron schedule (one-time)

Railway's CLI can't set the per-service cron schedule directly. Open the Railway dashboard, go to the **sync-worker** service → **Settings** → **Cron Schedule** → set `*/15 * * * *`. Once set, every 15 minutes Railway will spin up a one-shot deploy that runs `npx tsx scripts/sync.ts` and exits.

Until that's configured, `sync-worker` is idle. **Manual sync still works in two ways:**
1. The dashboard's "↻" refresh button (calls `/api/sync/run` on the web service).
2. `curl -X POST https://web-production-d18b09.up.railway.app/api/sync/run`.

## What's outstanding

- **MasterInbox**: API docs not yet available. The `/lib/masterinbox.ts` client and the `runMasterInbox()` half of the sync are stubs against a guessed schema. Once the docs land:
  1. Update `BASE`, auth header, and field names in `lib/masterinbox.ts`.
  2. Confirm the field on a lead that maps it to a Corofy client.
  3. Re-run `tsx scripts/sync.ts` and verify `weekly_metrics.intros` populates.
- **GitHub Actions / Railway cron**: pick one. Cron service in Railway is simplest.
- **Custom domain**: configure in Railway after first deploy.

## Architecture

```
Browser (Next.js page)
    │ reads
    ▼
Supabase (Postgres) ◄── upserts ── Railway cron (tsx scripts/sync.ts)
                                          │
                                          ├── GET /api/v2/campaigns
                                          ├── GET /api/v2/campaigns/analytics
                                          ├── GET /api/v2/campaigns/analytics/daily
                                          └── GET /leads (MasterInbox) — TBD
```

- **Web**: server component fetches `clients`, `weekly_metrics`, `instantly_campaigns` from Supabase. No third-party API calls at request time.
- **Worker**: pulls fresh data from Instantly + MasterInbox and upserts into Supabase. Invoked on cron and via `POST /api/sync/run`.
- **Auth**: none on the dashboard (private link). The sync endpoint is gated by `SYNC_SECRET` if set.
