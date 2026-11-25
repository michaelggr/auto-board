import type { DB } from '@/lib/db';
import { getGeekSession } from './geek/session';
import { syncGeekList, collectGeekLog } from './geek/sync';
import { logbookBackfill, syncHaList, startHaWs } from './ha';
import { cleanupOldEvents, dailyBackup, checkpointWal } from '@/ingest/maint';
import { getConfig } from '@/lib/config';

/** 串行队列：SQLite 单写者模型下所有写库任务经此串行（避免并发写与锁竞争） */
export class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);   // 前序失败不阻塞后序
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }
}

/** 全局单例注册（dev 热重载/prod 多入口都只跑一次） */
export function registerOnce(key: string, init: () => void): void {
  const g = globalThis as Record<string, unknown>;
  if (g[key]) return;
  g[key] = true;
  init();
}

/**
 * 采集器总装：定时注册一览（设计 §4）。
 * 吞错原则：任何任务失败只记日志不中断进程（下次轮询自愈）。
 */
export function startCollector(db: DB): void {
  const cfg = getConfig();
  const queue = new SerialQueue();
  const log = (job: string, err: unknown) => console.error(`[collector] ${job} 失败:`, err);

  // ---- HA 半边（未配 HA_URL 则整半边跳过，实现两侧独立降级）----
  if (cfg.haUrl && cfg.haToken) {
    registerOnce('__ab_ha', () => {
      startHaWs(db);
      // wsCall 依赖 WS 连接：清单/房间同步走独立短连 WS（每次开、查完关）
      setInterval(() => queue.run(() => withHaWs((call) => syncHaList(db, call))).catch((e) => log('ha_sync', e)), 300_000);
      queue.run(() => logbookBackfill(db)).catch((e) => log('ha_backfill', e));   // 首启回溯
    });
  }

  // ---- 极客版半边（未配 GATEWAY_URL 跳过；未输码前任务在入口抛错被吞）----
  if (cfg.gatewayUrl) {
    const session = getGeekSession((e) => console.log(`[collector] 极客版会话 ${e}`));
    registerOnce('__ab_geek', () => {
      // 连上后的首次全量同步（此后每 5 min 走定时）
      const once = (e: string) => { if (e === 'connected') queue.run(() => syncGeekList(db, session)).catch((er) => log('geek_sync', er)); };
      session.addOnceListener(once);
      setInterval(() => queue.run(() => collectGeekLog(db, session)).catch((e) => log('geek_log', e)), 60_000);
      setInterval(() => queue.run(() => syncGeekList(db, session)).catch((e) => log('geek_sync', e)), 300_000);
    });
  }

  // ---- 维护：WAL 合并 30min / 清理 6h / 备份 24h ----
  registerOnce('__ab_maint', () => {
    // 定期强制合并 WAL，防止高写入下自动 checkpoint 饿死导致磁盘被撑爆
    setInterval(() => queue.run(async () => checkpointWal(db)).catch((e) => log('checkpoint', e)), 30 * 60_000);
    setInterval(() => queue.run(async () => cleanupOldEvents(db, 30)).catch((e) => log('cleanup', e)), 6 * 3_600_000);
    setInterval(() => queue.run(async () => dailyBackup(db, cfg.dataDir)).catch((e) => log('backup', e)), 24 * 3_600_000);
  });
}

/** HA 短连 WS：auth → 逐条调用 → close（清单/房间同步用，不复用主订阅连接） */
async function withHaWs(fn: <T>(call: <T>(type: string, extra?: object) => Promise<T>) => Promise<void>): Promise<void> {
  const WebSocket = (await import('ws')).default;
  const { haUrl, haToken } = getConfig();
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${haUrl!.replace(/^http/, 'ws')}/api/websocket`);
    const pending = new Map<number, (v: any) => void>();
    let id = 0, ready = false;
    const call = <T,>(type: string, extra?: object): Promise<T> =>
      new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, type, ...extra })); });
    ws.on('message', async (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: haToken }));
      if (m.type === 'auth_ok') { ready = true; try { await fn(call); } finally { ws.close(); } return; }
      if (m.type === 'result' && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
    });
    ws.on('error', reject);
    ws.on('close', () => { if (!ready) reject(new Error('HA 短连提前关闭')); else resolve(); });
  });
}
