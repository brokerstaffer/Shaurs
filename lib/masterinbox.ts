// MasterInbox API client — STUB.
//
// We are still waiting on docs / confirmation of these endpoints. The shape below
// reflects the capabilities we asked for in the plan:
//   1. Auth (header to be confirmed)
//   2. List leads filtered by label = "Introduction" + date range
//   3. Lead "labeled at" timestamp on the lead object
//   4. List of labels/tags
//   5. Per-lead client/campaign identifier
//
// Replace `BASE`, the auth header, and the field names once docs land.

const BASE = process.env.MASTERINBOX_BASE_URL ?? 'https://api.masterinbox.com';

function key(): string {
  const k = process.env.MASTERINBOX_API_KEY;
  if (!k) throw new Error('MASTERINBOX_API_KEY is not set');
  return k;
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      // TODO: confirm auth header name once we have docs.
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MasterInbox ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface MasterInboxLead {
  id: string;
  // The field that maps a lead back to one of our Corofy clients.
  // e.g. `campaign_id`, `list_id`, `account_id`, custom field — TBD.
  client_identifier: string;
  label?: string;
  labeled_at?: string; // ISO timestamp of when the "Introduction" label was applied
}

// Placeholder: list leads tagged "Introduction" between two dates.
// Pagination handling will be added once we know the cursor scheme.
export async function listIntroductionLeads(
  start: string,
  end: string
): Promise<MasterInboxLead[]> {
  const data = await get<{ items?: MasterInboxLead[] } | MasterInboxLead[]>('/leads', {
    label: 'Introduction',
    labeled_after: start,
    labeled_before: end,
  });
  if (Array.isArray(data)) return data;
  return data.items ?? [];
}
