import WebSocket from 'ws';
import type { DB } from '@/lib/db';
import { getConfig } from '@/lib/config';
import { insertEvents, markGap, type NewEvent } from '@/ingest/events';
import crypto from 'crypto';

const { haUrl, haToken } = getConfig();

async function haFetch(path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(`${haUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!r.ok) throw new Error(`HA ${path} → ${r.status}`);
  return r.json();
}

/** logbook 条目 → 事件（过滤 automation.*；幂等键：context_id 优先，缺失退化 entity_id+时间） */
export function logbookToEvents(entries: any[]): NewEvent[] {
  return entries
    .filter((e) => String(e.entity_id || '').startsWith('automation.'))
    .map((e) => ({
      source: 'ha' as const, key: e.entity_id, name: e.name,
      ts: Date.parse(e.when), kind: 'trigger', count: true,
      dedupKey: e.context_id ? `${e.context_id}:${e.entity_id}` : `${e.entity_id}:${Date.parse(e.when)}`,
      raw: JSON.stringify(e),
    }))
    .filter((e) => !Number.isNaN(e.ts));
}

/** 水位衔接检测：logbook 最旧条目与水位空洞 > 10min → gap（recorder 保留期外/WS 长断线） */
export function detectLogbookGap(watermark: number, oldestEntryTs: number): { from: number; to: number } | null {
  if (watermark > 0 && oldestEntryTs - watermark > 10 * 60_000) return { from: watermark, to: oldestEntryTs };
  return null;
}

function getKv(db: DB, k: string): string | null {
  return (db.prepare('SELECT v FROM kv WHERE k=?').get(k) as { v: string } | undefined)?.v ?? null;
}
function setKv(db: DB, k: string, v: string): void { db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(k, v); }

/**
 * HA logbook 回溯（首启 + WS 断线补偿）。
 * 方向铁律：路径 = 水位（起点），end_time 省略默认到 now —— 千万不能写成 end_time=水位。
 */
export async function logbookBackfill(db: DB): Promise<{ inserted: number; skipped: number }> {
  const watermark = Number(getKv(db, 'ha_watermark') || 0);
  const startIso = new Date(watermark > 0 ? watermark : Date.now() - 10 * 86_400_000).toISOString();
  const entries = await haFetch(`/api/logbook/${startIso}`);
  const evs = logbookToEvents(entries);
  const r = insertEvents(db, evs);
  const maxTs = evs.reduce((m, e) => Math.max(m, e.ts), 0);
  if (maxTs > watermark) setKv(db, 'ha_watermark', String(maxTs));
  const oldest = evs.reduce((m, e) => Math.min(m, e.ts), Infinity);
  const gap = detectLogbookGap(watermark, oldest);
  if (gap) {
    markGap(db, 'ha', gap.from, gap.to);
    db.prepare(`INSERT INTO sync_runs (source, job, status, started_at, finished_at, watermark, gap_from, gap_to)
      VALUES ('ha','logbook','gap',?,?,?,?,?)`).run(Date.now(), Date.now(), watermark, gap.from, gap.to);
  }
  return r;
}

/** 清单 + 房间 + config 存档（5 min 一轮；房间链路按 Spike B 结论选择 WS/REST，此处按 WS 实现） */
export async function syncHaList(db: DB, wsCall: <T>(type: string, extra?: object) => Promise<T>): Promise<void> {
  const states = await haFetch('/api/states') as any[];
  const autos = states.filter((s) => s.entity_id.startsWith('automation.'));
  // 房间：WS config/entity_registry/list + config/area_registry/list
  const entities = await wsCall<any[]>('config/entity_registry/list');
  const areas = await wsCall<any[]>('config/area_registry/list');
  const areaName = new Map(areas.map((a) => [a.area_id, a.name] as const));
  const entityArea = new Map(entities.map((e) => [e.entity_id, e.area_id] as const));
  const now = Date.now();
  const up = db.prepare(`INSERT INTO automations (source, key, name, room, enabled, last_triggered, first_seen, last_seen)
    VALUES ('ha', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, key) DO UPDATE SET name=excluded.name, room=excluded.room,
      enabled=excluded.enabled, last_triggered=excluded.last_triggered, last_seen=excluded.last_seen, deleted_at=NULL`);
  db.transaction(() => {
    const seen = new Set<string>();
    for (const a of autos) {
      seen.add(a.entity_id);
      up.run(a.entity_id, a.attributes?.friendly_name ?? a.entity_id,
        areaName.get(entityArea.get(a.entity_id) ?? '') ?? null,
        a.state === 'on' ? 1 : 0,
        a.attributes?.last_triggered ? Date.parse(a.attributes.last_triggered) : null, now, now);
    }
    for (const row of db.prepare(`SELECT key FROM automations WHERE source='ha' AND deleted_at IS NULL`).all() as { key: string }[]) {
      if (!seen.has(row.key)) db.prepare(`UPDATE automations SET deleted_at=? WHERE source='ha' AND key=?`).run(now, row.key);
    }
  })();
}

/**
 * HA WS 客户端：订阅 automation_triggered（主通道，实时 0 延迟）。
 * 断线 → 指数退避重连 → 成功后 logbookBackfill 补 WS 断线期间的缺口。
 * 采集到的事件直接入库（WS 只在收到 auth_ok 后订阅，事件顺序天然递增）。
 */
export function startHaWs(db: DB, onEvent?: (inserted: number) => void): { stop(): void; isConnected(): boolean } {
  let ws: WebSocket | null = null;
  let alive = true;
  let connected = false;
  let backoff = 1_000;
  let msgId = 0;

  const connect = () => {
    if (!alive) return;
    ws = new WebSocket(`${haUrl!.replace(/^http/, 'ws')}/api/websocket`);
    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'auth_required') { ws!.send(JSON.stringify({ type: 'auth', access_token: haToken })); return; }
      if (msg.type === 'auth_ok') {
        connected = true; backoff = 1_000;
        ws!.send(JSON.stringify({ id: ++msgId, type: 'subscribe_events', event_type: 'automation_triggered' }));
        await logbookBackfill(db).catch(() => {});   // 连接即补缺口（幂等，重放安全）
        return;
      }
      if (msg.type === 'event') {
        const d = msg.event?.data;
        if (d?.entity_id?.startsWith('automation.')) {
          const ts = Date.parse(msg.time_fired ?? msg.event.time_fired);
          // 幂等键：context.id + entity_id（缺失退化 entity_id + ts）
          const dedupKey = d.context?.id ? `${d.context.id}:${d.entity_id}` : `${d.entity_id}:${ts}`;
          const { inserted } = insertEvents(db, [{
            source: 'ha', key: d.entity_id, name: d.name, ts, kind: 'trigger',
            dedupKey, count: true, raw: JSON.stringify(d),
          }]);
          if (inserted > 0) onEvent?.(inserted);
          if (ts > Number(getKv(db, 'ha_watermark') || 0)) setKv(db, 'ha_watermark', String(ts));
        }
      }
      if (msg.type === 'pong') lastPong = Date.now();
    });
    ws.on('close', () => { connected = false; if (alive) { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30_000); } });
    ws.on('error', () => { try { ws?.close(); } catch { /* 触发 close 走重连 */ } });
  };
  connect();

  // 30s ping 保活；60s 无 pong 强制断开走重连
  let lastPong = Date.now();
  const pinger = setInterval(() => {
    if (!connected) return;
    if (Date.now() - lastPong > 60_000) { try { ws?.close(); } catch {} return; }
    ws?.send(JSON.stringify({ id: ++msgId, type: 'ping' }));
  }, 30_000);

  return { stop() { alive = false; clearInterval(pinger); try { ws?.close(); } catch {} }, isConnected: () => connected };
}
