import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { applyMigrations } from '@/lib/db';

// 每个用例独立的临时迁移目录 + 内存库，互不污染
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mig-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// 迁移执行器要求：按文件名序号顺序执行、每个迁移单事务、user_version 跳过已执行（幂等）
describe('applyMigrations', () => {
  it('顺序执行并推进 user_version，重复调用不重复执行', () => {
    fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE t1(id INTEGER);');
    fs.writeFileSync(path.join(dir, '002_b.sql'), 'CREATE TABLE t2(id INTEGER);');
    const db = new Database(':memory:');
    applyMigrations(db, dir);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 't%'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(['t1', 't2']);
    // 再加一个迁移文件，只有它会被执行（增量，线上库禁止重建的前提）
    fs.writeFileSync(path.join(dir, '003_c.sql'), 'CREATE TABLE t3(id INTEGER);');
    applyMigrations(db, dir);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    db.close();
  });

  it('迁移中途失败则整体回滚（单事务保证）', () => {
    fs.writeFileSync(path.join(dir, '001_ok.sql'), 'CREATE TABLE t1(id INTEGER);');
    fs.writeFileSync(path.join(dir, '002_bad.sql'), 'CREATE TABLE t2(id INTEGER); INSERT INTO no_such_table VALUES (1);');
    const db = new Database(':memory:');
    expect(() => applyMigrations(db, dir)).toThrow();
    // 002 失败：user_version 停在 1，且 t2 未残留（事务回滚）
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='t2'").get()).toEqual({ c: 0 });
    db.close();
  });
});
