import fs from 'fs'; import path from 'path';
import type { DB } from '@/lib/db';

/** 滚动清理：events_raw 只留 N 天（30 天外 raw 永久报废——一期分组字段已入库，故二期不缺关键数据） */
export function cleanupOldEvents(db: DB, days = 30): number {
  const cutoff = Date.now() - days * 86_400_000;
  return db.prepare(`DELETE FROM events_raw WHERE ts < ?`).run(cutoff).changes;
}

/**
 * 强制 WAL checkpoint：把写前日志合并回主库并截断文件。
 * 背景：采集器写入频繁时，SQLite 自动 checkpoint 会一直抢不到写锁而"饿死"，
 * WAL 只增不减（实机曾涨到 25GB 撑爆磁盘，而主库仅 12MB）。必须定期强制合并。
 */
export function checkpointWal(db: DB): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/** 每日备份：VACUUM INTO 生成一致性快照，文件名含日期，保留最新 7 份滚动 */
export function dailyBackup(db: DB, dataDir: string, fixedName?: string): string {
  // 先合并 WAL 再备份：否则 VACUUM INTO 要扫描巨额 WAL，慢且占空间
  checkpointWal(db);
  const backupDir = path.join(dataDir, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const file = path.join(backupDir, fixedName ?? `auto-board-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  // 滚动保留：按名排序删最旧
  const all = fs.readdirSync(backupDir).filter((f) => /^auto-board-\d{8}\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - 7))) fs.rmSync(path.join(backupDir, f));
  return file;
}
