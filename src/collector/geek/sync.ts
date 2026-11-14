import crypto from 'crypto';
import type { DB } from '@/lib/db';
import { applyThrottle, insertEvents, markGap, type NewEvent } from '@/ingest/events';
import { parseGeekLogPage, type ParsedLine } from './logParser';
import { GeekSession } from './session';

const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

function recordRun(db: DB, source: string, job: string, startedAt: number,
  o: { status: string; watermark?: number; gapFrom?: number; gapTo?: number; detail?: string }) {
  db.prepare(`INSERT INTO sync_runs (source, job, status, started_at, finished_at, watermark, gap_from, gap_to, detail)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(source, job, o.status, startedAt, Date.now(), o.watermark ?? null,
      o.gapFrom ?? null, o.gapTo ?? null, o.detail ?? null);
}

/**
 * 清单 + cfg 存档 + 房间反推（5 min 一轮）：
 * - getGraphList → automations upsert（消失标 deleted_at，改名不断历史）
 * - name_index 全量重建（getLog 文本只有规则名）
 * - getDevList → kv 缓存（房间反推的依据）
 * - 每规则 getGraph：cfg hash 变化才写快照；room = 第一个设备节点的 roomName
 */
export async function syncGeekList(db: DB, s: GeekSession): Promise<void> {
  const started = Date.now();
  const list = await s.call<any[]>('getGraphList');
  const now = Date.now();
  const up = db.prepare(`INSERT INTO automations (source, key, name, room, enabled, first_seen, last_seen)
    VALUES ('geek', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, key) DO UPDATE SET name=excluded.name, enabled=excluded.enabled,
      last_seen=excluded.last_seen, deleted_at=NULL`);
  const markDeleted = db.prepare(`UPDATE automations SET deleted_at=? WHERE source='geek' AND key=?`);

  db.transaction(() => {
    const seen = new Set<string>();
    for (const r of list) {
      seen.add(r.id);
      up.run(r.id, r.name, null, r.enabled ? 1 : 0, now, now);
    }
    const active = db.prepare(`SELECT key FROM automations WHERE source='geek' AND deleted_at IS NULL`)
      .all() as { key: string }[];
    for (const row of active) {
      if (!seen.has(row.key)) markDeleted.run(now, row.key);
    }
    // 名称映射可能改名或复用，每轮以最新清单全量重建。
    db.prepare('DELETE FROM name_index').run();
    const ni = db.prepare('INSERT OR REPLACE INTO name_index VALUES (?,?,?)');
    for (const r of list) ni.run(r.name, r.id, now);
  })();

  // 设备清单缓存 + 房间反推 + cfg 快照（逐规则 getGraph，hash 变化才落快照）。
  const dev = await s.call<{ devList: Record<string, { name: string; roomName?: string }> }>('getDevList');
  db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run('geek_devlist', JSON.stringify(dev.devList));
  const snapshotRows = db.prepare(`SELECT key, hash FROM automation_snapshots WHERE source=? ORDER BY id`)
    .all('geek') as { key: string; hash: string }[];
  const lastHash = new Map(snapshotRows.map((r) => [r.key, r.hash]));
  const snap = db.prepare('INSERT INTO automation_snapshots (source, key, hash, cfg, captured_at) VALUES (?,?,?,?,?)');
  const setRoom = db.prepare('UPDATE automations SET room=? WHERE source=? AND key=?');
  for (const r of list) {
    const graph = await s.call<any>('getGraph', { id: r.id });
    const cfgText = JSON.stringify(graph);
    const hash = sha1(cfgText);
    if (hash !== lastHash.get(r.id)) snap.run('geek', r.id, hash, cfgText, now);
    // 找第一个能对上 devList 的设备节点，以其 roomName 反推规则房间。
    const room = (graph.nodes ?? []).find((n: any) => dev.devList[n.props?.did])?.props?.did;
    setRoom.run(room ? dev.devList[room].roomName ?? null : null, 'geek', r.id);
  }
  // 未映射行只回溯 events_raw.key；聚合不回填，避免重复计数。
  db.prepare(`UPDATE events_raw SET key = (SELECT geek_key FROM name_index WHERE name_index.name = events_raw.key)
    WHERE source='geek' AND key IN (SELECT name FROM name_index)`).run();
  recordRun(db, 'geek', 'sync_list', started, { status: 'ok', detail: `规则 ${list.length} 条` });
}

function getKv(db: DB, k: string): string | null {
  return (db.prepare('SELECT v FROM kv WHERE k=?').get(k) as { v: string } | undefined)?.v ?? null;
}

function setKv(db: DB, k: string, v: string): void {
  db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(k, v);
}

/**
 * getLog 采集（1 min 一轮）：
 * - 水位从 kv 读（首次 0 → 拉缓冲区现有全部，num=0 起向后翻页）
 * - 行 ts <= 水位跳过；整页无新行 → 停止翻页（两种页序语义下都收敛）
 * - 组装分组：[规则] 组头行锚定 group_id；无组头的接续行归入内存最近组
 * - dedup = key + 行时间 + 行内容 hash（页码/行号会漂移，绝不作键）
 * - 幂等/限流走 ingest；水位推进 = 本批新行 max ts
 * - gap 检测：本批最旧新行与水位差 > 10min → markGap
 */
export async function collectGeekLog(db: DB, s: GeekSession): Promise<void> {
  const started = Date.now();
  const watermark = Number(getKv(db, 'geek_watermark') || 0);
  const nameRows = db.prepare('SELECT name, geek_key FROM name_index').all() as { name: string; geek_key: string }[];
  const nameMap = new Map(nameRows.map((r) => [r.name, r.geek_key]));
  const events: NewEvent[] = [];
  let lastGroupId: string | null = null;
  let lastGroupKey: string | null = null;
  let groupLineNo = 0;
  let oldestNew = Infinity;
  let newest = watermark;

  for (let num = 0; num < 200; num++) {
    const text = await s.call<string>('getLog', { num });
    if (!text) break;
    const lines = parseGeekLogPage(text, num, watermark || undefined);
    const fresh = lines.filter((l): l is ParsedLine & { ts: number } => l.ts !== null && l.ts > watermark);
    for (const l of fresh) {
      if (l.isGroupStart) {
        const ruleName = ruleNameOf(l);
        const key = nameMap.get(ruleName) ?? ruleName;
        lastGroupKey = key;
        lastGroupId = `${key}|${l.ts}`;
        groupLineNo = 0;
        events.push(mkEv(key, l, num, groupLineNo, true, lastGroupId));
      } else if (lastGroupId && lastGroupKey) {
        // 明细行继承当前组头的规则 key，不能从设备名或动作名猜规则。
        groupLineNo += 1;
        events.push(mkEv(lastGroupKey, l, num, groupLineNo, false, lastGroupId));
      } else {
        // 重启首批可能从组中间开始：孤行保守保留，但不伪造分组与组内行号。
        const ruleName = ruleNameOf(l);
        const key = nameMap.get(ruleName) ?? ruleName;
        events.push(mkEv(key, l, num, null, false));
      }
      oldestNew = Math.min(oldestNew, l.ts);
      newest = Math.max(newest, l.ts);
    }
    if (fresh.length === 0) break;
  }

  const { events: safe } = applyThrottle(events);
  const { inserted } = insertEvents(db, safe);
  if (newest > watermark) setKv(db, 'geek_watermark', String(newest));
  if (Number.isFinite(oldestNew) && watermark > 0 && oldestNew - watermark > 10 * 60_000) {
    markGap(db, 'geek', watermark, oldestNew);
    recordRun(db, 'geek', 'geek_log', started, { status: 'gap', watermark, gapFrom: watermark, gapTo: oldestNew });
  } else {
    recordRun(db, 'geek', 'geek_log', started, { status: 'ok', watermark, detail: `新 ${inserted} 行` });
  }
}

function ruleNameOf(l: ParsedLine): string {
  const m = /规则启用:\s*(.+)$/.exec(l.name);
  return m ? m[1].trim() : l.name.split(/\s+/)[0];
}

function mkEv(key: string, l: ParsedLine & { ts: number }, page: number,
  lineNo: number | null, isHead: boolean, groupId: string | null = null): NewEvent {
  return {
    source: 'geek', key, ts: l.ts, kind: l.kind, name: l.name,
    dedupKey: `${key}|${l.ts}|${sha1(l.raw).slice(0, 16)}`,
    count: isHead,
    groupId, lineNo, page, raw: l.raw,
  };
}
