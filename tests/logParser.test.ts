import { describe, it, expect } from 'vitest';
import { parseGeekLogPage } from '@/collector/geek/logParser';

const PAGE = [
  '2026-11-05 08:00:00 [规则] 规则启用: 回家自动开灯',
  '2026-11-05 08:00:01 [设备] 人体传感器 触发',
  '2026-11-05 08:00:01 [动作] 筒灯 打开',
  '2026-11-05 08:05:00 [规则] 规则启用: 定时关灯',
  '2026-11-05 08:05:00 [动作] 走廊灯 关闭',
  '一行没有时间戳的垃圾文本',
].join('\n');

describe('parseGeekLogPage', () => {
  it('三分类识别 + 组头行标记 + kind 映射', () => {
    const lines = parseGeekLogPage(PAGE, 0);
    expect(lines).toHaveLength(6);
    // [规则] 行 = 组头；[设备]/[动作] 跟随；坏行标 parse_error 但不丢弃
    expect(lines.map((l) => [l.kind, l.isGroupStart])).toEqual([
      ['rule', true], ['device', false], ['action', false],
      ['rule', true], ['action', false], ['parse_error', false],
    ]);
    expect(lines[0].ts).toBe(Date.UTC(2026, 10, 5, 0, 0, 0)); // 本地 08:00 = UTC 00:00
    expect(lines[0].name).toBe('规则启用: 回家自动开灯');
    expect(lines[5].raw).toBe('一行没有时间戳的垃圾文本');
  });

  it('无年份行用水位推断年份；未知标签归 other；空页返回 []', () => {
    const wm = Date.UTC(2026, 10, 5, 2, 0, 0); // 本地 2026-11-05 10:00
    const lines = parseGeekLogPage('11-05 09:00:00 [变量] 某未知分类', 0, wm);
    expect(lines[0].ts).toBe(Date.UTC(2026, 10, 5, 1, 0, 0));
    expect(lines[0].kind).toBe('other');
    expect(parseGeekLogPage('', 0, wm)).toEqual([]);
  });
});
