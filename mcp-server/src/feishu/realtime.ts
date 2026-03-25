// 飞书实时消息同步 — 轮询 relay.botook.ai 获取新事件，存入本地 DB 并生成回复建议

import OpenAI from 'openai'
import { getDb } from '../db'
import { getSetting } from './auth'

const RELAY_URL = 'https://relay.botook.ai'
const CONSUMER = 'social-proxy'

function parseFeishuContent(msgType: string, rawContent: string | undefined): string {
  if (!rawContent) return '[空消息]'
  try {
    const body = JSON.parse(rawContent)
    switch (msgType) {
      case 'text': return body.text || '[空文本]'
      case 'post': {
        const lines: string[] = []
        const content = body.content || body.zh_cn?.content || []
        for (const line of content) {
          const parts = Array.isArray(line) ? line : [line]
          const text = parts.map((p: any) => {
            if (p.tag === 'text') return p.text
            if (p.tag === 'a') return p.text
            if (p.tag === 'at') return `@${p.user_name || p.user_id}`
            return ''
          }).join('')
          if (text) lines.push(text)
        }
        return lines.join('\n') || '[富文本]'
      }
      case 'image': return '[图片]'
      case 'file': return `[文件: ${body.file_name || ''}]`
      case 'audio': return '[语音]'
      case 'video': return '[视频]'
      case 'sticker': return '[表情包]'
      case 'interactive': return '[卡片消息]'
      default: return `[${msgType}]`
    }
  } catch {
    return rawContent.slice(0, 200)
  }
}

async function generateReplySuggestion(
  contactName: string,
  recentHistory: { direction: string; content: string }[],
  incomingMessage: string
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return ''

  const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey })

  const historyText = recentHistory.map(m =>
    `${m.direction === 'sent' ? '我' : contactName}: ${m.content}`
  ).join('\n')

  const prompt = `你是用户的助手，帮助判断飞书消息是否需要回复并提供建议。

联系人：${contactName}
最近对话（最新10条）：
${historyText || '（无历史记录）'}

${contactName}刚发来：${incomingMessage}

请简洁回答：
1. 是否需要回复（是/否）及一句话理由
2. 如需回复，给2-3个简短回复选项（每个不超过50字）

格式：
需要回复：[是/否] — [理由]
选项1：[...]
选项2：[...]`

  const res = await client.chat.completions.create({
    model: 'deepseek/deepseek-chat',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 300,
  })

  return res.choices[0].message.content || ''
}

export async function pollAndSync(): Promise<{ synced: number; suggestions: number }> {
  const db = getDb()
  const myOpenId = getSetting('feishu_user_id')  // feishu_user_id is stored as open_id

  let events: any[]
  try {
    const res = await fetch(`${RELAY_URL}/feishu/events?consumer=${CONSUMER}`)
    if (!res.ok) return { synced: 0, suggestions: 0 }
    events = await res.json()
  } catch {
    return { synced: 0, suggestions: 0 }
  }

  if (events.length === 0) return { synced: 0, suggestions: 0 }

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages(contact_name, direction, content, timestamp, source_id)
    VALUES (?, ?, ?, ?, ?)
  `)
  const upsertContact = db.prepare(`
    INSERT INTO contacts(name, email, last_contact_at, message_count)
    VALUES (?, NULL, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      message_count   = message_count + 1,
      last_contact_at = CASE
        WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at
        ELSE last_contact_at
      END
  `)
  const insertSuggestion = db.prepare(`
    INSERT OR IGNORE INTO reply_suggestions(message_id, contact_name, chat_id, incoming_content, suggestion, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  let synced = 0
  let suggestions = 0

  for (const event of events) {
    if (event.eventType !== 'im.message.receive_v1') continue

    const msg = event.payload?.event?.message
    const sender = event.payload?.event?.sender
    if (!msg) continue

    const chatId: string = msg.chat_id
    const messageId: string = msg.message_id
    const chatType: string = msg.chat_type  // 'p2p' | 'group'
    const senderOpenId: string = sender?.sender_id?.open_id || ''
    const isSelf = myOpenId && senderOpenId === myOpenId

    // Skip group messages (user can configure this later)
    if (chatType === 'group') continue

    const content = parseFeishuContent(msg.message_type, msg.content)
    const createTimeMs = parseInt(msg.create_time || String(event.ts))
    const ts = new Date(createTimeMs).toISOString().replace('T', ' ').slice(0, 19)

    // Look up contact name from sync state
    const stateRow = db.prepare(
      `SELECT chat_name FROM feishu_sync_state WHERE chat_id = ?`
    ).get(chatId) as any
    const contactName = stateRow?.chat_name || chatId

    const direction = isSelf ? 'sent' : 'received'

    const run = db.transaction(() => {
      insertMessage.run(contactName, direction, content, ts, messageId)
      if (!isSelf) upsertContact.run(contactName, ts)
    })
    run()
    synced++

    // Generate reply suggestion for received messages only
    if (!isSelf) {
      const history = db.prepare(`
        SELECT direction, content FROM messages
        WHERE contact_name = ?
        ORDER BY timestamp DESC LIMIT 10
      `).all(contactName) as { direction: string; content: string }[]

      try {
        const suggestion = await generateReplySuggestion(
          contactName,
          history.reverse(),
          content
        )
        insertSuggestion.run(messageId, contactName, chatId, content, suggestion || null, ts)
        if (suggestion) suggestions++
      } catch {
        insertSuggestion.run(messageId, contactName, chatId, content, null, ts)
      }
    }
  }

  return { synced, suggestions }
}

// ── 定时轮询管理 ───────────────────────────────────────

let _pollInterval: ReturnType<typeof setInterval> | null = null

export function startRealtimeSync(intervalMs = 30000) {
  if (_pollInterval) return
  _pollInterval = setInterval(async () => {
    try {
      const result = await pollAndSync()
      if (result.synced > 0) {
        console.error(`[实时同步] 新消息 ${result.synced} 条，回复建议 ${result.suggestions} 个`)
      }
    } catch (e: any) {
      console.error(`[实时同步] 出错: ${e.message}`)
    }
  }, intervalMs)
  console.error(`[实时同步] 已启动，每 ${intervalMs / 1000}s 轮询一次`)
}

export function stopRealtimeSync() {
  if (_pollInterval) {
    clearInterval(_pollInterval)
    _pollInterval = null
    console.error('[实时同步] 已停止')
  }
}

export function isRealtimeSyncing(): boolean {
  return _pollInterval !== null
}
