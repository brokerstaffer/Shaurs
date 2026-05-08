import { NextRequest, NextResponse } from 'next/server';
import { runSync } from '@/scripts/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // Optional shared-secret guard so the endpoint isn't a free DoS pad.
  const secret = process.env.SYNC_SECRET;
  if (secret) {
    const provided = req.headers.get('x-sync-secret') ?? new URL(req.url).searchParams.get('secret');
    if (provided !== secret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  try {
    const result = await runSync();
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
