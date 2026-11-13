import { describe, it, expect } from 'vitest';
import { tzOffsetMs, localDateKey, localDayStart, localDowHour, parseGeekTs } from '@/lib/time';

const H = 3600_000;
const UTC = Date.UTC;

describe('tzOffsetMs / localDateKey（TZ=Asia/Shanghai, UTC+8, 无夏令时）', () => {
  it('偏移为 +8h；本地日期键跨日正确', () => {
    expect(tzOffsetMs()).toBe(8 * H);
    // UTC 2026-11-04 16:00 = 本地 2026-11-05 00:00
    expect(localDateKey(UTC(2026, 10, 4, 16, 0, 0))).toBe('2026-11-05');
    // UTC 2026-11-04 15:59 仍属本地 11-04
    expect(localDateKey(UTC(2026, 10, 4, 15, 59, 0))).toBe('2026-11-04');
  });

  it('localDayStart 返回本地 0 点对应的 UTC 毫秒', () => {
    const anyLocalMorning = UTC(2026, 10, 5, 3, 0, 0); // 本地 11:00
    expect(localDayStart(anyLocalMorning)).toBe(UTC(2026, 10, 4, 16, 0, 0));
  });

  it('localDowHour 给出本地周几(0=周日)与小时', () => {
    // UTC 2026-11-04 16:30 = 本地 2026-11-05 00:30（周四）→ dow=4, hour=0
    expect(localDowHour(UTC(2026, 10, 4, 16, 30, 0))).toEqual({ dow: 4, hour: 0 });
  });
});

describe('parseGeekTs（极客版日志行时间，按容器 TZ 解析）', () => {
  it('含年份完整格式', () => {
    expect(parseGeekTs('2026-11-05 08:30:01')).toBe(UTC(2026, 10, 5, 0, 30, 1));
  });

  it('无年份 MM-DD 格式：年份=候选{Y(水位),Y+1}中距水位更近者', () => {
    // 跨年场景：水位 2026-12-31 23:00（本地），行 01-01 00:01 → 取 2027
    const wm = UTC(2026, 11, 31, 15, 0, 0); // 本地 2026-12-31 23:00
    expect(parseGeekTs('01-01 00:01:02', wm)).toBe(UTC(2026, 11, 31, 16, 1, 2));
    // 常规场景：水位 2026-11-05，行 11-04 22:00 → 取 2026（Y+1 差太远）
    const wm2 = UTC(2026, 10, 5, 2, 0, 0); // 本地 2026-11-05 10:00
    expect(parseGeekTs('11-04 22:00:00', wm2)).toBe(UTC(2026, 10, 4, 14, 0, 0));
  });

  it('不匹配返回 null（由调用方标 parse_error）', () => {
    expect(parseGeekTs('垃圾行')).toBeNull();
  });
});
