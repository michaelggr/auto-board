import type { DB } from '@/lib/db';
import { hourBucket, localDateKey } from '@/lib/time';

export interface NewEvent {
  source: 'ha' | 'geek';
  key: string;                // HA: entity_id；极客版: graph ID（未映射时暂存规则名）
  name?: string;
  ts: number;                 // UTC epoch ms
  kind: string;               // rule|device|action|trigger|other|parse_error|throttled
  dedupKey: string;
  count: boolean;             // 是否计入触发数：HA 每事件 true；极客版仅组头行 true
  groupId?: string | null;    // 极客版分组 ID（组头行锚定）
  lineNo?: number | null;
  page?: number | null;
  raw?: string;
}

const MAX_PER_RULE = 500;   // 单规则单批行数上限（防抖动规则刷爆表）

/**
 * 限流：超限规则截断到上限，末尾补一条 throttled 事件（不丢"被限流"这个事实）。
 * throttled 事件 raw 记录丢弃量，绝不参与聚合计数。
 */
export function applyThrottle(events: NewEvent[], max = MAX_PER_RULE): { events: NewEvent[]; throttled: boolean } {
  const byKey = new Map<string, NewEvent[]>();
  for (const e of events) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  let throttled = false;
  const out: NewEvent[] = [];
  for (const [key, rows] of byKey) {
    if (rows.length <= max) { out.push(...rows); continue; }
    throttled = true;
    const kept = rows.slice(0, max - 1);
    const maxTs = Math.max(...rows.map((r) => r.ts));
    kept.push({
      source: rows[0].source, key, ts: maxTs, kind: 'throttled',
      dedupKey: `${key}|throttle|${maxTs}`, count: false,
      raw: `throttled: 丢弃 ${rows.length - max + 1} 行`,
    });
    out.push(...kept);
  }
  return { events: out, throttled };
}

/** 幂等批量入库 + 联动聚合。只对实际新插入的 count:true 行推进计数。 */
export function insertEvents(db: DB, events: NewEvent[]): { inserted: number; skipped: number } {
  const ins = db.prepare(`INSERT OR IGNORE INTO events_raw
    (source, key, name, ts, kind, dedup_key, group_id, line_no, page, raw, created_at)
    VALUES (@source, @key, @name, @ts, @kind, @dedupKey, @groupId, @lineNo, @page, @raw, @createdAt)`);
  const upHourly = db.prepare(`INSERT INTO agg_hourly (source, key, hour_bucket, count, incomplete)
    VALUES (?, ?, ?, 1, 0) ON CONFLICT(source, key, hour_bucket) DO UPDATE SET count = count + 1`);
  const upDaily = db.prepare(`INSERT INTO agg_daily (source, key, date, count, incomplete)
    VALUES (?, ?, ?, 1, 0) ON CONFLICT(source, key, date) DO UPDATE SET count = count + 1`);
  const upLast = db.prepare(`UPDATE automations SET last_triggered = MAX(COALESCE(last_triggered, 0), ?)
    WHERE source = ? AND key = ?`);
  const now = Date.now();
  let inserted = 0, skipped = 0;

  db.transaction(() => {
    for (const e of events) {
      const r = ins.run({ ...e, name: e.name ?? null, groupId: e.groupId ?? null,
        lineNo: e.lineNo ?? null, page: e.page ?? null, raw: e.raw ?? null, createdAt: now });
      if (r.changes === 0) { skipped++; continue; }   // 幂等：重放行不重复计数
      inserted++;
      upLast.run(e.ts, e.source, e.key);
      if (!e.count || e.kind === 'parse_error' || e.kind === 'throttled') continue;
      upHourly.run(e.source, e.key, hourBucket(e.ts));
      upDaily.run(e.source, e.key, localDateKey(e.ts));
    }
  })();
  return { inserted, skipped };
}

/**
 * 断档回写（事后发现 gap 也要能补标）：[from, to) 覆盖的每个小时桶，
 * 对该源所有未删除规则 upsert incomplete=1（count 保留；count=0 的桶插入以便灰纹展示）。
 * daily 按日期范围传染。UI 必须区分"0 次触发"与"未知"——本函数就是"未知"的来源。
 */
export function markGap(db: DB, source: 'ha' | 'geek', fromMs: number, toMs: number): void {
  const keys = db.prepare(`SELECT key FROM automations WHERE source = ? AND deleted_at IS NULL`)
    .all(source) as { key: string }[];
  const upH = db.prepare(`INSERT INTO agg_hourly (source, key, hour_bucket, count, incomplete)
    VALUES (?, ?, ?, 0, 1) ON CONFLICT(source, key, hour_bucket) DO UPDATE SET incomplete = 1`);
  const upD = db.prepare(`INSERT INTO agg_daily (source, key, date, count, incomplete)
    VALUES (?, ?, ?, 0, 1) ON CONFLICT(source, key, date) DO UPDATE SET incomplete = 1`);
  db.transaction(() => {
    for (let h = hourBucket(fromMs); h < toMs; h += 3_600_000) {
      const date = localDateKey(h);
      for (const { key } of keys) {
        upH.run(source, key, h);
        upD.run(source, key, date);
      }
    }
  })();
}
