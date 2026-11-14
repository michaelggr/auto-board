import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getInsights } from '@/lib/queries';

// GET /api/insights?zombie_days=30（设计 §10：僵尸/依赖度/覆盖率/变更时间线 + 健康分/抖动）
export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const zombieDays = Math.min(Number(url.searchParams.get('zombie_days') || 30), 365);
  return Response.json(getInsights(getDb(), zombieDays));
}
