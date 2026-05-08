// One-shot migration runner: executes 0001_init.sql against Supabase.
// Uses the service-role key. Reads the SQL via fs.

import fs from 'node:fs';
import path from 'node:path';
import { getSupabase } from '../lib/supabase';

async function main() {
  const sqlPath = path.resolve('db/migrations/0001_init.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Supabase REST doesn't expose raw SQL execution by default. Instead we POST
  // to the pg-meta `query` endpoint via the PostgREST `rpc` if a function exists,
  // else use the SQL editor REST proxy directly.
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const res = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`exec_sql RPC failed (${res.status}). Response:`, body.slice(0, 500));
    console.error(
      '\nThis project likely does not have an `exec_sql` Postgres function.\n' +
      'Open the Supabase SQL Editor and paste the contents of db/migrations/0001_init.sql, then run it.\n' +
      `URL: ${url.replace('https://', 'https://app.supabase.com/project/').replace(/\.supabase\.co$/, '')}/sql/new`
    );
    process.exit(1);
  }
  console.log('Migration applied.');

  // Sanity: verify a table exists
  const sb = getSupabase();
  const { error } = await sb.from('clients').select('id').limit(1);
  if (error) {
    console.error('Sanity check failed:', error.message);
    process.exit(1);
  }
  console.log('Sanity check passed: clients table is queryable.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
