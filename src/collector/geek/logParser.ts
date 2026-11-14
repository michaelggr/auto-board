import { parseGeekTs } from '@/lib/time';

export interface ParsedLine {
  ts: number | null;          // null = 时间解析失败 → parse_error
  kind: 'rule' | 'device' | 'action' | 'other' | 'parse_error';
  name: string;                // 标签后的正文（规则名/设备+动作文本）
  isGroupStart: boolean;       // [规则] 行开启新分组（计数与 group_id 的锚点）
  raw: string;                 // 原始行全文（dedup 与展示用）
}

const KIND_MAP: Record<string, ParsedLine['kind']> = {
  '规则': 'rule', '设备': 'device', '动作': 'action',
};

// 行结构：<时间戳> [标签] 正文；时间戳可含/不含年份；Spike A 后按实际样本校准此正则
const LINE_RE = /^(\S+ \S+)?\s*\[([^\]]+)\]\s*(.*)$/;

/**
 * 解析 getLog 一页文本。
 * 时间解析失败 → kind='parse_error'（存 raw 不阻塞）；未知标签 → kind='other'。
 * watermark 仅用于无年份行的年份推断（设计：候选{Y,Y+1}取近者）。
 */
export function parseGeekLogPage(pageText: string, page: number, watermarkMs?: number): ParsedLine[] {
  if (!pageText) return [];
  const out: ParsedLine[] = [];
  for (const raw of pageText.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) {
      out.push({ ts: null, kind: 'parse_error', name: '', isGroupStart: false, raw: line });
      continue;
    }
    const ts = m[1] ? parseGeekTs(m[1], watermarkMs) : null;
    const kind = KIND_MAP[m[2]] ?? 'other';
    out.push({
      ts,
      kind: ts === null ? 'parse_error' : kind,
      name: m[3],
      isGroupStart: kind === 'rule',
      raw: line,
    });
  }
  return out;
}
