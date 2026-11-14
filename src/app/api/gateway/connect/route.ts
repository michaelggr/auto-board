import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getGeekSession } from '@/collector/geek/session';
import { syncGeekList } from '@/collector/geek/sync';

// POST /api/gateway/connect  body: {code: "123456"}
export async function POST(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const session = getGeekSession();
  if (session.status === 'connected') {
    return Response.json({ error: '已连接，无需重复输码' }, { status: 400 });
  }
  const { code } = await req.json().catch(() => ({}) as { code?: string });
  if (!code || !/^\d{6}$/.test(code)) {
    return Response.json({ error: '需要 6 位数字登录码' }, { status: 400 });
  }
  try {
    await session.connect(code);           // 失败信息留在 session.lastError，前端黄条展示
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
  // 连上立即拉一次清单（验收 1：输码后 5 分钟内可见——这里直接做到秒级）。
  // 与 scheduler 的 once 监听重复触发无害（清单同步是 upsert，天然幂等）。
  try { await syncGeekList(getDb(), session); } catch { /* 失败不阻塞：5 min 定时会补 */ }
  return Response.json({ ok: true, status: session.status });
}
