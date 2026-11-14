import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getOverview } from '@/lib/queries';

// GET /api/overview?window=day|week|month&complete_only=0|1（设计 §10）
const WINDOWS: Record<string, number> = { day: 1, week: 7, month: 30 };
export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const windowDays = WINDOWS[url.searchParams.get('window') ?? 'month'] ?? 30;
  const completeOnly = url.searchParams.get('complete_only') === '1';
  return Response.json(getOverview(getDb(), windowDays, completeOnly));
}
