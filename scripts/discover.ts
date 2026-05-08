// One-shot discovery script: pulls all Instantly campaigns, fuzzy-matches them
// against the user-supplied list of 24 active clients, and writes a mapping
// suggestion to stdout (JSON). Used to bootstrap the clients table.

import fs from 'node:fs';
import { listCampaigns } from '../lib/instantly';

const CLIENTS = [
  'Brooklyn Group',
  'BHGRE Basecamp',
  'Howard Hanna NYC',
  'EXR',
  'Howe Realty Group',
  'Military Veteran Team - LPT Realty',
  '54 Realty',
  'Camelot Realty Group',
  'SPACE',
  'Raintown Realty',
  'Properties & Estates',
  'The Keyes Company',
  'Bastion Realty South',
  'Front Range Collective',
  'C21 Results - Elite Team',
  'Kelly + Co',
  'PRG Real Estate at EXP',
  'SERHANT.',
  'Young Realty',
  'Spotlight - A Compass Team',
  'MattC Group',
  'Douglas Elliman NYC',
  'Jeff Cook Real Estate',
  'JM properties',
];

// Light normalization: lowercase, collapse punctuation (dashes, periods,
// commas, parens) to a single space, normalize ampersand/whitespace. Keeps
// every token of the client name — match must include the WHOLE client name.
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,()]/g, '')
    .replace(/&/g, 'and')
    .replace(/[-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const campaigns = await listCampaigns();
  console.log(`Pulled ${campaigns.length} Instantly campaigns.\n`);

  fs.writeFileSync(
    '/tmp/inst_campaigns_all.json',
    JSON.stringify(
      campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status })),
      null,
      2
    )
  );

  // Rule (per user spec): the WHOLE client name must appear as a substring of
  // the campaign name (after light normalization). No token-level matching.
  const suggestions: Record<string, { id: string; name: string; status?: number }[]> = {};
  for (const client of CLIENTS) {
    const cnorm = norm(client);
    if (!cnorm) {
      suggestions[client] = [];
      continue;
    }
    suggestions[client] = campaigns
      .filter((c) => norm(c.name).includes(cnorm))
      .map((c) => ({ id: c.id, name: c.name, status: c.status }));
  }

  for (const client of CLIENTS) {
    const ms = suggestions[client];
    console.log(`${client}: ${ms.length} match(es)`);
    ms.slice(0, 5).forEach((m) => console.log(`  - [${m.status}] ${m.name}`));
    if (ms.length > 5) console.log(`  ... and ${ms.length - 5} more`);
  }

  fs.writeFileSync('/tmp/client_mapping.json', JSON.stringify(suggestions, null, 2));
  console.log('\nMapping written to /tmp/client_mapping.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
