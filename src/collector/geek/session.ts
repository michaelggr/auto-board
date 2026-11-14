import { GatewayClient } from '@/lib/gateway/client';

// 抽最小接口便于测试注入（真实实现即 GatewayClient，结构兼容）
export interface GatewayLike {
  connect(url: string): Promise<void>;
  authenticate(code: string): Promise<void>;
  callApi<T = unknown>(method: string, params?: Record<string, unknown>, timeout?: number): Promise<T>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export type SessionEvent = 'connected' | 'disconnected';
export type SessionStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * 网关会话：登录码严格一次性 → 每次建连都要新码（人工），
 * 所以策略是"持久会话 + 60–90s 轻量心跳 + 断线降级"而非自动重连。
 * 心跳用 getVarList（getGraphList 全量太重）。
 */
export class GeekSession {
  status: SessionStatus = 'disconnected';
  lastError?: string;
  connectedAt?: number;
  client: GatewayLike | null = null;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private makeClient: () => GatewayLike,
    private url: string,
    private onEvent: (e: SessionEvent) => void,
  ) {}

  /** 输码建连（唯一人工干预点）。失败保留错误信息供前端展示。 */
  async connect(code: string): Promise<void> {
    this.status = 'connecting';
    const c = this.makeClient();
    try {
      await c.connect(this.url);
      await c.authenticate(code);
    } catch (err) {
      this.lastError = String(err);
      this.status = 'disconnected';
      try { await c.close(); } catch { /* 忽略关闭异常 */ }
      throw err;
    }
    this.client = c;
    this.status = 'connected';
    this.connectedAt = Date.now();
    this.lastError = undefined;
    this.startHeartbeat();
    this.onEvent('connected');
  }

  /** 会话内 API 调用：断线后所有采集任务都会在入口抛错并被调度层吞掉 */
  call<T>(method: string, params?: Record<string, unknown>, timeout?: number): Promise<T> {
    if (this.status !== 'connected' || !this.client) throw new Error('极客版会话未建立');
    return this.client.callApi<T>(method, params, timeout);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(async () => {
      try {
        if (!this.client?.isConnected()) throw new Error('WS 已断开');
        await this.client.callApi('getVarList', { scope: 'global' });
      } catch (err) {
        this.lastError = String(err);
        await this.close();               // 降级：停采 + 等人工输码
        this.onEvent('disconnected');
      }
    }, 75_000);
  }

  private stopHeartbeat(): void { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; } }

  async close(): Promise<void> {
    this.stopHeartbeat();
    this.status = 'disconnected';
    try { await this.client?.close(); } catch { /* 忽略 */ }
  }
}

// ---- 全局单例（globalThis 防 dev 热重载重建）----
const g = globalThis as { __geekSession?: GeekSession };

export function getGeekSession(onEvent?: (e: SessionEvent) => void): GeekSession {
  if (!g.__geekSession) {
    const { getConfig } = require('@/lib/config') as typeof import('@/lib/config');
    const { gatewayUrl } = getConfig();
    g.__geekSession = new GeekSession(
      () => new GatewayClient() as unknown as GatewayLike,
      gatewayUrl || 'http://127.0.0.1',
      (e) => { if (onEvent) onEvent(e); },
    );
  }
  return g.__geekSession;
}
