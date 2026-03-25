// GET  /api/feishu-realtime — 获取最近未读的实时消息和回复建议
// POST /api/feishu-realtime — 手动触发一次轮询
// PATCH /api/feishu-realtime — 标记消息已读

import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

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
      default: return `[${msgType}]`
    }
  } catch {
    return rawContent.slice(0, 200)
  }
}

// GET — 返回最近50条回复建议（含已读）
export async function GET() {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, message_id, contact_name, incoming_content, suggestion, created_at, is_read
    FROM reply_suggestions
    ORDER BY created_at DESC
    LIMIT 50
  `).all() as any[]

  const unread = db.prepare(`
    SELECT COUNT(*) as n FROM reply_suggestions WHERE is_read = 0
  `).get() as any

  return NextResponse.json({ suggestions: rows, unread: unread.n })
}

// POST — 手动触发一次 relay 轮询
export async function POST() {
  const db = getDb()
  const myOpenId = (db.prepare(`SELECT value FROM settings WHERE key='feishu_user_id'`).get() as any)?.value || ''
  const openrouterKey = process.env.OPENROUTER_API_KEY || ''

  let events: any[]
  try {
    const res = await fetch(`${RELAY_URL}/feishu/events?consumer=${CONSUMER}`)
    if (!res.ok) return NextResponse.json({ error: `Relay 请求失败: ${res.status}` }, { status: 500 })
    events = await res.json()
  } catch (e: any) {
    return NextResponse.json({ error: `无法连接 relay: ${e.message}` }, { status: 500 })
  }

  if (events.length === 0) return NextResponse.json({ synced: 0, suggestions: 0 })

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
    const chatType: string = msg.chat_type
    const senderOpenId: string = sender?.sender_id?.open_id || ''
    const isSelf = myOpenId && senderOpenId === myOpenId

    if (chatType === 'group') continue

    const content = parseFeishuContent(msg.message_type, msg.content)
    const createTimeMs = parseInt(msg.create_time || String(event.ts))
    const ts = new Date(createTimeMs).toISOString().replace('T', ' ').slice(0, 19)

    const stateRow = db.prepare(`SELECT chat_name FROM feishu_sync_state WHERE chat_id = ?`).get(chatId) as any
    const contactName = stateRow?.chat_name || chatId

    const direction = isSelf ? 'sent' : 'received'

    const run = db.transaction(() => {
      insertMessage.run(contactName, direction, content, ts, messageId)
      if (!isSelf) upsertContact.run(contactName, ts)
    })
    run()
    synced++

    if (!isSelf) {
      // Generate suggestion via OpenRouter if key available
      let suggestion: string | null = null
      if (openrouterKey) {
        try {
          const history = db.prepare(`
            SELECT direction, content FROM messages
            WHERE contact_name = ?
            ORDER BY timestamp DESC LIMIT 10
          `).all(contactName) as { direction: string; content: string }[]

          const historyText = history.reverse().map(m =>
            `${m.direction === 'sent' ? '我' : contactName}: ${m.content}`
          ).join('\n')

          const prompt = `你是用户的助手，帮助判断飞书消息是否需要回复并提供建议。

联系人：${contactName}
最近对话：
${historyText || '（无历史记录）'}

${contactName}刚发来：${content}

简洁回答：
1. 是否需要回复（是/否）及一句话理由
2. 如需回复，给2-3个简短回复选项（每个不超过50字）

格式：
需要回复：[是/否] — [理由]
选项1：[...]
选项2：[...]`

          const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openrouterKey}`,
            },
            body: JSON.stringify({
              model: 'deepseek/deepseek-chat',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 300,
            }),
          })
          if (aiRes.ok) {
            const aiData = await aiRes.json()
            suggestion = aiData.choices?.[0]?.message?.content || null
            if (suggestion) suggestions++
          }
        } catch {}
      }

      insertSuggestion.run(messageId, contactName, chatId, content, suggestion, ts)
    }
  }

  return NextResponse.json({ synced, suggestions })
}

// PATCH — 标记全部已读
export async function PATCH() {
  const db = getDb()
  db.prepare(`UPDATE reply_suggestions SET is_read = 1 WHERE is_read = 0`).run()
  return NextResponse.json({ ok: true })
}
