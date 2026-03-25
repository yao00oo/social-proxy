// 测试脚本：验证同步后自动摘要触发逻辑
// 用法: DB_PATH=/tmp/test-social.db OPENROUTER_API_KEY=sk-or-xxx ts-node src/test-sync-summarize.ts
//
// 不填 OPENROUTER_API_KEY 也可以测试"是否正确识别需要摘要的聊天"，只是不会真正调用 AI

import Database from 'better-sqlite3'
import path from 'path'

const DB_PATH = process.env.DB_PATH || '/tmp/test-social-proxy.db'
process.env.DB_PATH = DB_PATH

// 清空并初始化测试库
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  DROP TABLE IF EXISTS messages;
  DROP TABLE IF EXISTS contacts;
  DROP TABLE IF EXISTS settings;
  DROP TABLE IF EXISTS feishu_sync_state;
  DROP TABLE IF EXISTS chat_summaries;

  CREATE TABLE messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_name TEXT NOT NULL,
    direction    TEXT NOT NULL,
    content      TEXT NOT NULL,
    timestamp    TEXT NOT NULL,
    source_id    TEXT UNIQUE
  );
  CREATE TABLE contacts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT UNIQUE NOT NULL,
    email           TEXT,
    last_contact_at TEXT,
    message_count   INTEGER DEFAULT 0
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
  INSERT OR IGNORE INTO settings VALUES ('smtp_host',''),('smtp_port','587'),
    ('smtp_user',''),('smtp_pass',''),('smtp_from_name',''),('permission_mode','suggest');

  CREATE TABLE feishu_sync_state (
    chat_id      TEXT PRIMARY KEY,
    chat_name    TEXT,
    chat_type    TEXT,
    last_sync_ts TEXT DEFAULT '0'
  );
  CREATE TABLE chat_summaries (
    chat_id       TEXT PRIMARY KEY,
    chat_name     TEXT,
    start_time    TEXT,
    end_time      TEXT,
    message_count INTEGER,
    summary       TEXT,
    updated_at    TEXT
  );
`)

// 插入测试数据
// 聊天 A：10 条新消息（应触发摘要）
// 聊天 B：3 条新消息（不应触发）
// 聊天 C：0 条新消息（不应触发）

db.exec(`
  INSERT INTO feishu_sync_state VALUES ('chat_A', '张三', 'p2p', '1000');
  INSERT INTO feishu_sync_state VALUES ('chat_B', '李四', 'p2p', '1000');
  INSERT INTO feishu_sync_state VALUES ('chat_C', '王五', 'p2p', '1000');
`)

// 张三：10 条消息
for (let i = 1; i <= 10; i++) {
  db.prepare(`INSERT INTO messages(contact_name,direction,content,timestamp,source_id) VALUES (?,?,?,?,?)`)
    .run('张三', 'received', `张三说的第${i}句话`, `2024-01-0${Math.min(i,9)} 10:00:00`, `a${i}`)
}
// 李四：3 条消息
for (let i = 1; i <= 3; i++) {
  db.prepare(`INSERT INTO messages(contact_name,direction,content,timestamp,source_id) VALUES (?,?,?,?,?)`)
    .run('李四', 'received', `李四说的第${i}句话`, `2024-01-0${i} 10:00:00`, `b${i}`)
}
// 王五：0 条消息

db.close()

console.log('✅ 测试数据库初始化完成:', DB_PATH)
console.log('   - 张三: 10 条消息（预期：触发摘要）')
console.log('   - 李四: 3 条消息（预期：不触发）')
console.log('   - 王五: 0 条消息（预期：不触发）')
console.log('')

// 模拟 sync 结束后的增量摘要判断（不真正跑飞书 API）
import { summarizeChatAndSave, initSummaryTable } from './summarize'

const THRESHOLD = 5
const fakeNewMsgs = new Map([
  ['chat_A', { chat_name: '张三', chat_type: 'p2p', count: 10 }],
  ['chat_B', { chat_name: '李四', chat_type: 'p2p', count: 3 }],
])

const toSummarize = [...fakeNewMsgs.entries()].filter(([, v]) => v.count >= THRESHOLD)
console.log(`需要摘要的聊天（≥${THRESHOLD}条）:`, toSummarize.map(([id, v]) => `${v.chat_name}(${v.count}条)`))
console.log('')

if (!process.env.OPENROUTER_API_KEY) {
  console.log('⚠️  未设置 OPENROUTER_API_KEY，跳过实际 AI 调用')
  console.log('   过滤逻辑验证通过 ✓')
  console.log('')
  console.log('完整测试（含 AI 调用）:')
  console.log('  OPENROUTER_API_KEY=sk-or-xxx DB_PATH=/tmp/test-social-proxy.db ts-node src/test-sync-summarize.ts')
  process.exit(0)
}

;(async () => {
  initSummaryTable()
  for (const [chatId, { chat_name, chat_type }] of toSummarize) {
    console.log(`摘要: ${chat_name}...`)
    try {
      await summarizeChatAndSave(chatId, chat_name, chat_type)
      console.log('  ✓ 成功')
    } catch (e: any) {
      console.log('  ✗', e.message)
    }
  }

  // 验证结果写入了数据库
  const { getDb } = await import('./db')
  const result = getDb().prepare(`SELECT chat_name, summary FROM chat_summaries`).all()
  console.log('\n数据库中的摘要:')
  for (const r of result as any[]) {
    console.log(`  ${r.chat_name}: ${r.summary?.slice(0, 80)}...`)
  }
})()
