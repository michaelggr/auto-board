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
