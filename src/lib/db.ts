import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getConfig } from '@/lib/config';

export type DB = Database.Database;

/**
 * 顺序执行 migrations/NNN_*.sql：
 * - 文件名序号 <= user_version 的跳过（幂等，线上库只增量不重建）
 * - 每个迁移单事务（含 user_version 推进），失败整体回滚
 */
export function applyMigrations(db: DB, dir: string): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}

// globalThis 缓存：防 dev 热重载反复建连/重跑迁移
const g = globalThis as { __autoBoardDb?: DB };

export function getDb(): DB {
  if (!g.__autoBoardDb) {
    const { dbPath } = getConfig();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');     // 读写并发
    db.pragma('busy_timeout = 5000');    // 写锁等待上限 5s
    applyMigrations(db, path.join(process.cwd(), 'migrations'));
    g.__autoBoardDb = db;
  }
  return g.__autoBoardDb;
}

/** 测试专用：内存库 + 指定迁移目录 */
export function testDb(): DB {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  applyMigrations(db, path.join(process.cwd(), 'migrations'));
  return db;
}
