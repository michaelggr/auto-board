// Next 启动钩子：server 进程起来后启动采集器（唯一入口）
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;   // 只在 server 运行时启动，边缘/构建期跳过
  const [{ getDb }, { startCollector, registerOnce }, { initToken }] =
    await Promise.all([import('@/lib/db'), import('@/collector/scheduler'), import('@/lib/auth')]);
  initToken();   // 生成访问令牌并打进容器日志（写接口认证，见 Task 13）
  registerOnce('__ab_collector', () => startCollector(getDb()));
}
