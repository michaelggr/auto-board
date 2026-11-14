import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { undoAction } from '@/lib/control';

// POST /api/automations/undo  body: {actionId}
export async function POST(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const { actionId } = await req.json().catch(() => ({}) as { actionId?: number });
  if (!Number.isInteger(actionId)) return Response.json({ error: '参数不合法' }, { status: 400 });
  const r = await undoAction(getDb(), Number(actionId));
  return Response.json(r, { status: r.status });
}
