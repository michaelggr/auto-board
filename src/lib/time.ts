import { getConfig } from '@/lib/config';

// 中国无夏令时，进程启动后算一次 TZ 偏移即可缓存（UTC+8 恒定）
let cachedOffsetMs: number | null = null;

/** 当前 TZ 相对 UTC 的偏移毫秒数（本地时间 = UTC + offset） */
export function tzOffsetMs(): number {
  if (cachedOffsetMs !== null) return cachedOffsetMs;
  const tz = getConfig().tz;
  const now = Date.now();
  // Intl 格式化只精确到秒，先去掉毫秒，否则偏移会带上不足 1 秒的残差
  const nowSec = now - (now % 1000);
  // 用 Intl 把"现在"按目标 TZ 格式化，再当作 UTC 解析，两者之差即偏移
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(nowSec));
  const m = s.match(/(\d+)-(\d+)-(\d+),?\s+(\d+):(\d+):(\d+)/);
  if (!m) throw new Error(`无法解析 TZ 时间: ${s}`);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] % 24, +m[5], +m[6]);
  cachedOffsetMs = asUtc - nowSec;
  return cachedOffsetMs;
}

/** UTC ms → 本地日期键 YYYY-MM-DD（禁止用 toISOString，那是 UTC 日期） */
export function localDateKey(ms: number): string {
  const d = new Date(ms + tzOffsetMs());
  return d.toISOString().slice(0, 10);
}

/** 本地 0 点对应的 UTC ms（"今日/本周"窗口的起点） */
export function localDayStart(ms: number): number {
  const day = localDateKey(ms);            // YYYY-MM-DD
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d) - tzOffsetMs();
}

/** UTC ms → 本地周几(0=周日..6=周六)与小时 */
export function localDowHour(ms: number): { dow: number; hour: number } {
  const d = new Date(ms + tzOffsetMs());
  return { dow: d.getUTCDay(), hour: d.getUTCHours() };
}

/** UTC ms → 小时桶（整点） */
export function hourBucket(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

const TS_FULL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const TS_NO_YEAR = /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/**
 * 解析极客版日志行时间（本地时间、无时区标记）：
 * - "YYYY-MM-DD HH:mm:ss" 直接按容器 TZ 构造
 * - "MM-DD HH:mm:ss" 年份 = 候选 {Y(水位), Y(水位)+1} 中与水位时间差绝对值更小者
 *   （跨 12/31 边界专用；日志行时间总在水位附近）
 * - 构造一律用 new Date(y,m-1,...)（按进程本地 TZ），严禁 ISO 字符串解析（会按 UTC）
 */
export function parseGeekTs(text: string, watermarkMs?: number): number | null {
  let m = TS_FULL.exec(text);
  if (m) return localDate(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  m = TS_NO_YEAR.exec(text);
  if (m && watermarkMs !== undefined) {
    const month = +m[1], day = +m[2];
    const wmLocalYear = new Date(watermarkMs + tzOffsetMs()).getUTCFullYear();
    // 两个候选年，取与水位差绝对值更小者
    const c1 = localDate(wmLocalYear, month, day, +m[3], +m[4], +m[5]);
    const c2 = localDate(wmLocalYear + 1, month, day, +m[3], +m[4], +m[5]);
    return Math.abs(c1 - watermarkMs) <= Math.abs(c2 - watermarkMs) ? c1 : c2;
  }
  return null;
}

/** 按进程本地时区构造 Date 并取 epoch ms */
function localDate(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}
