import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import Database from 'better-sqlite3';
import { testDb, type DB } from '@/lib/db';
import { cleanupOldEvents, dailyBackup } from '@/ingest/maint';

let db: DB, dir: string;
beforeEach(() => {
  db = testDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-maint-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cleanupOldEvents', () => {
  it('只删 30 天前的 events_raw，聚合表不动', () => {
    db.prepare(`INSERT INTO events_raw (source, key, name, ts, kind, dedup_key, created_at)
      VALUES ('ha','a',NULL,?,?,?,?)`).run(Date.now() - 31 * 86_400_000, 'trigger', 'old', 0);
    db.prepare(`INSERT INTO events_raw (source, key, name, ts, kind, dedup_key, created_at)
      VALUES ('ha','a',NULL,?,?,?,?)`).run(Date.now() - 86_400_000, 'trigger', 'new', 0);
    const n = cleanupOldEvents(db, 30);
    expect(n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM events_raw').get() as any).c).toBe(1);
  });
});

describe('dailyBackup（VACUUM INTO，保留 7 份）', () => {
  it('生成可打开的备份文件，滚动保留 7 份', () => {
    // 用真实文件库（VACUUM INTO 对 :memory: 无意义）
    const dbPath = path.join(dir, 'main.db');
    const fdb = new Database(dbPath);
    fdb.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT); INSERT INTO kv VALUES (\'a\',\'b\');');
    for (let i = 0; i < 9; i++) {
      const stamp = new Date(Date.now() + i * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
      dailyBackup(fdb, dir, `auto-board-${stamp}.db`);
    }
    fdb.close();
    const backupDir = path.join(dir, 'backup');
    const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort();
    expect(files.length).toBe(7);                       // 滚动保留
    const restore = new Database(path.join(backupDir, files.at(-1)!));
    expect(restore.prepare('SELECT v FROM kv').get()).toEqual({ v: 'b' });  // 恢复可用（验收 8）
    restore.close();
  });
});
