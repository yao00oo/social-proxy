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
  migrate(_db)
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
      phone           TEXT,
      feishu_open_id  TEXT,
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
      ('permission_mode',  'suggest'),
      ('imap_host',        ''),
      ('imap_port',        '993'),
      ('imap_user',        ''),
      ('imap_pass',        '');

    -- 飞书用户名 → open_id 映射表（独立于会话，按发消息人建立）
    CREATE TABLE IF NOT EXISTS feishu_users (
      open_id  TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      email    TEXT,
      phone    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feishu_users_name ON feishu_users(name);

    -- 飞书云文档表
    CREATE TABLE IF NOT EXISTS feishu_docs (
      doc_id        TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      doc_type      TEXT,
      url           TEXT,
      created_time  TEXT,
      modified_time TEXT,
      content       TEXT,
      summary       TEXT,
      synced_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_feishu_docs_modified ON feishu_docs(modified_time);
    CREATE INDEX IF NOT EXISTS idx_feishu_docs_title ON feishu_docs(title);

    -- 实时消息回复建议表
    CREATE TABLE IF NOT EXISTS reply_suggestions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id       TEXT UNIQUE,
      contact_name     TEXT NOT NULL,
      chat_id          TEXT,
      incoming_content TEXT NOT NULL,
      suggestion       TEXT,
      created_at       TEXT NOT NULL,
      is_read          INTEGER DEFAULT 0,
      is_at_me         INTEGER DEFAULT 0
    );
  `)
}

function migrate(db: Database.Database) {
  // 给已有的 feishu_users 表加 email/phone 列
  const cols = db.prepare(`PRAGMA table_info(feishu_users)`).all() as { name: string }[]
  const colNames = cols.map(c => c.name)
  if (!colNames.includes('email')) db.exec(`ALTER TABLE feishu_users ADD COLUMN email TEXT`)
  if (!colNames.includes('phone')) db.exec(`ALTER TABLE feishu_users ADD COLUMN phone TEXT`)

  // 给已有的 contacts 表加 phone 列
  const contactCols = db.prepare(`PRAGMA table_info(contacts)`).all() as { name: string }[]
  if (!contactCols.map(c => c.name).includes('phone')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN phone TEXT`)
  }

  // 给 settings/messages/contacts/reply_suggestions 表加 user_id 列（多租户兼容）
  const DEFAULT_UID = process.env.DEFAULT_USER_ID || 'local'
  for (const table of ['settings', 'messages', 'contacts', 'reply_suggestions', 'feishu_users']) {
    const tCols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!tCols.map(c => c.name).includes('user_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT DEFAULT '${DEFAULT_UID}'`)
    }
  }
}

export function getDbPath(): string {
  return DB_PATH
}
