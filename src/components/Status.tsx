'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import Link from 'next/link';

// —— 与 /api/health 响应对齐（Task 13）——
export interface Health {
  ok: boolean;
  geek: { status: 'disconnected' | 'connecting' | 'connected'; lastError: string | null };
  ha: { connected: boolean };
  gapBuckets24h: Record<string, number>;
  time: number;
}

interface StatusCtx {
  health: Health | null;
  token: string | null;
  setToken: (t: string | null) => void;
  /** 统一带 token 的 fetch：401 时自动清 token 弹遮罩 */
  api: (path: string, init?: RequestInit) => Promise<Response>;
}
const Ctx = createContext<StatusCtx>(null as unknown as StatusCtx);

export function StatusProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [ready, setReady] = useState(false);   // localStorage 恢复完成前不渲染（防遮罩闪烁）
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {                            // token 持久化在 localStorage（SSR 下只能延后读）
    setTokenState(localStorage.getItem('ab_token'));
    setReady(true);
  }, []);

  const setToken = useCallback((t: string | null) => {
    if (t) localStorage.setItem('ab_token', t); else localStorage.removeItem('ab_token');
    setTokenState(t);
  }, []);

  // 状态灯数据：health 免认证，10s 轮询
  useEffect(() => {
    const tick = async () => {
      try { const r = await fetch('/api/health'); if (r.ok) setHealth(await r.json()); } catch { /* 网络抖动忽略 */ }
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, []);

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-auth-token': token ?? '', ...(init?.headers ?? {}) },
    });
    if (res.status === 401) setToken(null);     // 令牌失效 → 全局弹遮罩
    return res;
  }, [token, setToken]);

  return <Ctx.Provider value={{ health, token, setToken, api }}>{ready && children}</Ctx.Provider>;
}

export const useStatus = () => useContext(Ctx);

/** 令牌遮罩：未验证/失效时全屏拦截；保存前先用候选 token 试打一个只读接口验证 */
export function TokenGate({ children }: { children: React.ReactNode }) {
  const { token, setToken } = useStatus();
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  if (token) return <>{children}</>;
  const save = async () => {
    const res = await fetch('/api/overview?window=day', { headers: { 'x-auth-token': code } });
    if (res.ok) setToken(code); else setErr('令牌无效，请检查容器日志');
  };
  return (
    <div style={{ margin: '10% auto', maxWidth: 360, fontFamily: 'sans-serif' }}>
      <h2>auto-board 访问令牌</h2>
      <p>从容器日志复制令牌：<code>docker logs auto-board</code></p>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="访问令牌" style={{ width: '100%', padding: 8 }} />
      <button onClick={save} style={{ marginTop: 12, padding: '8px 16px' }}>进入看板</button>
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </div>
  );
}

export function Nav() {
  const links = [['/', '总览'], ['/automations', '自动化'], ['/logs', '日志'], ['/stats', '统计']] as const;
  return (
    <nav style={{ display: 'flex', gap: 16, padding: '12px 24px', borderBottom: '1px solid #ddd' }}>
      {links.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
    </nav>
  );
}

/** 黄条（设计 §6.3/§8）：断线/断档可见性。输码入口内嵌于此。 */
export function StatusBanner() {
  const { health } = useStatus();
  const [showCode, setShowCode] = useState(false);
  if (!health) return null;
  const geekDown = health.geek.status !== 'connected';
  const haDown = !health.ha.connected;
  const gapHa = health.gapBuckets24h?.ha ?? 0;
  const gapGeek = health.gapBuckets24h?.geek ?? 0;
  if (!geekDown && !haDown && gapHa + gapGeek === 0) return null;
  return (
    <div style={{ background: '#fffbe6', borderBottom: '1px solid #ffe58f', padding: '10px 24px', fontFamily: 'sans-serif' }}>
      {geekDown && (
        <p>
          警告：极客版会话未连接（{health.geek.lastError ?? '尚未输码'}）
          <button onClick={() => setShowCode(!showCode)} style={{ marginLeft: 8 }}>
            {showCode ? '收起' : '输登录码'}
          </button>
        </p>
      )}
      {showCode && <GatewayConnectForm onDone={() => setShowCode(false)} />}
      {haDown && <p>警告：HA WebSocket 未连接（断线期间显示陈旧数据，重连自动恢复）</p>}
      {(gapHa + gapGeek > 0) && (
        <p>警告：过去 24h 有断档小时（HA {gapHa} / 极客版 {gapGeek}），受影响格子已标灰纹</p>
      )}
    </div>
  );
}

/** 输码对话框：POST /api/gateway/connect（登录码严格一次性，见速查） */
function GatewayConnectForm({ onDone }: { onDone: () => void }) {
  const { api } = useStatus();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const submit = async () => {
    const res = await api('/api/gateway/connect', { method: 'POST', body: JSON.stringify({ code }) });
    if (res.ok) onDone();
    else setMsg((await res.json()).error ?? '连接失败');
  };
  return (
    <p>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="网关 6 位登录码"
        inputMode="numeric" maxLength={6} style={{ padding: 6 }} />
      <button onClick={submit} style={{ marginLeft: 8 }}>连接</button>
      {msg && <span style={{ color: 'crimson' }}> {msg}</span>}
    </p>
  );
}
