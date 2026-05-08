import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const sb = getSupabase();
  const { data, error } = await sb.from('clients').select('*').order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clients: data });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const sb = getSupabase();
  const { data, error } = await sb
    .from('clients')
    .insert({
      name: body.name,
      plan: body.plan,
      weekly_target: body.weekly_target,
      start_date: body.start_date ?? null,
      instantly_campaign_ids: body.instantly_campaign_ids ?? [],
      masterinbox_identifier: body.masterinbox_identifier ?? null,
      campaign_size: body.campaign_size ?? 0,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ client: data }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const sb = getSupabase();
  const { data, error } = await sb
    .from('clients')
    .update({
      name: body.name,
      plan: body.plan,
      weekly_target: body.weekly_target,
      start_date: body.start_date,
      instantly_campaign_ids: body.instantly_campaign_ids,
      masterinbox_identifier: body.masterinbox_identifier,
    })
    .eq('id', body.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ client: data });
}

export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const sb = getSupabase();
  const { error } = await sb.from('clients').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
