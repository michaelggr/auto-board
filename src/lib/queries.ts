import type { DB } from '@/lib/db';
import { localDateKey, localDayStart, localDowHour } from '@/lib/time';

// —— 总览（设计 §6.1/§7 一期：卡片 + 排行榜 + 完整度 + 同环比）——

export interface RankRow {
  source: string; key: string; name: string; room: string | null;
  enabled: number | null; todayCount: number; windowCount: number;
  lastTriggered: number | null; incompleteDays: number; windowDays: number;
}
export interface SourceSummary {
  source: string; todayCount: number; windowCount: number; prevWindowCount: number;
  activeRules: number; totalRules: number; incompleteHours: number; windowHours: number;
}

/** 窗口起点/终点（本地日历天）：windowDays 天，即 [今天-windowDays+1, 今天] */
function windowRange(windowDays: number): { fromDate: string; prevFrom: string } {
  const now = Date.now();
  const day = 86_400_000;
  // 对齐本地日界，避免 UTC 偏移把"天"切碎（三大铁律之一：本地日期键）
  const todayStart = localDayStart(now);
  return {
    fromDate: localDateKey(todayStart - (windowDays - 1) * day),
    prevFrom: localDateKey(todayStart - (2 * windowDays - 1) * day),
  };
}

export function getOverview(db: DB, windowDays = 30, completeOnly = false): {
  summaries: SourceSummary[]; rank: RankRow[]; windowDays: number;
} {
  const today = localDateKey(Date.now());
  const { fromDate, prevFrom } = windowRange(windowDays);

  // 排行榜：一次 JOIN 同时算今日/窗口计数与 incomplete 天数（比三条子查询快且一致）
  const rank = db.prepare(`
    SELECT a.source, a.key, a.name, a.room, a.enabled, a.last_triggered AS lastTriggered,
      COALESCE(SUM(CASE WHEN d.date = :today THEN d.count ELSE 0 END), 0)      AS todayCount,
      COALESCE(SUM(CASE WHEN d.date >= :fromDate THEN d.count ELSE 0 END), 0)  AS windowCount,
      COALESCE(SUM(CASE WHEN d.date >= :fromDate AND d.incomplete = 1 THEN 1 ELSE 0 END), 0) AS incompleteDays
    FROM automations a
    LEFT JOIN agg_daily d ON d.source = a.source AND d.key = a.key
    WHERE a.deleted_at IS NULL
    GROUP BY a.source, a.key, a.name, a.room, a.enabled, a.last_triggered
    ORDER BY windowCount DESC, todayCount DESC
  `).all({ today, fromDate }).map((r: any) => ({ ...r, windowDays })) as RankRow[];

  // 源卡片：本窗口/上一窗口总量 + 活跃规则 + 断档小时数
  const fromTs = localDayStart(Date.now() - (windowDays - 1) * 86_400_000);
  const windowHours = Math.max(1, Math.ceil((Date.now() - fromTs) / 3_600_000));
  const perSource = db.prepare(`
    SELECT a.source,
      COALESCE(SUM(CASE WHEN d.date = :today THEN d.count ELSE 0 END), 0)      AS todayCount,
      COALESCE(SUM(CASE WHEN d.date >= :fromDate THEN d.count ELSE 0 END), 0) AS windowCount,
      COALESCE(SUM(CASE WHEN d.date >= :prevFrom AND d.date < :fromDate THEN d.count ELSE 0 END), 0) AS prevWindowCount,
      COUNT(DISTINCT CASE WHEN d.date >= :fromDate AND d.count > 0 THEN a.key END) AS activeRules,
      COUNT(DISTINCT a.key) AS totalRules
    FROM automations a
    LEFT JOIN agg_daily d ON d.source = a.source AND d.key = a.key
    WHERE a.deleted_at IS NULL
    GROUP BY a.source
  `).all({ today, fromDate, prevFrom }) as SourceSummary[];
  for (const s of perSource) s.windowHours = windowHours;
  const inc = db.prepare(
    `SELECT source, COUNT(*) AS c FROM agg_hourly WHERE incomplete=1 AND hour_bucket>=? GROUP BY source`
  ).all(fromTs) as { source: string; c: number }[];
  for (const s of perSource) s.incompleteHours = inc.find((i) => i.source === s.source)?.c ?? 0;

  return {
    summaries: perSource,
    rank: completeOnly ? rank.filter((r) => r.incompleteDays === 0) : rank,
    windowDays,
  };
}

// —— 热力图（设计 §7 一期：规则 x 周几 x 小时，断档灰纹）——

export interface HeatCell { dow: number; hour: number; count: number; incomplete: number; }

/**
 * 周×小时网格。key 省略 = 全源合计。
 * SQLite 无时区概念：先按 hour_bucket 聚合（行数 ≤ 窗口小时数），再 JS 转本地 dow/hour。
 */
export function getHeatmap(db: DB, windowDays = 90, key?: string): HeatCell[] {
  const fromTs = localDayStart(Date.now() - (windowDays - 1) * 86_400_000);
  const sql = key
    ? `SELECT hour_bucket AS hb, SUM(count) AS c, MAX(incomplete) AS inc
       FROM agg_hourly WHERE hour_bucket >= ? AND key = ? GROUP BY hour_bucket`
    : `SELECT hour_bucket AS hb, SUM(count) AS c, MAX(incomplete) AS inc
       FROM agg_hourly WHERE hour_bucket >= ? GROUP BY hour_bucket`;
  const rows = (key ? db.prepare(sql).all(fromTs, key) : db.prepare(sql).all(fromTs)) as
    { hb: number; c: number; inc: number }[];
  const grid = new Map<string, HeatCell>();
  for (const r of rows) {
    const { dow, hour } = localDowHour(r.hb);
    const cell = grid.get(`${dow}-${hour}`) ?? { dow, hour, count: 0, incomplete: 0 };
    cell.count += r.c;
    if (r.inc) cell.incomplete = 1;
    grid.set(`${dow}-${hour}`, cell);
  }
  return [...grid.values()];
}

// —— 流水（设计 §10：/api/events）——

export interface EventFilter {
  lane?: 'merged' | 'sideBySide';
  since?: number;         // 上界（含）：默认 now。前端"加载更早"传列表最旧 ts
  to?: number;            // 下界（含）：双泳道时间窗对齐用
  limit?: number;         // 默认 200，硬上限 1000
  source?: string;        // merged 模式过滤；sideBySide 模式忽略
  key?: string;
}
export interface EventRow {
  id: number; source: string; key: string; name: string | null;
  ts: number; kind: string; group_id: string | null; line_no: number | null; raw: string | null;
}

export function getEvents(db: DB, f: EventFilter):
  { lane: string; rows?: EventRow[]; left?: EventRow[]; right?: EventRow[] } {
  const limit = Math.min(f.limit ?? 200, 1000);
  /** 生成单源/全源查询（extraSource 固定泳道源时，f.source 被忽略） */
  const query = (extraSource?: string) => {
    const conds: string[] = [];
    const args: Record<string, unknown> = { lim: limit };
    const src = extraSource ?? f.source;
    if (src) { conds.push('source = :source'); args.source = src; }
    if (f.key) { conds.push('key = :key'); args.key = f.key; }
    conds.push('ts <= :since'); args.since = f.since ?? Date.now();
    if (f.to !== undefined) { conds.push('ts >= :to'); args.to = f.to; }
    return db.prepare(`SELECT id, source, key, name, ts, kind, group_id, line_no, raw
      FROM events_raw ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
      ORDER BY ts DESC LIMIT :lim`).all(args) as EventRow[];
  };
  if (f.lane === 'sideBySide') {
    // 泳道固定 geek 左 / ha 右（同一时间窗对齐交给前端渲染，两侧各自取最近 limit 条）
    return { lane: 'sideBySide', left: query('geek'), right: query('ha') };
  }
  return { lane: 'merged', rows: query() };
}

// —— 洞察（设计 §7 一期）——

export interface Insights {
  zombies: { source: string; key: string; name: string; lastTriggered: number | null; firstSeen: number }[];
  ghosts: { source: string; key: string; name: string; deletedAt: number; lastTriggered: number | null }[];
  deviceDeps: { did: string; name: string; rules: string[] }[];
  coverage: { source: string; active: number; total: number }[];
  changes: { source: string; key: string; name: string; capturedAt: number; hash: string }[];
  health: { source: string; score: number }[];
  jitter: { source: string; key: string; name: string; medianGapMs: number; recentCount: number }[];
}

export function getInsights(db: DB, zombieDays = 30): Insights {
  const now = Date.now();
  const day = 86_400_000;
  const fromDate = localDateKey(now - 30 * day);         // 覆盖率/健康分统一 30 天窗口
  const fromTs = localDayStart(now - 29 * day);

  // 僵尸：启用中且 N 天零触发；从未触发的用 first_seen 兜底（新规则不算僵尸）
  const zombies = db.prepare(`
    SELECT source, key, name, last_triggered AS lastTriggered, first_seen AS firstSeen
    FROM automations
    WHERE deleted_at IS NULL AND enabled = 1
      AND COALESCE(last_triggered, first_seen) < ?`).all(now - zombieDays * day) as Insights['zombies'];

  // 幽灵：清单中已删除但历史仍在（deleted_at 有值，行不删）
  const ghosts = db.prepare(`
    SELECT source, key, name, deleted_at AS deletedAt, last_triggered AS lastTriggered
    FROM automations WHERE deleted_at IS NOT NULL
    ORDER BY deleted_at DESC LIMIT 100`).all() as Insights['ghosts'];

  // 设备依赖度：geek 最新快照解析节点 did → 被哪些规则引用（设备名来自 sync 缓存的 kv geek_devlist）
  const devRaw = (db.prepare(`SELECT v FROM kv WHERE k='geek_devlist'`).get() as { v: string } | undefined)?.v;
  const devList = devRaw ? (JSON.parse(devRaw) as Record<string, { name?: string }>) : {};
  const snaps = db.prepare(`
    SELECT s.key, a.name, s.cfg FROM automation_snapshots s
    JOIN automations a ON a.source = s.source AND a.key = s.key
    WHERE s.source = 'geek' AND a.deleted_at IS NULL
      AND s.captured_at = (SELECT MAX(captured_at) FROM automation_snapshots
                           WHERE source = 'geek' AND key = s.key)`).all() as { key: string; name: string; cfg: string }[];
  const deps = new Map<string, string[]>();
  for (const s of snaps) {
    try {
      const dids = [...new Set((JSON.parse(s.cfg).nodes ?? [])
        .map((n: any) => n.props?.did).filter(Boolean))] as string[];
      for (const did of dids) deps.set(did, [...(deps.get(did) ?? []), s.name]);
    } catch { /* 坏 cfg 跳过，洞察不因单条脏数据失败 */ }
  }
  const deviceDeps = [...deps.entries()]
    .sort((x, y) => y[1].length - x[1].length)
    .map(([did, rules]) => ({ did, name: devList[did]?.name ?? did, rules }))
    .slice(0, 50);

  // 覆盖率：窗口内有触发的规则 / 未删除规则（分源）
  const coverage = db.prepare(`
    SELECT a.source,
      COUNT(DISTINCT CASE WHEN d.count > 0 AND d.date >= :fromDate THEN a.key END) AS active,
      COUNT(DISTINCT a.key) AS total
    FROM automations a
    LEFT JOIN agg_daily d ON d.source = a.source AND d.key = a.key
    WHERE a.deleted_at IS NULL
    GROUP BY a.source`).all({ fromDate }) as Insights['coverage'];

  // 变更时间线：cfg 快照倒序 50 条（hash 变化才落行，见 Task 10）
  const changes = db.prepare(`
    SELECT s.source, s.key, a.name, s.captured_at AS capturedAt, s.hash
    FROM automation_snapshots s
    JOIN automations a ON a.source = s.source AND a.key = s.key
    ORDER BY s.captured_at DESC LIMIT 50`).all() as Insights['changes'];

  // 健康分（简版）：100 - 断档率×40 - 僵尸率×30 - 解析错误率×30
  const windowHours = Math.max(1, Math.ceil((now - fromTs) / 3_600_000));
  const health = (db.prepare(`SELECT DISTINCT source FROM automations`).all() as { source: string }[])
    .map(({ source }) => {
      const total = (db.prepare(`SELECT COUNT(*) c FROM automations WHERE source=? AND deleted_at IS NULL`).get(source) as any).c;
      const zombieN = zombies.filter((z) => z.source === source).length;
      const inc = (db.prepare(`SELECT COUNT(*) c FROM agg_hourly WHERE source=? AND incomplete=1 AND hour_bucket>=?`).get(source, fromTs) as any).c;
      const errN = (db.prepare(`SELECT COUNT(*) c FROM events_raw WHERE source=? AND kind='parse_error' AND ts>=?`).get(source, fromTs) as any).c;
      const evN = (db.prepare(`SELECT COUNT(*) c FROM events_raw WHERE source=? AND ts>=?`).get(source, fromTs) as any).c;
      const gapRatio = Math.min(inc / Math.max(1, total * windowHours), 1);
      const zombieRatio = total ? zombieN / total : 0;
      const errRatio = evN ? errN / evN : 0;
      return { source, score: Math.round(Math.max(0, 100 - gapRatio * 40 - zombieRatio * 30 - errRatio * 30)) };
    });

  // 抖动：每规则最近 100 次触发（kind 取 trigger/rule = 计数口径的行）的相邻间隔中位数 < 60s
  const ts = db.prepare(`
    SELECT source, key, ts FROM (
      SELECT source, key, ts,
             ROW_NUMBER() OVER (PARTITION BY source, key ORDER BY ts DESC) AS rn
      FROM events_raw WHERE kind IN ('trigger', 'rule')
    ) WHERE rn <= 100 ORDER BY source, key, ts`).all() as { source: string; key: string; ts: number }[];
  const byRule = new Map<string, { source: string; key: string; ts: number }[]>();
  for (const r of ts) byRule.set(`${r.source}|${r.key}`, [...(byRule.get(`${r.source}|${r.key}`) ?? []), r]);
  const nameOf = new Map(db.prepare(`SELECT source, key, name FROM automations`).all()
    .map((r: any) => [`${r.source}|${r.key}`, r.name as string]));
  const jitter: Insights['jitter'] = [];
  for (const rows of byRule.values()) {
    if (rows.length < 3) continue;                       // 样本太少不算
    const gaps = rows.slice(1).map((r, i) => r.ts - rows[i].ts).sort((a, b) => a - b);
    const medianGapMs = gaps[Math.floor(gaps.length / 2)];
    if (medianGapMs < 60_000) {
      jitter.push({
        source: rows[0].source, key: rows[0].key,
        name: nameOf.get(`${rows[0].source}|${rows[0].key}`) ?? rows[0].key,
        medianGapMs, recentCount: rows.length,
      });
    }
  }
  jitter.sort((a, b) => a.medianGapMs - b.medianGapMs);

  return { zombies, ghosts, deviceDeps, coverage, changes, health, jitter };
}
