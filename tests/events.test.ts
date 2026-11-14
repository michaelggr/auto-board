import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, type DB } from '@/lib/db';
import { insertEvents, applyThrottle, markGap, type NewEvent } from '@/ingest/events';

let db: DB;
beforeEach(() => { db = testDb(); });

const ev = (o: Partial<NewEvent>): NewEvent => ({
  source: 'geek', key: 'rule_1', name: '回家开灯', ts: Date.UTC(2026, 10, 5, 1, 0, 0),
  kind: 'rule', dedupKey: 'dk1', count: true, ...o,
});

describe('insertEvents 幂等与聚合', () => {
  it('重放同批次：第二次 inserted=0，聚合计数不变（验收 2 的核心）', () => {
    const batch = [ev({}), ev({ dedupKey: 'dk2', ts: Date.UTC(2026, 10, 5, 1, 10, 0), count: false })];
    expect(insertEvents(db, batch)).toEqual({ inserted: 2, skipped: 0 });
    expect(insertEvents(db, batch)).toEqual({ inserted: 0, skipped: 2 });   // 全部命中 UNIQUE
    const h = db.prepare('SELECT SUM(count) c FROM agg_hourly').get() as { c: number };
    expect(h.c).toBe(1);   // 只有 count:true 的组头行计入触发数，重放不重复计
  });

  it('同小时多事件聚合到同一桶；daily 同步；last_triggered 推进', () => {
    insertEvents(db, [
      ev({ source: 'ha', kind: 'trigger', key: 'automation.a', dedupKey: 'ha1', count: true }),
      ev({ source: 'ha', kind: 'trigger', key: 'automation.a', dedupKey: 'ha2', ts: Date.UTC(2026, 10, 5, 1, 30, 0), count: true }),
    ]);
    const h = db.prepare('SELECT count FROM agg_hourly WHERE source=?').get('ha') as { count: number };
    const d = db.prepare('SELECT count FROM agg_daily WHERE source=?').get('ha') as { count: number };
    expect([h.count, d.count]).toEqual([2, 2]);
    // automations 表需要先有行（真实链路里由清单同步写入）；upsert 保险
    db.prepare('INSERT OR IGNORE INTO automations VALUES (?,?,?,?,?,?,?,?,?)')
      .run('ha', 'automation.a', '自动化A', null, null, 0, 0, 0, null);
    insertEvents(db, [ev({ source: 'ha', key: 'automation.a', dedupKey: 'ha3', count: true })]);
    const a = db.prepare('SELECT last_triggered FROM automations WHERE key=?').get('automation.a') as { last_triggered: number };
    expect(a.last_triggered).toBeGreaterThan(0);
  });
});

describe('applyThrottle 限流保护', () => {
  it('单规则单批超上限：截断并记一条 throttled', () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      ev({ dedupKey: `dk${i}`, ts: Date.UTC(2026, 10, 5, 1, 0, i % 60), count: false, lineNo: i }));
    const { events, throttled } = applyThrottle(many, 500);
    expect(events).toHaveLength(500);
    expect(throttled).toBe(true);
    expect(events.at(-1)!.kind).toBe('throttled');   // 末尾一条 throttled 标记事件
    expect(events.at(-1)!.raw).toContain('丢弃 101 行');
  });
});

describe('markGap 断档回写（验收 5）', () => {
  it('gap 覆盖桶置 incomplete=1（含 count=0 的新桶），已有 count 保留；daily 传染', () => {
    db.prepare('INSERT INTO automations VALUES (?,?,?,?,?,?,?,?,?)')
      .run('geek', 'rule_1', '回家开灯', null, 1, 0, 0, 0, null);
    // 先在 gap 前落一个正常桶（count=1）
    insertEvents(db, [ev({})]);
    const from = Date.UTC(2026, 10, 6, 0, 0, 0);
    const to = Date.UTC(2026, 10, 6, 3, 0, 0);       // 覆盖 3 个小时桶
    markGap(db, 'geek', from, to);
    const rows = db.prepare(`SELECT hour_bucket, count, incomplete FROM agg_hourly
                             WHERE source='geek' AND hour_bucket>=? AND hour_bucket<? ORDER BY hour_bucket`).all(from, to) as any[];
    expect(rows).toHaveLength(3);                     // count=0 的桶也被插入（灰纹可见的前提）
    expect(rows.every((r) => r.incomplete === 1 && r.count === 0)).toBe(true);
    // gap 前的正常桶不受影响
    const before = db.prepare(`SELECT count, incomplete FROM agg_hourly
                               WHERE source='geek' AND hour_bucket=?`).get(Date.UTC(2026, 10, 5, 1, 0, 0)) as any;
    expect([before.count, before.incomplete]).toEqual([1, 0]);
    // daily 传染
    const d = db.prepare(`SELECT incomplete FROM agg_daily WHERE source='geek' AND date='2026-11-06'`).get() as any;
    expect(d.incomplete).toBe(1);
  });
});
