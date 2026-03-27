-- Migration: 统一多平台数据模型
-- 新增: channels, contact_identities, threads, documents, summaries
-- 改造: messages (加 thread_id, channel_id, metadata), contacts (加 tags, merged_into)
-- 保留: users, accounts, sessions, verification_tokens, settings, conversations, conversation_messages

-- ═══════════════════════════════════════════════════
-- 1. 新表
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS channels (
  id              SERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,  -- feishu|gmail|wechat|telegram|whatsapp|slack|discord|custom
  name            TEXT NOT NULL,
  enabled         INTEGER DEFAULT 1,
  credentials     JSONB DEFAULT '{}',
  sync_state      JSONB DEFAULT '{}',
  send_mode       TEXT DEFAULT 'suggest',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);
CREATE INDEX IF NOT EXISTS idx_channels_user_platform ON channels(user_id, platform);

CREATE TABLE IF NOT EXISTS contact_identities (
  id              SERIAL PRIMARY KEY,
  contact_id      INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  platform_uid    TEXT NOT NULL,
  display_name    TEXT,
  email           TEXT,
  phone           TEXT,
  metadata        JSONB DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_channel_uid ON contact_identities(channel_id, platform_uid);
CREATE INDEX IF NOT EXISTS idx_identity_contact ON contact_identities(contact_id);

CREATE TABLE IF NOT EXISTS threads (
  id                  SERIAL PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id          INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  platform_thread_id  TEXT NOT NULL,
  name                TEXT,
  type                TEXT DEFAULT 'dm',  -- dm|group|channel|email_thread
  participants        JSONB DEFAULT '[]',
  last_message_at     TEXT,
  last_sync_ts        TEXT DEFAULT '0',
  metadata            JSONB DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_channel_pid ON threads(channel_id, platform_thread_id);
CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id);
CREATE INDEX IF NOT EXISTS idx_threads_user_last ON threads(user_id, last_message_at);

CREATE TABLE IF NOT EXISTS documents (
  id              SERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  platform_doc_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  doc_type        TEXT,
  url             TEXT,
  content         TEXT,
  summary         TEXT,
  created_time    TEXT,
  modified_time   TEXT,
  synced_at       TIMESTAMPTZ DEFAULT NOW(),
  metadata        JSONB DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_channel_pid ON documents(channel_id, platform_doc_id);
CREATE INDEX IF NOT EXISTS idx_docs_user ON documents(user_id);

CREATE TABLE IF NOT EXISTS summaries (
  id              SERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id       INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  summary         TEXT,
  start_time      TEXT,
  end_time        TEXT,
  message_count   INTEGER,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_user_thread ON summaries(user_id, thread_id);

-- ═══════════════════════════════════════════════════
-- 2. 改造 contacts 表（加列，不删旧列）
-- ═══════════════════════════════════════════════════

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS merged_into INTEGER;

-- ═══════════════════════════════════════════════════
-- 3. 改造 messages 表（加列，不删旧列）
-- ═══════════════════════════════════════════════════

ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id INTEGER REFERENCES threads(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_identity_id INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS msg_type TEXT DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS platform_msg_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_messages_user_thread ON messages(user_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_ts ON messages(thread_id, timestamp);

-- ═══════════════════════════════════════════════════
-- 4. 数据迁移：飞书旧数据 → 新模型
--    （先创建 channel，再关联 thread/identity）
--    这部分需要用代码跑，SQL 只建结构
-- ═══════════════════════════════════════════════════

-- 迁移完成后可以考虑删除旧表（不急）：
-- DROP TABLE IF EXISTS feishu_users;
-- DROP TABLE IF EXISTS feishu_docs;
-- DROP TABLE IF EXISTS feishu_sync_state;
-- DROP TABLE IF EXISTS reply_suggestions;
-- DROP TABLE IF EXISTS chat_summaries;
-- DROP TABLE IF EXISTS email_sync_state;
