// MasterInbox API client (api-webhook v1).
//
// Auth: `Authorization: Bearer <MASTERINBOX_API_KEY>` (publishable `pk_…` token).
// Base: https://api.masterinbox.com/api/api-webhook/v1/api
//
// Endpoints used:
//   GET  /get-labels        — list workspace labels (used to find "Introduction")
//   POST /get-prospects     — paginated prospect/lead list with `labels` and `campaign_id`
//
// Notes verified against the live API:
//   - Server-side label/date filters are silently ignored — we paginate and filter client-side.
//   - Each prospect has `labels: number[]`, `label_names: string[]`, `campaign_id` (Instantly UUID),
//     and `updated_at` / `last_message` as Unix ms timestamps.
//   - `campaign_id` matches the Instantly campaign ID, so we roll up by mapping
//     prospects → campaign → client (via clients.instantly_campaign_ids).

const BASE = process.env.MASTERINBOX_BASE_URL || 'https://api.masterinbox.com/api/api-webhook/v1/api';

function key(): string {
  const k = process.env.MASTERINBOX_API_KEY;
  if (!k) throw new Error('MASTERINBOX_API_KEY is not set');
  return k;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${key()}`,
      accept: '*/*',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MasterInbox ${method} ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface ApiResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T;
  metadata?: { total?: number; page?: number; limit?: number };
}

export interface MasterInboxLabel {
  label_id: number;
  label_name: string;
  label_color: string;
}

export interface MasterInboxProspect {
  _id: string;
  workspace_id: number;
  email: string;
  name: string;
  campaign_id?: string; // Instantly campaign UUID
  campaign_name?: string;
  labels: number[];
  label_names: string[];
  created_at: number; // unix ms
  updated_at: number; // unix ms
  last_message?: number;
  last_received_at?: number;
}

export async function listLabels(): Promise<MasterInboxLabel[]> {
  const res = await call<ApiResponse<MasterInboxLabel[]>>('GET', '/get-labels');
  return res.data ?? [];
}

// Look up a label id by name (case-insensitive).
export async function findLabelId(name: string): Promise<number | null> {
  const labels = await listLabels();
  const target = name.trim().toLowerCase();
  const match = labels.find((l) => l.label_name.trim().toLowerCase() === target);
  return match?.label_id ?? null;
}

// Page through all prospects. The API ignores server-side filters; filtering
// happens client-side in the sync script. The `metadata.total` field is only
// reliable on page 1 — subsequent pages return total=-1, so we cache the page-1
// total and stop when we've seen that many rows OR a short page comes back.
// pageSize is capped at 100 by the API (larger values return empty).
export async function listAllProspects(pageSize = 100): Promise<MasterInboxProspect[]> {
  const safePageSize = Math.min(pageSize, 100);
  const all: MasterInboxProspect[] = [];
  let knownTotal: number | null = null;
  for (let page = 1; page <= 200; page++) {
    const res = await call<ApiResponse<MasterInboxProspect[]>>('POST', '/get-prospects', {
      page,
      limit: safePageSize,
    });
    const batch = res.data ?? [];
    all.push(...batch);
    if (page === 1 && (res.metadata?.total ?? 0) > 0) {
      knownTotal = res.metadata!.total!;
    }
    if (batch.length === 0) break;
    if (batch.length < safePageSize) break;
    if (knownTotal !== null && all.length >= knownTotal) break;
  }
  return all;
}

// Helper: filter prospects with a given label id, updated within [start, end).
export function filterIntros(
  prospects: MasterInboxProspect[],
  labelId: number,
  startMs: number,
  endMs: number
): MasterInboxProspect[] {
  return prospects.filter((p) => {
    if (!p.labels?.includes(labelId)) return false;
    const t = p.updated_at;
    return t >= startMs && t < endMs;
  });
}
