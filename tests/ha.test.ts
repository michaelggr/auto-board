import { describe, it, expect } from 'vitest';
import { logbookToEvents, detectLogbookGap } from '@/collector/ha';

describe('logbookToEvents', () => {
  it('过滤 automation.*，context_id 可用时作幂等键，缺失退化 entity_id+时间', () => {
    const entries = [
      { when: '2026-11-05T01:00:00.000Z', entity_id: 'automation.a', name: 'A', context_id: 'ctx1' },
      { when: '2026-11-05T01:05:00.000Z', entity_id: 'light.x', name: '灯', context_id: 'ctx2' }, // 非 automation → 过滤
      { when: '2026-11-05T01:10:00.000Z', entity_id: 'automation.b', name: 'B' },                   // 无 context_id
    ];
    const evs = logbookToEvents(entries as any[]);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ source: 'ha', key: 'automation.a', ts: Date.parse('2026-11-05T01:00:00.000Z'), count: true });
    expect(evs[0].dedupKey).toBe('ctx1:automation.a');
    expect(evs[1].dedupKey).toBe('automation.b:1793841000000');
  });

  it('非法时间不产生事件', () => {
    const evs = logbookToEvents([
      { when: 'invalid-date', entity_id: 'automation.invalid', name: 'Invalid' },
    ]);
    expect(evs).toEqual([]);
  });

  it('水位衔接检测：最旧条目距水位 > 10min 判 gap', () => {
    const watermark = Date.parse('2026-11-05T00:00:00Z');
    const oldest = Date.parse('2026-11-05T00:30:00Z');
    expect(detectLogbookGap(watermark, oldest)).toEqual({ from: watermark, to: oldest });
    expect(detectLogbookGap(watermark, watermark + 60_000)).toBeNull();
  });
});
