import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testDb, type DB } from '@/lib/db';
import { GeekSession, type GatewayLike } from '@/collector/geek/session';
import { syncGeekList, collectGeekLog } from '@/collector/geek/sync';

// 最小 fake 客户端：按 method 返回真实字段形状，不依赖网关网络。
function fakeClient(handlers: Record<string, unknown>) {
  return {
    calls: [] as string[],
    async connect() {},
    async authenticate() {},
    async callApi(method: string, params?: Record<string, unknown>) {
      this.calls.push(method);
      const value = handlers[method];
      return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value;
    },
    async close() {},
    isConnected() { return true; },
  } as GatewayLike & { calls: string[] };
}

async function connectedSession(handlers: Record<string, unknown>) {
  const session = new GeekSession(() => fakeClient(handlers), 'http://gw', () => {});
  await session.connect('123456');
  return session;
}

let db: DB;
beforeEach(() => { db = testDb(); });
afterEach(() => db.close());

describe('极客版清单同步', () => {
  it('按真实字段 userData.name/enable 写入名称和启停状态，缺失名称回退 ID', async () => {
    // 先放一条已消失的旧规则，验证不会被误保留。
    db.prepare(`INSERT INTO automations (source, key, name, enabled, first_seen, last_seen)
      VALUES ('geek', '999', '旧规则', 1, 1, 1)`).run();

    const session = await connectedSession({
      getGraphList: [
        { id: '1001', enable: true, userData: { name: '客厅自动开灯' } },
        { id: '1002', enable: false, userData: { name: '' } },
      ],
      getDevList: { devList: { 'dev-1': { name: '筒灯', roomName: '客厅' } } },
      getGraph: (params?: Record<string, unknown>) =>
        params?.id === '1001' ? { nodes: [{ props: { did: 'dev-1' } }] } : { nodes: [] },
    });

    await syncGeekList(db, session);

    const rows = db.prepare(`SELECT key, name, enabled, room, deleted_at FROM automations
      WHERE source='geek' ORDER BY key`).all() as any[];
    expect(rows).toEqual([
      { key: '1001', name: '客厅自动开灯', enabled: 1, room: '客厅', deleted_at: null },
      { key: '1002', name: '1002', enabled: 0, room: null, deleted_at: null },
      { key: '999', name: '旧规则', enabled: 1, room: null, deleted_at: expect.any(Number) },
    ]);

    const names = db.prepare('SELECT name, geek_key FROM name_index ORDER BY geek_key').all() as any[];
    expect(names).toEqual([
      { name: '客厅自动开灯', geek_key: '1001' },
      { name: '1002', geek_key: '1002' },
    ]);
  });
});

describe('极客版日志采集', () => {
  it('v3 日志按规则 ID 直接入库，规则启用只计一次并推进水位', async () => {
    const page = [
      '3|1795000000000|r|1001|{"enable":true}',
      '3|1795000000001|i|1001|node-1|success',
      '3|1795000000002|l|1001|sensor.trigger|light.open|true',
      '3|1795000000004|r|1002|{"enable":false}',
    ].join('\n');

    const session = await connectedSession({
      getGraphList: [],
      getDevList: { devList: {} },
      // 第 0 页有日志，后续页为空，模拟 getLog 翻页结束。
      getLog: (params?: Record<string, unknown>) => (params?.num === 0 ? page : ''),
    });

    await collectGeekLog(db, session);

    const raw = db.prepare(`SELECT key, COUNT(*) AS c FROM events_raw
      WHERE source='geek' GROUP BY key ORDER BY key`).all() as any[];
    expect(raw).toEqual([
      { key: '1001', c: 3 },
      { key: '1002', c: 1 },
    ]);

    const daily = db.prepare(`SELECT key, count FROM agg_daily
      WHERE source='geek' ORDER BY key`).all() as any[];
    expect(daily).toEqual([{ key: '1001', count: 1 }]);

    expect(db.prepare("SELECT v FROM kv WHERE k='geek_watermark'").get()).toEqual({ v: '1795000000004' });
  });
});
