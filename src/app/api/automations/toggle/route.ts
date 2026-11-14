import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { toggleAutomation } from '@/lib/control';

// POST /api/automations/toggle  body: {source, key, enable, confirmPair?}
// 409 = 成对护栏触发（响应体带 pair 供前端展示"对侧 xxx 仍启用/已停用，确认继续？"）
export async function POST(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  const { source, key, enable, confirmPair } = body as Record<string, unknown>;
  if ((source !== 'ha' && source !== 'geek') || typeof key !== 'string') {
    return Response.json({ error: '参数不合法' }, { status: 400 });
  }
  const r = await toggleAutomation(getDb(), source, key, !!enable, { confirmPair: !!confirmPair });
  return Response.json(r, { status: r.status });
}
