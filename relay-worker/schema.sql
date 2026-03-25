-- Social Proxy Relay Worker — D1 数据库 schema

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feishu_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT UNIQUE,
  event_type TEXT,
  payload    TEXT NOT NULL,
  ts         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feishu_events_ts ON feishu_events(ts);

CREATE TABLE IF NOT EXISTS feishu_event_offsets (
  consumer TEXT PRIMARY KEY,
  last_id  INTEGER DEFAULT 0
);
