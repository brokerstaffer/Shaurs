import { NextResponse } from 'next/server';
import { findLabelId, listAllProspects } from '@/lib/masterinbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/masterinbox/intros
// Returns every prospect tagged "Introduction" in MasterInbox, plus a total
// count. This is MasterInbox-only — it does not touch the Corofy source.
export async function GET() {
  try {
    const labelId = await findLabelId('Introduction');
    if (labelId === null) {
      return NextResponse.json(
        { ok: false, error: '"Introduction" label not found in MasterInbox workspace' },
        { status: 404 }
      );
    }

    const prospects = await listAllProspects(100);
    const intros = prospects
      .filter((p) => p.labels?.includes(labelId))
      .map((p) => {
        const introMs = p.last_message ?? p.last_received_at ?? p.updated_at;
        return {
          email: p.email,
          name: p.name,
          campaign_id: p.campaign_id ?? null,
          campaign_name: p.campaign_name ?? null,
          intro_at: new Date(introMs).toISOString(),
          created_at: new Date(p.created_at).toISOString(),
          updated_at: new Date(p.updated_at).toISOString(),
        };
      })
      .sort((a, b) => b.intro_at.localeCompare(a.intro_at));

    return NextResponse.json({
      ok: true,
      source: 'masterinbox',
      label: 'Introduction',
      label_id: labelId,
      count: intros.length,
      intros,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
