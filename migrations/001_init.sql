-- 一期全部表。字段注释即设计文档 §5 的对应要点。
CREATE TABLE events_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,              -- 'ha' | 'geek'
  key TEXT NOT NULL,                 -- HA: entity_id；极客版: graph ID（未映射时暂存规则名）
  name TEXT,
  ts INTEGER NOT NULL,               -- UTC epoch ms
  kind TEXT NOT NULL,                -- rule|device|action|trigger|state|other|parse_error|throttled
  dedup_key TEXT NOT NULL,
  group_id TEXT,                     -- 极客版一次触发的分组 ID（组头行开启新组）
  line_no INTEGER,                   -- 组内行号
  page INTEGER,                      -- 来源页码（仅分组信息，绝不参与幂等键）
  raw TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(source, dedup_key)           -- 幂等门：无此约束排行榜必重复计数
);
CREATE INDEX idx_events_ts ON events_raw(ts);
CREATE INDEX idx_events_key_ts ON events_raw(source, key, ts);

CREATE TABLE agg_hourly (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,      -- UTC epoch ms 整点
  count INTEGER NOT NULL DEFAULT 0,
  incomplete INTEGER NOT NULL DEFAULT 0,  -- 1=该桶数据未知/断档（UI 灰纹）
  PRIMARY KEY (source, key, hour_bucket)
);

CREATE TABLE agg_daily (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  date TEXT NOT NULL,                -- 本地日期 YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  incomplete INTEGER NOT NULL DEFAULT 0,  -- 由覆盖 hourly 桶传染
  PRIMARY KEY (source, key, date)
);

CREATE TABLE automations (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  room TEXT,
  enabled INTEGER,                   -- 1 启用 0 停用 NULL 未知
  last_triggered INTEGER,            -- UTC epoch ms（HA 来自 states，极客版来自日志）
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  deleted_at INTEGER,               -- 清单中消失时置位（不删行，历史不断）
  PRIMARY KEY (source, key)
);
CREATE INDEX idx_auto_name ON automations(name);

CREATE TABLE automation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  hash TEXT NOT NULL,                -- cfg JSON 的 sha1，变更才写新行
  cfg TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
CREATE INDEX idx_snap_key ON automation_snapshots(source, key, captured_at);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,              -- 'ha' | 'geek' | 'maint'
  job TEXT NOT NULL,                 -- ws_event|logbook|geek_log|sync_list|cleanup|backup...
  status TEXT NOT NULL,              -- ok | fail | gap
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  watermark INTEGER,                 -- 本批增量起点（水位回放/单调性验证依据）
  gap_from INTEGER,
  gap_to INTEGER,
  detail TEXT
);

CREATE TABLE rule_pairs (
  ha_key TEXT NOT NULL,
  geek_key TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ha_key, geek_key)
);

CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL,              -- 'enable' | 'disable'
  prev_state INTEGER,                -- 前状态（撤回依据）
  result TEXT NOT NULL,              -- 'success' | 'fail'
  undone INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE name_index (            -- 极客版 规则名 → graph ID（getLog 文本只有名字）
  name TEXT PRIMARY KEY,
  geek_key TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE kv (                    -- 水位等单值状态
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
