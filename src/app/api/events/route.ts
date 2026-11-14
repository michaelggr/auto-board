import { requireAuth } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getEvents } from '@/lib/queries';

// GET /api/events?source=&key=&since=&to=&limit=&lane=sideBySide（设计 §10）
export async function GET(req: Request) {
  const denied = requireAuth(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const num = (k: string) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : undefined);
  return Response.json(getEvents(getDb(), {
    lane: url.searchParams.get('lane') === 'sideBySide' ? 'sideBySide' : undefined,
    since: num('since'), to: num('to'), limit: num('limit'),
    source: url.searchParams.get('source') ?? undefined,
    key: url.searchParams.get('key') ?? undefined,
  }));
}
