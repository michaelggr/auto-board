// env 解析：全部惰性、全部可选。HA/网关缺失时对应半边停采，不阻塞另一侧。
export interface Config {
  host: string;
  port: number;
  tz: string;
  haUrl?: string;
  haToken?: string;
  gatewayUrl?: string;
  autoCode: boolean;
  dbPath: string;
  dataDir: string;
}

export function getConfig(): Config {
  const dbPath = process.env.DB_PATH || './data/auto-board.db';
  return {
    host: process.env.HOST || '127.0.0.1',
    port: parseInt(process.env.PORT || '3423', 10),
    tz: process.env.TZ || 'Asia/Shanghai',
    haUrl: process.env.HA_URL || undefined,
    haToken: process.env.HA_TOKEN || undefined,
    gatewayUrl: process.env.GATEWAY_URL || undefined,
    autoCode: process.env.GATEWAY_AUTO_CODE === '1',
    dbPath,
    dataDir: dbPath.slice(0, dbPath.lastIndexOf('/')) || './data',
  };
}
