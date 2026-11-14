import { describe, it, expect } from 'vitest';
import { testDb } from '@/lib/db';
import { getOverview, getHeatmap, getEvents, getInsights } from '@/lib/queries';
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

describe('getEvents', () => {
  it('merged：倒序 + since 上界 + limit 截断', () => {
    const db = testDb();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      insertEvents(db, [ev({ key: 'k', ts: t0 - i * 1000, dedupKey: `d${i}` })]);
    }
    const r = getEvents(db, { since: t0 - 1000, limit: 2 });
    expect((r.rows ?? []).map((x: any) => x.dedupKey ?? x.id)).toBeDefined();
    expect(r.rows).toHaveLength(2);
    expect(r.rows![0].ts).toBeGreaterThanOrEqual(r.rows![1].ts);
    expect(r.rows![0].ts).toBeLessThanOrEqual(t0 - 1000);
  });

  it('sideBySide：两侧各查 limit 条且忽略 source 参数', () => {
    const db = testDb();
    const t0 = Date.now();
    insertEvents(db, [
      ev({ key: 'a', ts: t0, dedupKey: 'h1' }),
      { ...ev({ key: 'g', ts: t0 - 1000, dedupKey: 'k1' }), source: 'geek', kind: 'rule' },
    ]);
    const r = getEvents(db, { lane: 'sideBySide', limit: 50, source: 'ha' });
    expect(r.left![0].source).toBe('geek');
    expect(r.right![0].source).toBe('ha');
  });
});

describe('getInsights', () => {
  it('僵尸=启用中且 N 天零触发（first_seen 兜底；停用/新规则/近期触发均不算）', () => {
    const db = testDb();
    const now = Date.now();
    const day = 86_400_000;
    db.prepare(`INSERT INTO automations (source, key, name, enabled, last_triggered, first_seen, last_seen) VALUES
      ('ha', 'z1', '僵尸', 1, NULL, ${now - 40 * day}, ${now}),
      ('ha', 'z2', '新规则', 1, NULL, ${now - 1000}, ${now}),
      ('ha', 'z3', '近期触发过', 1, ${now - 1000}, ${now - 40 * day}, ${now}),
      ('ha', 'z4', '停用', 0, NULL, ${now - 40 * day}, ${now})`).run();
    const ins = getInsights(db, 30);
    expect(ins.zombies.map((z) => z.key)).toEqual(['z1']);
  });

  it('幽灵 = deleted_at 非空；设备依赖度聚合快照 did 并映射设备名', () => {
    const db = testDb();
    db.prepare(`INSERT INTO automations (source, key, name, first_seen, last_seen, deleted_at) VALUES
      ('geek', 'g0', '已删规则', 0, 0, 123456)`).run();
    db.prepare(`INSERT INTO automations (source, key, name, first_seen, last_seen) VALUES
      ('geek', 'g1', 'R1', 0, 0)`).run();
    db.prepare(`INSERT INTO automation_snapshots (source, key, hash, cfg, captured_at) VALUES
      ('geek', 'g1', 'h1', ?, 10)`).run(JSON.stringify({ nodes: [{ props: { did: 'd1' } }, { props: { did: 'd1' } }] }));
    db.prepare(`INSERT INTO kv VALUES ('geek_devlist', ?)`).run(JSON.stringify({ d1: { name: '客厅灯' } }));
    const ins = getInsights(db, 30);
    expect(ins.ghosts.map((x) => x.key)).toEqual(['g0']);
    expect(ins.deviceDeps[0]).toMatchObject({ did: 'd1', name: '客厅灯' });
    expect(ins.deviceDeps[0].rules).toEqual(['R1']);
  });

  it('覆盖率：窗口内有触发的未删除规则 / 未删除规则总数（分源）', () => {
    const db = testDb();
    const now = Date.now();
    db.prepare(`INSERT INTO automations (source, key, name, first_seen, last_seen) VALUES
      ('ha', 'a', 'A', 0, 0), ('ha', 'b', 'B', 0, 0)`).run();
    insertEvents(db, [ev({ key: 'a', ts: now, dedupKey: 'a1' })]);
    const ins = getInsights(db, 30);
    const c = ins.coverage.find((x) => x.source === 'ha')!;
    expect(c).toMatchObject({ active: 1, total: 2 });
  });

  it('抖动：相邻触发间隔中位数 < 60s 的规则入选', () => {
    const db = testDb();
    db.prepare(`INSERT INTO automations (source, key, name, first_seen, last_seen) VALUES
      ('ha', 'a', 'A', 0, 0)`).run();
    const t0 = Date.now() - 3_600_000;
    insertEvents(db, [
      ev({ key: 'a', ts: t0, dedupKey: 'j1' }),
      ev({ key: 'a', ts: t0 + 30_000, dedupKey: 'j2' }),
      ev({ key: 'a', ts: t0 + 60_000, dedupKey: 'j3' }),
    ]);
    const ins = getInsights(db, 30);
    expect(ins.jitter.some((j) => j.key === 'a' && j.medianGapMs < 60_000)).toBe(true);
  });

  it('健康分：无断档无僵尸无错误 → 100', () => {
    const db = testDb();
    db.prepare(`INSERT INTO automations (source, key, name, enabled, last_triggered, first_seen, last_seen) VALUES
      ('ha', 'a', 'A', 1, ${Date.now()}, 0, 0)`).run();
    const ins = getInsights(db, 30);
    expect(ins.health.find((h) => h.source === 'ha')!.score).toBe(100);
  });
});
