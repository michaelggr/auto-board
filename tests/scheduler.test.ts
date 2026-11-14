import { describe, it, expect } from 'vitest';
import { SerialQueue, registerOnce } from '@/collector/scheduler';

describe('SerialQueue（单写者：所有写库任务串行化）', () => {
  it('任务按提交顺序串行执行，前序失败不阻塞后序', async () => {
    const q = new SerialQueue();
    const order: number[] = [];
    const p1 = q.run(async () => { await new Promise((r) => setTimeout(r, 30)); order.push(1); });
    const p2 = q.run(async () => { order.push(2); throw new Error('boom'); });
    const p3 = q.run(async () => { order.push(3); });
    await Promise.allSettled([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
    await expect(p2).rejects.toThrow('boom');
  });
});

describe('registerOnce（全局单例锁，防 dev 热重载重复注册）', () => {
  it('同一 key 只执行一次', () => {
    const g = globalThis as Record<string, unknown>;
    g.__reg_test = undefined;
    let count = 0;
    const run = () => registerOnce('__reg_test', () => { count++; });
    run(); run(); run();
    expect(count).toBe(1);
  });
});
