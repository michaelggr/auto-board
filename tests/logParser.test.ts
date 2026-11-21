import { describe, it, expect } from 'vitest';
import { parseGeekLogPage } from '@/collector/geek/logParser';

// 真实网关前端 v3 日志行结构：3|时间戳|类型|规则ID|...
// 类型含义来自网关前端解析器：r=规则启停、i=节点信息、l=连线、e=错误。
const PAGE = [
  '3|1795000000000|r|1001|{"enable":true}',
  '3|1795000000001|i|1001|node-1|success',
  '3|1795000000002|l|1001|sensor.trigger|light.open|true',
  '3|1795000000003|e|1001|light|1|timeout',
  '3|1795000000004|r|1002|{"enable":false}',
  'bad-line',
].join('\n');

describe('parseGeekLogPage', () => {
  it('解析 v3 管道日志，并把规则启用行作为分组起点', () => {
    const lines = parseGeekLogPage(PAGE, 0);
    expect(lines.map((l) => [l.kind, l.isGroupStart, l.graphKey])).toEqual([
      ['rule', true, '1001'],
      ['device', false, '1001'],
      ['action', false, '1001'],
      ['other', false, '1001'],
      ['rule', false, '1002'],
      ['parse_error', false, undefined],
    ]);
    expect(lines[0].ts).toBe(1795000000000);
    expect(lines[0].name).toBe('规则启用');
    expect(lines[4].name).toBe('规则停用');
  });

  it('秒级时间戳归一化为毫秒，非法行返回 parse_error，空页返回 []', () => {
    const lines = parseGeekLogPage('3|1795000000|r|1001|{"enable":true}', 0);
    expect(lines[0].ts).toBe(1795000000000);
    expect(lines[0].graphKey).toBe('1001');
    expect(parseGeekLogPage('3|bad|r|1001|{}', 0)[0]).toMatchObject({ kind: 'parse_error', ts: null });
    expect(parseGeekLogPage('', 0)).toEqual([]);
  });
});
