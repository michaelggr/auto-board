'use client';
import { useCallback, useEffect, useState } from 'react';
import { useStatus } from '@/components/Status';
import type { EventRow } from '@/lib/queries';

const fmt = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
const KIND_LABEL: Record<string, string> = {
  rule: '规则', device: '设备', action: '动作', trigger: '触发',
  state: '状态', other: '其他', parse_error: '解析失败', throttled: '已限流',
};

/** 单列事件行：极客版组内行（lineNo>0）缩进，raw 可点击展开 */
function EventItem({ e }: { e: EventRow }) {
  const [open, setOpen] = useState(false);
  const indent = e.source === 'geek' && e.line_no !== null && e.line_no > 0;
  return (
    <div style={{
      paddingLeft: indent ? 24 : 0,
      color: e.kind === 'parse_error' ? 'crimson' : e.kind === 'throttled' ? 'gray' : undefined,
      borderBottom: '1px solid #f0f0f0', padding: '4px 0',
    }}>
      <span style={{ color: '#888', fontSize: 12 }}>{fmt(e.ts)}</span>{' '}
      <span style={{ fontSize: 12 }}>[{e.source === 'ha' ? 'HA' : '极客'}]</span>{' '}
      <span style={{ fontSize: 12 }}>[{KIND_LABEL[e.kind] ?? e.kind}]</span>{' '}
      <b>{e.name ?? e.key}</b>{e.raw && <span> {e.raw.split('\n')[0]}</span>}
      {e.raw && e.raw.includes('\n') && (
        <button onClick={() => setOpen(!open)} style={{ marginLeft: 8, fontSize: 12 }}>
          {open ? '收起' : '展开'}
        </button>
      )}
      {open && <pre style={{ background: '#fafafa', padding: 8, whiteSpace: 'pre-wrap' }}>{e.raw}</pre>}
    </div>
  );
}

export default function LogsPage() {
  const { api } = useStatus();
  const [lane, setLane] = useState<'merged' | 'sideBySide'>('sideBySide');
  const [merged, setMerged] = useState<EventRow[]>([]);
  const [left, setLeft] = useState<EventRow[]>([]);
  const [right, setRight] = useState<EventRow[]>([]);
  const [q, setQ] = useState('');                 // 本地关键字过滤（前端过滤，无服务端搜索）
  const LIMIT = 200;

  const load = useCallback(async (append: boolean) => {
    const oldest = append
      ? Math.min(...[...(lane === 'merged' ? merged : [...left, ...right])].map((e) => e.ts))
      : Date.now();
    const p = new URLSearchParams({ limit: String(LIMIT), since: String(oldest) });
    if (lane === 'sideBySide') p.set('lane', 'sideBySide');
    const r = await api(`/api/events?${p}`);
    if (!r.ok) return;
    const body = await r.json();
    if (lane === 'sideBySide') {
      const dedup = (old: EventRow[], fresh: EventRow[]) =>
        [...fresh.filter((f) => !old.some((o) => o.id === f.id)), ...old];   // 幂等追加（按 id 去重）
      if (append) {
        setLeft((old) => dedup(old, body.left ?? []));
        setRight((old) => dedup(old, body.right ?? []));
      } else { setLeft(body.left ?? []); setRight(body.right ?? []); }
    } else if (append) {
      setMerged((old) => [...(body.rows ?? []).filter((f: EventRow) => !old.some((o) => o.id === f.id)), ...old]);
    } else {
      setMerged(body.rows ?? []);
    }
  }, [api, lane, merged, left, right]);

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(false), 10_000);       // 10s 拉新事件
    return () => clearInterval(t);
  }, [load]);

  const filter = (rows: EventRow[]) => rows.filter((e) =>
    !q || (e.name ?? '').includes(q) || (e.raw ?? '').includes(q) || e.key.includes(q));

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <h1>日志流水</h1>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <button onClick={() => setLane('merged')} style={{ fontWeight: lane === 'merged' ? 'bold' : 'normal' }}>单列合并</button>
        <button onClick={() => setLane('sideBySide')} style={{ fontWeight: lane === 'sideBySide' ? 'bold' : 'normal' }}>双泳道对照</button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="本地过滤（名称/内容）" style={{ padding: 6, width: 220 }} />
      </div>

      {lane === 'merged' ? (
        <>
          {filter(merged).map((e) => <EventItem key={e.id} e={e} />)}
          <button onClick={() => load(true)} style={{ margin: '12px 0' }}>加载更早</button>
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* 左 = 极客版，右 = HA（设计 §6.3：同一时间窗对齐、互相印证） */}
          <div>
            <h3>米家极客版</h3>
            {filter(left).map((e) => <EventItem key={e.id} e={e} />)}
            <button onClick={() => load(true)}>加载更早</button>
          </div>
          <div>
            <h3>Home Assistant</h3>
            {filter(right).map((e) => <EventItem key={e.id} e={e} />)}
            <button onClick={() => load(true)}>加载更早</button>
          </div>
        </div>
      )}
    </div>
  );
}
