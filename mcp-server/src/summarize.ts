// 批量生成会话摘要，存入 chat_summaries 表
// 运行: OPENROUTER_API_KEY=sk-or-xxx DB_PATH=... node -r ts-node/register/transpile-only src/summarize.ts

import OpenAI from 'openai'
import { getDb } from './db'

const MODEL = 'deepseek/deepseek-chat'

function getClient() {
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  })
}

export function initSummaryTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS chat_summaries (
      chat_id       TEXT PRIMARY KEY,
      chat_name     TEXT,
      start_time    TEXT,
      end_time      TEXT,
      message_count INTEGER,
      summary       TEXT,
      updated_at    TEXT
    )
  `)
}

function getChats() {
  const db = getDb()
  return db.prepare(`
    SELECT chat_id, chat_name, chat_type FROM feishu_sync_state
    WHERE last_sync_ts != '0'
  `).all() as { chat_id: string; chat_name: string; chat_type: string }[]
}

function getChatMessages(chatName: string, limit = 200) {
  const db = getDb()
  return db.prepare(`
    SELECT direction, content, timestamp FROM messages
    WHERE contact_name = ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(chatName, limit) as { direction: string; content: string; timestamp: string }[]
}

function getMessageStats(chatName: string) {
  const db = getDb()
  return db.prepare(`
    SELECT COUNT(*) as total, MIN(timestamp) as start_time, MAX(timestamp) as end_time
    FROM messages WHERE contact_name = ?
  `).get(chatName) as { total: number; start_time: string; end_time: string }
}

async function generateSummaryText(chatName: string, chatType: string): Promise<string> {
  const msgs = getChatMessages(chatName, 200)
  if (msgs.length === 0) return '无消息记录'

  const text = msgs.map(m =>
    `[${m.timestamp.slice(0, 10)} ${m.direction === 'sent' ? '我' : chatName}]: ${m.content.slice(0, 150)}`
  ).join('\n')

  const res = await getClient().chat.completions.create({
    model: MODEL,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `以下是${chatType === 'p2p' ? '与' + chatName + '的私聊' : '"' + chatName + '"群聊'}记录片段。
用3-4句话写摘要，包含：时间跨度、核心话题或事件、关系性质。语言简洁，不要废话。

${text}

摘要：`
    }]
  })

  return res.choices[0].message.content?.trim() ?? '生成失败'
}

// 对单个聊天生成摘要并保存，供同步后增量触发调用
export async function summarizeChatAndSave(chatId: string, chatName: string, chatType: string): Promise<void> {
  initSummaryTable()
  const db = getDb()
  const stats = getMessageStats(chatName)
  if (!stats || stats.total === 0) return

  const summary = await generateSummaryText(chatName, chatType)
  db.prepare(`
    INSERT INTO chat_summaries(chat_id, chat_name, start_time, end_time, message_count, summary, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      summary = excluded.summary,
      message_count = excluded.message_count,
      end_time = excluded.end_time,
      updated_at = excluded.updated_at
  `).run(chatId, chatName, stats.start_time, stats.end_time, stats.total, summary)
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('请设置 OPENROUTER_API_KEY 环境变量')
    process.exit(1)
  }

  initSummaryTable()
  const db = getDb()

  const chats = getChats()
  const done = new Set(
    (db.prepare(`SELECT chat_id FROM chat_summaries WHERE summary IS NOT NULL`).all() as any[])
      .map((r: any) => r.chat_id)
  )
  const todo = chats.filter(c => !done.has(c.chat_id))

  console.log(`共 ${chats.length} 个会话，已有摘要 ${done.size}，待处理 ${todo.length}`)

  let ok = 0, fail = 0
  for (let i = 0; i < todo.length; i++) {
    const chat = todo[i]
    const stats = getMessageStats(chat.chat_name)
    if (!stats || stats.total === 0) continue

    process.stdout.write(`  [${i + 1}/${todo.length}] ${chat.chat_name.slice(0, 20)} (${stats.total}条)... `)
    try {
      await summarizeChatAndSave(chat.chat_id, chat.chat_name, chat.chat_type)
      console.log('✓')
      ok++
    } catch (e: any) {
      console.log(`✗ ${e.message?.slice(0, 60)}`)
      fail++
    }

    // 限速：每10个暂停1秒
    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 1000))
  }

  console.log(`\n完成：成功 ${ok}，失败 ${fail}`)
}

main().catch(console.error)
