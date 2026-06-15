// Corofy API client — second source of "Introduction" intros.
//
// Auth: `x-admin-token: <COROFY_ADMIN_TOKEN>` header (Supabase service-role JWT).
// Base: env COROFY_BASE_URL (e.g., https://alluring-ambition-production-d0b0.up.railway.app)
//
// Endpoints used:
//   GET /api/clients/intros — one row per intro with client_name + assigned_at
//
// Each intro row is matched to our clients by exact client_name ↔ clients.name.
// Unlike MasterInbox (which keys by campaign_id), Corofy's response is already
// keyed by client name — no campaign mapping needed.

const BASE = (process.env.COROFY_BASE_URL ?? '').replace(/\/$/, '');

function token(): string {
  const t = process.env.COROFY_ADMIN_TOKEN;
  if (!t) throw new Error('COROFY_ADMIN_TOKEN is not set');
  return t;
}

export interface CorofyIntro {
  client_name: string;
  assigned_at: string; // ISO 8601 UTC
  lead_email?: string | null;
  lead_name?: string | null;
}

interface CorofyIntrosResp {
  ok: boolean;
  label: string;
  label_id: string;
  intros: CorofyIntro[];
}

export async function listCorofyIntros(): Promise<CorofyIntro[]> {
  if (!BASE) throw new Error('COROFY_BASE_URL is not set');
  const res = await fetch(`${BASE}/api/clients/intros`, {
    headers: { 'x-admin-token': token(), Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Corofy /api/clients/intros ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as CorofyIntrosResp;
  return json.intros ?? [];
}
