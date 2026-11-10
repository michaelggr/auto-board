import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 固定时区与关键 env，保证时间相关测试确定性
    env: {
      TZ: 'Asia/Shanghai',
      HA_URL: 'http://127.0.0.1:8123',
      HA_TOKEN: 'test-token',
      GATEWAY_URL: 'http://127.0.0.1:80',
      DB_PATH: './data-test/auto-board.db',
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
