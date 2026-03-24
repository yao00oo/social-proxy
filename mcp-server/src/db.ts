// 数据库初始化 — SQLite via better-sqlite3
import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

// 数据库文件放在 mcp-server 目录下，方便 config-ui 共用
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../social-proxy.db')

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')

  initSchema(_db)
  return _db
}

function initSchema(db: Database.Database) {
  db.exec(`
    -- 聊天记录表
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_name TEXT NOT NULL,
      direction   TEXT NOT NULL CHECK(direction IN ('sent', 'received')),
      content     TEXT NOT NULL,
      timestamp   TEXT NOT NULL,
      source_id   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_contact  ON messages(contact_name);
    CREATE INDEX IF NOT EXISTS idx_messages_ts       ON messages(timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source ON messages(source_id) WHERE source_id IS NOT NULL;

    -- 联系人表
    CREATE TABLE IF NOT EXISTS contacts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT UNIQUE NOT NULL,
      email           TEXT,
      last_contact_at TEXT,
      message_count   INTEGER DEFAULT 0
    );

    -- 配置表 (key-value)
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    -- 预置默认配置项（不覆盖已有值）
    INSERT OR IGNORE INTO settings(key, value) VALUES
      ('smtp_host',        ''),
      ('smtp_port',        '587'),
      ('smtp_user',        ''),
      ('smtp_pass',        ''),
      ('smtp_from_name',   ''),
      ('permission_mode',  'suggest');
  `)
}

export function getDbPath(): string {
  return DB_PATH
}
