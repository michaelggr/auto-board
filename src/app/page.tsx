'use client';
import { useCallback, useEffect, useState } from 'react';
import { useStatus } from '@/components/Status';
import HeatmapChart from '@/components/HeatmapChart';
import type { RankRow, SourceSummary, HeatCell } from '@/lib/queries';

type Window = 'day' | 'week' | 'month';
const fmt = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';

export default function OverviewPage() {
  const { api } = useStatus();
  const [win, setWin] = useState<Window>('month');
  const [completeOnly, setCompleteOnly] = useState(false);
  const [ov, setOv] = useState<{ summaries: SourceSummary[]; rank: RankRow[] } | null>(null);
  const [heat, setHeat] = useState<HeatCell[]>([]);

  const load = useCallback(async () => {
    const r = await api(`/api/overview?window=${win}&complete_only=${completeOnly ? 1 : 0}`);
    if (r.ok) setOv(await r.json());
    const h = await api(`/api/heatmap?window=quarter`);
    if (h.ok) setHeat((await h.json()));
  }, [api, win, completeOnly]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);                    // 30s 自动刷新
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <h1>总览</h1>

      {/* 统计卡片：今日触发、窗口计数、同环比、活跃规则、断档 */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {(ov?.summaries ?? []).map((s) => {
          const delta = s.prevWindowCount > 0
            ? Math.round(((s.windowCount - s.prevWindowCount) / s.prevWindowCount) * 100)
            : null;
          return (
            <div key={s.source} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, minWidth: 220 }}>
              <h3>{s.source === 'ha' ? 'Home Assistant' : '米家极客版'}</h3>
              <p>今日触发 <b>{s.todayCount}</b></p>
              <p>窗口 {s.windowCount} 次
                {delta !== null && <span style={{ color: delta >= 0 ? 'green' : 'gray' }}>（环比 {delta >= 0 ? '+' : ''}{delta}%）</span>}
              </p>
              <p>活跃规则 {s.activeRules} / {s.totalRules}</p>
              {s.incompleteHours > 0 && <p style={{ color: 'darkorange' }}>断档 {s.incompleteHours} 小时</p>}
            </div>
          );
        })}
      </div>

      {/* 排行榜：窗口切换 + 仅完整时段开关（设计 §6.4） */}
      <h2 style={{ marginTop: 32 }}>
        排行榜
        {(['day', 'week', 'month'] as Window[]).map((w) => (
          <button key={w} onClick={() => setWin(w)}
            style={{ marginLeft: 8, fontWeight: win === w ? 'bold' : 'normal' }}>
            {{ day: '日', week: '周', month: '月' }[w]}
          </button>
        ))}
        <label style={{ marginLeft: 16, fontSize: 14 }}>
          <input type="checkbox" checked={completeOnly}
            onChange={(e) => setCompleteOnly(e.target.checked)} />
          仅统计完整时段（隐藏有断档的规则）
        </label>
      </h2>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            {['规则', '源', '今日', '窗口计数', '完整度', '最近触发', '状态'].map((h) => (
              <th key={h} style={{ border: '1px solid #ddd', padding: 6, textAlign: 'left' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(ov?.rank ?? []).map((r) => {
            const completeness = Math.round(((r.windowDays - r.incompleteDays) / r.windowDays) * 100);
            return (
              <tr key={`${r.source}|${r.key}`}>
                <td style={{ border: '1px solid #ddd', padding: 6 }}>{r.name}</td>
                <td style={{ border: '1px solid #ddd', padding: 6 }}>{r.source}</td>
                <td style={{ border: '1px solid #ddd', padding: 6 }}>{r.todayCount}</td>
                <td style={{ border: '1px solid #ddd', padding: 6 }}><b>{r.windowCount}</b></td>
                <td style={{ border: '1px solid #ddd', padding: 6 }}>
                  {completeness < 100
                    ? <span style={{ color: 'darkorange' }}>{complenessBar(completeness)}</span>
                    : '100%'}
                </td>
                <td style={{ border: '1px solid #ddd', padding: 6 }}>{fmt(r.lastTriggered)}</td>
                <td style={{ border: '1px solid #ddd', padding: 6 }}>
                  {r.enabled === 1 ? '启用' : r.enabled === 0 ? '停用' : '未知'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>触发热力图（近 90 天 · 周几 × 小时 · 灰点 = 断档未知）</h2>
      <HeatmapChart cells={heat} />
    </div>
  );
}

/** 完整度短条：百分比 + 迷你进度条文本 */
function complenessBar(pct: number): string {
  return `${pct}% ${'▮'.repeat(Math.round(pct / 10))}${'▯'.repeat(10 - Math.round(pct / 10))}`;
}
