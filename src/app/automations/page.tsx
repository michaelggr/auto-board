'use client';
import { useCallback, useEffect, useState } from 'react';
import { useStatus } from '@/components/Status';

/** 与 /api/automations 响应对齐（Task 15 route） */
interface AutoRow {
  source: string; key: string; name: string; room: string | null;
  enabled: number | null; lastTriggered: number | null; firstSeen: number;
  paired: 0 | 1;
  lastActionId: number | null; lastAction: string | null;
  lastActionResult: string | null;
  lastActionUndone: number | null; lastActionAt: number | null;
}

const fmt = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';

export default function AutomationsPage() {
  const { api } = useStatus();
  const [rows, setRows] = useState<AutoRow[]>([]);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (source) p.set('source', source);
    if (status) p.set('status', status);
    if (q) p.set('q', q);
    const r = await api(`/api/automations?${p}`);
    if (r.ok) setRows((await r.json()).rows);
  }, [api, source, status, q]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  /** 启停：409 → confirm 展示对侧并带 confirmPair 重发；其余错误显示行内消息 */
  const toggle = async (row: AutoRow, enable: boolean) => {
    const send = (confirmPair: boolean) =>
      api('/api/automations/toggle', {
        method: 'POST',
        body: JSON.stringify({ source: row.source, key: row.key, enable, confirmPair }),
      });
    let r = await send(false);
    if (r.status === 409) {
      const { pair } = await r.json();
      const stateText = pair.enabled === 1 ? '仍启用' : '已停用';
      if (!window.confirm(
        `检测到配对规则「${pair.name}」（${pair.source === 'ha' ? 'HA' : '极客版'}）${stateText}。\n` +
        `${enable ? '启用' : '停用'}本规则可能造成双系统并跑或漏跑，确认继续？`)) {
        return;
      }
      r = await send(true);                     // 二次确认后重发
    }
    const body = await r.json().catch(() => ({}));
    setMsg(r.ok ? `「${row.name}」已${enable ? '启用' : '停用'}` : `操作失败：${body.error ?? r.status}`);
    load();                                     // 立即刷新（不等 30s 轮询）
  };

  const undo = async (actionId: number) => {
    const r = await api('/api/automations/undo', {
      method: 'POST', body: JSON.stringify({ actionId }),
    });
    const body = await r.json().catch(() => ({}));
    setMsg(r.ok ? '已撤回' : `撤回失败：${body.error ?? r.status}`);
    load();
  };

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <h1>自动化</h1>

      {/* 筛选区（设计 §6.2：来源/房间/状态筛选；僵尸单独筛出） */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">全部来源</option><option value="ha">Home Assistant</option><option value="geek">极客版</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="enabled">启用</option>
          <option value="disabled">已停用</option>
          <option value="zombie">僵尸</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索规则名" style={{ padding: 6, width: 200 }} />
      </div>

      {msg && <p style={{ background: '#f0f0f0', padding: 8 }}>{msg}</p>}

      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            {['规则', '源', '房间', '最近触发', '最近操作', '状态 / 启停'].map((h) => (
              <th key={h} style={{ border: '1px solid #ddd', padding: 6, textAlign: 'left' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.source}|${r.key}`}>
              <td style={{ border: '1px solid #ddd', padding: 6 }}>
                {r.name}
                {r.paired === 1 && <span title="存在配对规则（rule_pairs）" style={{ marginLeft: 6, color: 'darkorange' }}>⧉</span>}
              </td>
              <td style={{ border: '1px solid #ddd', padding: 6 }}>{r.source}</td>
              <td style={{ border: '1px solid #ddd', padding: 6 }}>{r.room ?? '—'}</td>
              <td style={{ border: '1px solid #ddd', padding: 6 }}>{fmt(r.lastTriggered)}</td>
              <td style={{ border: '1px solid #ddd', padding: 6 }}>
                {r.lastActionId !== null && (
                  <span>
                    {r.lastAction === 'enable' ? '启用' : '停用'} @ {fmt(r.lastActionAt)}
                    {r.lastActionUndone === 0 && r.lastActionResult === 'success' && (
                      <button onClick={() => undo(r.lastActionId!)} style={{ marginLeft: 8 }}>撤回</button>
                    )}
                  </span>
                )}
              </td>
              <td style={{ border: '1px solid #ddd', padding: 6 }}>
                {r.enabled === 1
                  ? <><span style={{ color: 'green' }}>启用</span>
                      <button onClick={() => toggle(r, false)} style={{ marginLeft: 8 }}>停用</button></>
                  : r.enabled === 0
                    ? <><span style={{ color: 'gray' }}>停用</span>
                        <button onClick={() => toggle(r, true)} style={{ marginLeft: 8 }}>启用</button></>
                    : <span style={{ color: 'gray' }}>未知（等清单同步）</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
