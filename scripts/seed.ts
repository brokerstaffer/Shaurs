// Seed Supabase `clients` with the 24 active BrokerStaffer clients,
// auto-linking to Instantly campaigns whose names contain the full client name.
// Idempotent: re-running updates instantly_campaign_ids but preserves
// weekly_target / plan / start_date that may have been edited in the UI.

import { getSupabase } from '../lib/supabase';
import { listCampaigns } from '../lib/instantly';
import { PLAN_DEFAULT_TARGET, type Plan } from '../lib/types';

const CLIENTS: { name: string; plan: Plan }[] = [
  { name: 'Brooklyn Group', plan: 'production' },
  { name: 'BHGRE Basecamp', plan: 'production' },
  { name: 'Howard Hanna NYC', plan: 'production' },
  { name: 'EXR', plan: 'production' },
  { name: 'Howe Realty Group', plan: 'production' },
  { name: 'Military Veteran Team - LPT Realty', plan: 'production' },
  { name: '54 Realty', plan: 'production' },
  { name: 'Camelot Realty Group', plan: 'production' },
  { name: 'SPACE', plan: 'production' },
  { name: 'Raintown Realty', plan: 'production' },
  { name: 'Properties & Estates', plan: 'production' },
  { name: 'The Keyes Company', plan: 'production' },
  { name: 'Bastion Realty South', plan: 'production' },
  { name: 'Front Range Collective', plan: 'production' },
  { name: 'C21 Results - Elite Team', plan: 'production' },
  { name: 'Kelly + Co', plan: 'production' },
  { name: 'PRG Real Estate at EXP', plan: 'production' },
  { name: 'SERHANT.', plan: 'production' },
  { name: 'Young Realty', plan: 'production' },
  { name: 'Spotlight - A Compass Team', plan: 'production' },
  { name: 'MattC Group', plan: 'production' },
  { name: 'Douglas Elliman NYC', plan: 'production' },
  { name: 'Jeff Cook Real Estate', plan: 'production' },
  { name: 'JM properties', plan: 'production' },
];

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,()]/g, '')
    .replace(/&/g, 'and')
    .replace(/[-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Manual overrides for clients whose name doesn't appear verbatim in any
// Instantly campaign name. The value is a list of campaign-name prefixes
// (case-insensitive, normalized) — any campaign whose name starts with one
// of these prefixes will be linked to this client.
const MANUAL_LINKS: Record<string, string[]> = {
  'Howe Realty Group': ['howe realty'],
};

async function main() {
  const sb = getSupabase();
  const campaigns = await listCampaigns();
  console.log(`Pulled ${campaigns.length} Instantly campaigns.`);

  const { data: existing } = await sb.from('clients').select('id, name');
  const existingByName = new Map((existing ?? []).map((c) => [c.name, c.id]));

  let inserted = 0;
  let updated = 0;

  for (const client of CLIENTS) {
    const cnorm = norm(client.name);
    const overrides = MANUAL_LINKS[client.name] ?? [];
    const matched = campaigns.filter((c) => {
      const cn = norm(c.name);
      if (cn.includes(cnorm)) return true;
      return overrides.some((prefix) => cn.startsWith(norm(prefix)));
    });
    const ids = matched.map((c) => c.id);

    const existingId = existingByName.get(client.name);
    if (existingId) {
      const { error } = await sb
        .from('clients')
        .update({ instantly_campaign_ids: ids })
        .eq('id', existingId);
      if (error) throw new Error(`update ${client.name}: ${error.message}`);
      updated++;
      console.log(`updated ${client.name}: ${ids.length} campaigns`);
    } else {
      const { error } = await sb.from('clients').insert({
        name: client.name,
        plan: client.plan,
        weekly_target: PLAN_DEFAULT_TARGET[client.plan],
        instantly_campaign_ids: ids,
      });
      if (error) throw new Error(`insert ${client.name}: ${error.message}`);
      inserted++;
      console.log(`inserted ${client.name}: ${ids.length} campaigns`);
    }
  }

  console.log(`\nDone. inserted=${inserted} updated=${updated}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
