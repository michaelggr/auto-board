export interface ParsedLine {
  ts: number | null;          // null = 时间解析失败 → parse_error
  kind: 'rule' | 'device' | 'action' | 'other' | 'parse_error';
  name: string;                // 可读正文（展示用）
  graphKey?: string;           // v3 行自带规则 ID，优先用它直接入库
  isGroupStart: boolean;       // 规则启用行开启新分组（计数与 group_id 的锚点）
  raw: string;                 // 原始行全文（dedup 与展示用）
}

const LINK_VALUE: Record<string, string> = { true: '真', false: '伪', null: '事件' };

/** 网关日志时间戳可能是秒或毫秒；统一入库为毫秒，避免日期桶和水位比较错位。 */
function normalizeTs(value: string): number | null {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

/** 规则行 info 是 JSON，例如 {"enable":true}；解析失败按 parse_error 处理，不伪造启停状态。 */
function parseRuleEnable(info: string): boolean | null {
  try {
    const value = JSON.parse(info) as { enable?: unknown } | null;
    return typeof value?.enable === 'boolean' ? value.enable : null;
  } catch {
    return null;
  }
}

/**
 * 解析 getLog 一页文本。
 * 网关前端真实格式为 v3 管道行：3|时间戳|类型|规则ID|...
 * - r: 规则启停；仅 enable=true 作为分组起点并计 1 次
 * - i: 节点信息
 * - l: 节点连线
 * - e: 执行错误
 */
export function parseGeekLogPage(pageText: string, _page?: number, _watermarkMs?: number): ParsedLine[] {
  if (!pageText) return [];
  const out: ParsedLine[] = [];
  for (const raw of pageText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    out.push(parseV3Line(line));
  }
  return out;
}

function parseV3Line(line: string): ParsedLine {
  const parts = line.split('|');
  const [version, tsRaw, type, graphKey] = parts;
  const ts = version === '3' ? normalizeTs(tsRaw ?? '') : null;
  if (ts === null || !graphKey) {
    return { ts, kind: 'parse_error', name: '', isGroupStart: false, raw: line };
  }

  if (type === 'r') {
    const enabled = parseRuleEnable(parts[4] ?? '');
    if (enabled === null) {
      return { ts: null, kind: 'parse_error', name: '', graphKey, isGroupStart: false, raw: line };
    }
    return {
      ts,
      kind: 'rule',
      name: enabled ? '规则启用' : '规则停用',
      graphKey,
      isGroupStart: enabled,
      raw: line,
    };
  }
  if (type === 'i') {
    return {
      ts,
      kind: 'device',
      name: `节点 ${parts[4] ?? ''}: ${parts[5] ?? ''}`,
      graphKey,
      isGroupStart: false,
      raw: line,
    };
  }
  if (type === 'l') {
    const [, srcName] = (parts[4] ?? '').split('.');
    const [, dstName] = (parts[5] ?? '').split('.');
    const value = LINK_VALUE[parts[6] ?? ''] ?? parts[6] ?? '';
    return {
      ts,
      kind: 'action',
      name: `${srcName ?? parts[4] ?? ''} → ${dstName ?? parts[5] ?? ''}: ${value}`,
      graphKey,
      isGroupStart: false,
      raw: line,
    };
  }
  if (type === 'e') {
    return {
      ts,
      kind: 'other',
      name: `错误 ${parts[5] ?? ''}: ${parts[6] ?? ''}`,
      graphKey,
      isGroupStart: false,
      raw: line,
    };
  }
  return { ts, kind: 'other', name: line, graphKey, isGroupStart: false, raw: line };
}
