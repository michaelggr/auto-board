import { describe, it, expect } from 'vitest';
import { testDb } from '@/lib/db';
import { getOverview, getHeatmap } from '@/lib/queries';
import { insertEvents, markGap, type NewEvent } from '@/ingest/events';

// 造事件行的便捷函数（HA 形态：kind=trigger、count=true）
const ev = (o: Partial<NewEvent> & { key: string; ts: number; dedupKey: string }): NewEvent =>
  ({ source: 'ha', kind: 'trigger', count: true, ...o });

describe('getOverview', () => {
  it('今日/窗口计数、活跃规则、同环比', () => {
    const db = testDb();
    db.prepare(`INSERT INTO automations (source, key, name, enabled, first_seen, last_seen) VALUES
      ('ha', 'automation.a', 'A', 1, 0, 0), ('ha', 'automation.b', 'B', 1, 0, 0)`).run();
    const now = Date.now();
    const day3 = 86_400_000;
    // A：今天 2 次 + 上一窗口（35 天前）1 次；B：3 天前 1 次
    insertEvents(db, [
      ev({ key: 'automation.a', ts: now, dedupKey: 'a1' }),
      ev({ key: 'automation.a', ts: now - 1000, dedupKey: 'a2' }),
      ev({ key: 'automation.a', ts: now - 35 * day3, dedupKey: 'a3' }),
      ev({ key: 'automation.b', ts: now - 3 * day3, dedupKey: 'b1' }),
    ]);
    const o = getOverview(db, 30);
    const a = o.rank.find((r) => r.key === 'automation.a')!;
    const b = o.rank.find((r) => r.key === 'automation.b')!;
    expect(a.todayCount).toBe(2);
    expect(a.windowCount).toBe(2);
    expect(b.windowCount).toBe(1);
    const s = o.summaries.find((x) => x.source === 'ha')!;
    expect(s.activeRules).toBe(2);
    expect(s.prevWindowCount).toBe(1);
  });

  it('markGap 后 complete_only 过滤掉有断档的规则', () => {
    const db = testDb();
    db.prepare(`INSERT INTO automations (source, key, name, enabled, first_seen, last_seen) VALUES
      ('ha', 'automation.a', 'A', 1, 0, 0)`).run();
    insertEvents(db, [ev({ key: 'automation.a', ts: Date.now(), dedupKey: 'a1' })]);
    markGap(db, 'ha', Date.now() - 7_200_000, Date.now() - 3_600_000);
    const all = getOverview(db, 30, false);
    const onlyComplete = getOverview(db, 30, true);
    expect(all.rank).toHaveLength(1);
    expect(all.rank[0].incompleteDays).toBeGreaterThanOrEqual(1);
    expect(onlyComplete.rank).toHaveLength(0);
  });
});

describe('getHeatmap', () => {
  it('聚合到 7x24 网格（本地 dow/hour），incomplete 传染为 1', () => {
    const db = testDb();
    db.prepare(`INSERT INTO automations (source, key, name, first_seen, last_seen) VALUES
      ('ha', 'automation.a', 'A', 0, 0)`).run();
    const now = Date.now();
    insertEvents(db, [ev({ key: 'automation.a', ts: now, dedupKey: 'x1' })]);
    markGap(db, 'ha', now - 7_200_000, now - 3_600_000);
    const cells = getHeatmap(db, 30);
    expect(cells.some((c) => c.count === 1)).toBe(true);
    expect(cells.some((c) => c.incomplete === 1)).toBe(true);
    expect([...new Set(cells.map((c) => `${c.dow}-${c.hour}`))]).toHaveLength(cells.length);
  });

  it('key 参数只统计单规则', () => {
    const db = testDb();
    db.prepare(`INSERT INTO automations (source, key, name, first_seen, last_seen) VALUES
      ('ha', 'automation.a', 'A', 0, 0), ('ha', 'automation.b', 'B', 0, 0)`).run();
    const now = Date.now();
    insertEvents(db, [ev({ key: 'automation.a', ts: now, dedupKey: 'a1' })]);
    expect(getHeatmap(db, 30, 'automation.b')).toHaveLength(0);
    expect(getHeatmap(db, 30, 'automation.a')).toHaveLength(1);
  });
});
