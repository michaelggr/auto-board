import { describe, it, expect, vi } from 'vitest';
import { testDb } from '@/lib/db';
import { toggleAutomation, undoAction } from '@/lib/control';

// 假会话：GatewayLike.call 的可注入替身（fail=true 时模拟网关断开）
const fakeSession = (fail = false) => ({
  call: vi.fn(async () => { if (fail) throw new Error('网关断开'); }),
});

function seed(db: ReturnType<typeof testDb>) {
  db.prepare(`INSERT INTO automations (source, key, name, enabled, first_seen, last_seen) VALUES
    ('geek', 'g1', '客厅开灯', 1, 0, 0),
    ('ha', 'automation.h1', '客厅开灯', 1, 0, 0)`).run();
}

describe('toggleAutomation', () => {
  it('geek 启停成功：调用 changeGraphConfig + 更新 enabled + 写 success 审计', async () => {
    const db = testDb(); seed(db);
    const s = fakeSession();
    const r = await toggleAutomation(db, 'geek', 'g1', false, { session: s });
    expect(r.status).toBe(200);
    expect(s.call).toHaveBeenCalledWith('changeGraphConfig', { id: 'g1', enable: false });
    expect((db.prepare(`SELECT enabled FROM automations WHERE key='g1'`).get() as any).enabled).toBe(0);
    expect(db.prepare(`SELECT action, prev_state, result, undone FROM actions`).get()).toMatchObject({
      action: 'disable', prev_state: 1, result: 'success', undone: 0,
    });
  });

  it('配对且对侧反向 → 409；confirmPair=true 放行', async () => {
    const db = testDb(); seed(db);
    db.prepare(`INSERT INTO rule_pairs (ha_key, geek_key, note, created_at) VALUES ('automation.h1','g1','同名配对',0)`).run();
    const r = await toggleAutomation(db, 'geek', 'g1', false, { session: fakeSession() });
    expect(r.status).toBe(409);                       // HA 侧仍启用 → 提醒双系统并跑
    if (r.status === 409) expect(r.pair.key).toBe('automation.h1');
    const r2 = await toggleAutomation(db, 'geek', 'g1', false, { session: fakeSession(), confirmPair: true });
    expect(r2.status).toBe(200);
  });

  it('配对但规则不存在/已删除 → 不警告', async () => {
    const db = testDb(); seed(db);
    db.prepare(`INSERT INTO rule_pairs (ha_key, geek_key, note, created_at) VALUES ('automation.gone','g1','已删侧',0)`).run();
    const r = await toggleAutomation(db, 'geek', 'g1', false, { session: fakeSession() });
    expect(r.status).toBe(200);                       // 对侧已删除 → 无护栏
  });

  it('执行失败 → 502 + 写 fail 审计行（enabled 不动）', async () => {
    const db = testDb(); seed(db);
    const r = await toggleAutomation(db, 'geek', 'g1', false, { session: fakeSession(true) });
    expect(r.status).toBe(502);
    expect((db.prepare(`SELECT enabled FROM automations WHERE key='g1'`).get() as any).enabled).toBe(1);
    expect((db.prepare(`SELECT result FROM actions`).get() as any).result).toBe('fail');
  });

  it('HA 启停走 REST services 且带 Bearer（vitest env HA_TOKEN=test-token）', async () => {
    const db = testDb(); seed(db);
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true } as Response));
    const r = await toggleAutomation(db, 'ha', 'automation.h1', false, { fetchImpl: fetchImpl as any });
    expect(r.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/services/automation/turn_off');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });
});

describe('undoAction', () => {
  it('撤回 = 反向执行 + 标 undone；重复撤回 404', async () => {
    const db = testDb(); seed(db);
    const s = fakeSession();
    const t = await toggleAutomation(db, 'geek', 'g1', false, { session: s });
    const actionId = (t as { actionId: number }).actionId;
    const u = await undoAction(db, actionId, { session: s });
    expect(u.status).toBe(200);
    expect((db.prepare(`SELECT undone FROM actions WHERE id=?`).get(actionId) as any).undone).toBe(1);
    expect((db.prepare(`SELECT enabled FROM automations WHERE key='g1'`).get() as any).enabled).toBe(1); // 已恢复启用
    const u2 = await undoAction(db, actionId, { session: s });
    expect(u2.status).toBe(404);                       // 已撤回的不能再撤
  });

  it('撤销产生的操作也有审计行（可再撤回）', async () => {
    const db = testDb(); seed(db);
    const s = fakeSession();
    const t = await toggleAutomation(db, 'geek', 'g1', false, { session: s });
    const undo = await undoAction(db, (t as { actionId: number }).actionId, { session: s });
    expect(undo.status).toBe(200);
    const rows = db.prepare(`SELECT action FROM actions ORDER BY id`).all() as { action: string }[];
    expect(rows.map((x) => x.action)).toEqual(['disable', 'enable']);  // undo 也是一次操作
  });
});
