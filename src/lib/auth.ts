import crypto from 'crypto';

const g = globalThis as { __abToken?: string };

/**
 * 启动时生成访问令牌并打进容器日志（用户复制到前端遮罩）。
 * BOARD_TOKEN 环境变量可固定（NAS 重启不换码）；否则每次启动随机。
 * 幂等：多次调用返回同一令牌。
 */
export function initToken(): string {
  if (!g.__abToken) {
    g.__abToken = process.env.BOARD_TOKEN || crypto.randomBytes(16).toString('hex');
    console.log('========================================');
    console.log(`[auto-board] 访问令牌: ${g.__abToken}`);
    console.log('（从容器日志复制，粘贴到网页遮罩；BOARD_TOKEN 可固定它）');
    console.log('========================================');
  }
  return g.__abToken;
}

/**
 * API 认证门。返回 null = 放行；返回 Response = 拒绝（route 直接 return 它）。
 * - X-Auth-Token 必须与令牌一致（否则 401）
 * - 带 Origin 的请求，其 host 必须与请求 Host 一致（否则 403，防局域网恶意页面跨站调用）
 */
export function requireAuth(req: Request): Response | null {
  const token = g.__abToken;
  if (!token) return Response.json({ error: 'token 未初始化' }, { status: 500 });
  if (req.headers.get('x-auth-token') !== token) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.get('host')) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
    } catch {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
  }
  return null;
}
