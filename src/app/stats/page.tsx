'use client';
import { useEffect, useState } from 'react';
import { useStatus } from '@/components/Status';
import type { Insights } from '@/lib/queries';

const fmt = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';
const th = { border: '1px solid #ddd', padding: 6, textAlign: 'left' as const };
const td = { border: '1px solid #ddd', padding: 6 };

export default function StatsPage() {
  const { api } = useStatus();
  const [ins, setIns] = useState<Insights | null>(null);
  useEffect(() => {
    (async () => { const r = await api('/api/insights'); if (r.ok) setIns(await r.json()); })();
  }, [api]);
  if (!ins) return <p>加载中…</p>;

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      <h1>统计</h1>

      {/* 健康分（简版，设计 §7） */}
      <h2>健康分</h2>
      <p>
        {ins.health.map((h) => (
          <span key={h.source} style={{ marginRight: 24 }}>
            {h.source === 'ha' ? 'Home Assistant' : '米家极客版'}：
            <b style={{ color: h.score >= 80 ? 'green' : h.score >= 50 ? 'darkorange' : 'crimson' }}>{h.score}</b>
          </span>
        ))}
      </p>

      {/* 覆盖率（窗口内有触发的规则占比） */}
      <h2>覆盖率（30 天）</h2>
      <p>
        {ins.coverage.map((c) => (
          <span key={c.source} style={{ marginRight: 24 }}>
            {c.source === 'ha' ? 'Home Assistant' : '米家极客版'}：{c.active}/{c.total}
            （{c.total ? Math.round((c.active / c.total) * 100) : 0}%）
          </span>
        ))}
      </p>

      {/* 僵尸 / 幽灵（设计 §6.4） */}
      <h2>僵尸规则（启用中且 30 天零触发）</h2>
      {ins.zombies.length === 0 ? <p>无</p> : (
        <table style={{ borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>源</th><th style={th}>规则</th><th style={th}>最近触发</th></tr></thead>
          <tbody>{ins.zombies.map((z) => (
            <tr key={`${z.source}|${z.key}`}>
              <td style={td}>{z.source}</td><td style={td}>{z.name}</td>
              <td style={td}>{z.lastTriggered ? fmt(z.lastTriggered) : '从未触发'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h2>幽灵规则（清单中已删除但历史仍在）</h2>
      {ins.ghosts.length === 0 ? <p>无</p> : (
        <table style={{ borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>源</th><th style={th}>规则</th><th style={th}>删除时间</th><th style={th}>最后触发</th></tr></thead>
          <tbody>{ins.ghosts.map((g) => (
            <tr key={`${g.source}|${g.key}`}>
              <td style={td}>{g.source}</td><td style={td}>{g.name}</td>
              <td style={td}>{fmt(g.deletedAt)}</td><td style={td}>{fmt(g.lastTriggered)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      {/* 抖动（简版：间隔中位数 < 60s） */}
      <h2>抖动嫌疑（最近触发间隔中位数 &lt; 60s）</h2>
      {ins.jitter.length === 0 ? <p>无</p> : (
        <table style={{ borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>源</th><th style={th}>规则</th><th style={th}>中位间隔</th><th style={th}>样本数</th></tr></thead>
          <tbody>{ins.jitter.map((j) => (
            <tr key={`${j.source}|${j.key}`}>
              <td style={td}>{j.source}</td><td style={td}>{j.name}</td>
              <td style={td}>{(j.medianGapMs / 1000).toFixed(1)}s</td><td style={td}>{j.recentCount}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      {/* 设备依赖度（基于极客版 cfg 快照解析） */}
      <h2>设备依赖度（极客版，Top 50）</h2>
      {ins.deviceDeps.length === 0 ? <p>无数据（需极客版清单同步）</p> : (
        <table style={{ borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>设备</th><th style={th}>被引用次数</th><th style={th}>引用规则</th></tr></thead>
          <tbody>{ins.deviceDeps.map((d) => (
            <tr key={d.did}>
              <td style={td}>{d.name}</td><td style={td}>{d.rules.length}</td>
              <td style={td}>{d.rules.join('、')}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      {/* 变更时间线（cfg hash 变化才落行） */}
      <h2>变更时间线</h2>
      {ins.changes.length === 0 ? <p>无变更记录</p> : (
        <table style={{ borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>时间</th><th style={th}>源</th><th style={th}>规则</th><th style={th}>配置指纹</th></tr></thead>
          <tbody>{ins.changes.map((c, i) => (
            <tr key={`${c.source}|${c.key}|${c.capturedAt}|${i}`}>
              <td style={td}>{fmt(c.capturedAt)}</td><td style={td}>{c.source}</td>
              <td style={td}>{c.name}</td><td style={td}><code>{c.hash.slice(0, 8)}</code></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
