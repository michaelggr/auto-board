import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeekSession, type GatewayLike } from '@/collector/geek/session';

// fake 客户端：可编程成功/失败，记录调用
function fakeClient(behavior: { auth?: 'ok' | 'fail'; heartbeatFailAfter?: number }) {
  let calls = 0;
  return {
    calls: [] as string[],
    async connect() { this.calls.push('connect'); },
    async authenticate() { if (behavior.auth === 'fail') throw new Error('登录码已被使用'); },
    async callApi(method: string) {
      this.calls.push(method);
      if (method === 'getVarList') {
        if (behavior.heartbeatFailAfter !== undefined && ++calls > behavior.heartbeatFailAfter) throw new Error('心跳失败');
      }
      return {};
    },
    async close() { this.calls.push('close'); },
    isConnected() { return true; },
  } as GatewayLike & { calls: string[] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('GeekSession 状态机', () => {
  it('输码连接成功 → connected + 回调触发', async () => {
    const events: string[] = [];
    const s = new GeekSession(() => fakeClient({}), 'http://gw', (e) => events.push(e));
    await s.connect('123456');
    expect(s.status).toBe('connected');
    expect(events).toEqual(['connected']);
    await s.call('getGraphList');
    expect((s.client as GatewayLike & { calls: string[] }).calls).toContain('getGraphList');
  });

  it('once 监听器只在首次 connected 触发一次', async () => {
    const events: string[] = [];
    const onceEvents: string[] = [];
    const s = new GeekSession(() => fakeClient({}), 'http://gw', (e) => events.push(e));
    s.addOnceListener((e) => onceEvents.push(e));
    await s.connect('123456');
    await s.connect('234567');
    expect(events).toEqual(['connected', 'connected']);
    expect(onceEvents).toEqual(['connected']);
  });

  it('认证失败 → disconnected 且记录错误（登录码一次性提示透传）', async () => {
    const s = new GeekSession(() => fakeClient({ auth: 'fail' }), 'http://gw', () => {});
    await expect(s.connect('123456')).rejects.toThrow('登录码已被使用');
    expect(s.status).toBe('disconnected');
    expect(s.lastError).toBeTruthy();
  });

  it('未连接时 call 直接抛错（采集任务静默跳过）', () => {
    const s = new GeekSession(() => fakeClient({}), 'http://gw', () => {});
    expect(() => s.call('getGraphList')).toThrow();
  });

  it('心跳失败 → 自动降级 disconnected + close + 回调（黄条来源）', async () => {
    const events: string[] = [];
    const s = new GeekSession(() => fakeClient({ heartbeatFailAfter: 2 }), 'http://gw', (e) => events.push(e));
    await s.connect('123456');
    await vi.advanceTimersByTimeAsync(75_000 * 3);   // 3 次心跳，第 3 次失败
    expect(s.status).toBe('disconnected');
    expect(events).toEqual(['connected', 'disconnected']);
    expect((s.client as GatewayLike & { calls: string[] }).calls).toContain('close');
  });
});
