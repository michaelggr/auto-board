import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getHeatmap } from '@/lib/queries';

// GET /api/heatmap?window=month&key=automation.xxx（设计 §10；key 省略=全源合计）
const WINDOWS: Record<string, number> = { month: 30, quarter: 90, year: 365 };
export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const windowDays = WINDOWS[url.searchParams.get('window') ?? 'quarter'] ?? 90;
  const key = url.searchParams.get('key') ?? undefined;
  return Response.json(getHeatmap(getDb(), windowDays, key));
}
