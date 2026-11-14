import { describe, it, expect, beforeEach } from 'vitest';
import { initToken, requireAuth } from '@/lib/auth';

const g = globalThis as Record<string, unknown>;

describe('auth（令牌与 API 认证）', () => {
  beforeEach(() => {
    delete g.__abToken;                          // 每条用例重置单例
    process.env.BOARD_TOKEN = 'fixed-token';
  });

  it('initToken 优先 BOARD_TOKEN，且幂等（重启前不换）', () => {
    expect(initToken()).toBe('fixed-token');
    expect(initToken()).toBe('fixed-token');
  });

  it('initToken 无 env 时随机生成 32 位 hex', () => {
    delete process.env.BOARD_TOKEN;
    expect(initToken()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('requireAuth：token 匹配 + Origin 同 host → 放行（返回 null）', () => {
    g.__abToken = 'tt';
    const req = new Request('http://nas:3423/api/overview',
      { headers: { 'x-auth-token': 'tt', origin: 'http://nas:3423', host: 'nas:3423' } });
    expect(requireAuth(req)).toBeNull();
  });

  it('requireAuth：token 不匹配 → 401', () => {
    g.__abToken = 'tt';
    const req = new Request('http://nas:3423/api/overview',
      { headers: { 'x-auth-token': 'wrong' } });
    const res = requireAuth(req)!;
    expect(res.status).toBe(401);
  });

  it('requireAuth：Origin 跨 host → 403（CSRF 防护）', () => {
    g.__abToken = 'tt';
    const req = new Request('http://nas:3423/api/automations/toggle',
      { method: 'POST', headers: { 'x-auth-token': 'tt', origin: 'http://evil:8080', host: 'nas:3423' } });
    const res = requireAuth(req)!;
    expect(res.status).toBe(403);
  });

  it('requireAuth：无 Origin（curl/healthcheck）token 对即放行', () => {
    g.__abToken = 'tt';
    const req = new Request('http://nas:3423/api/overview', { headers: { 'x-auth-token': 'tt' } });
    expect(requireAuth(req)).toBeNull();
  });
});
