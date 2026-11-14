import { getDb } from '@/lib/db';
import { getGeekSession } from '@/collector/geek/session';

// GET /api/health —— 两侧连接状态、数据新鲜度、断档摘要（设计 §10）
export async function GET() {
  const db = getDb();
  const geek = getGeekSession();
  const ha = (globalThis as { __abHaWs?: { isConnected(): boolean } }).__abHaWs;
  const watermark = db.prepare(`SELECT v FROM kv WHERE k='geek_watermark'`).get() as { v: string } | undefined;
  // 最近 24h 断档桶数（黄条文案用）
  const since = Date.now() - 86_400_000;
  const gaps = db.prepare(
    `SELECT source, COUNT(*) AS c FROM agg_hourly WHERE incomplete=1 AND hour_bucket>=? GROUP BY source`
  ).all(since) as { source: string; c: number }[];
  return Response.json({
    ok: true,
    geek: { status: geek.status, lastError: geek.lastError ?? null },
    ha: { connected: ha?.isConnected() ?? false },
    geekWatermark: watermark ? Number(watermark.v) : 0,
    gapBuckets24h: Object.fromEntries(gaps.map((r) => [r.source, r.c])),
    time: Date.now(),
  });
}
