// 共用数据库写入工具 — 供各平台导入脚本复用
import Database from 'better-sqlite3'

/** 将 Date 对象转为本地时间字符串 "YYYY-MM-DD HH:mm:ss" */
export function toLocalTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g

export interface ParsedMessage {
  contactName: string    // 对方姓名
  direction: 'sent' | 'received'
  content: string
  timestamp: string      // "YYYY-MM-DD HH:MM:SS" 格式
}

/**
 * 批量写入消息和联系人，用事务包裹
 * @returns { imported, skipped }
 */
export function writeMessages(db: Database.Database, messages: ParsedMessage[]) {
  const insertMessage = db.prepare(`
    INSERT INTO messages(contact_name, direction, content, timestamp)
    VALUES (?, ?, ?, ?)
  `)

  const upsertContact = db.prepare(`
    INSERT INTO contacts(name, email, last_contact_at, message_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      message_count   = message_count + 1,
      last_contact_at = CASE
        WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at
        ELSE last_contact_at
      END,
      email = CASE
        WHEN email IS NULL OR email = '' THEN excluded.email
        ELSE email
      END
  `)

  let imported = 0
  let skipped = 0

  const run = db.transaction(() => {
    for (const msg of messages) {
      if (!msg.contactName || !msg.content || !msg.timestamp) {
        skipped++
        continue
      }

      const emails = msg.content.match(EMAIL_RE)
      const email = emails ? emails[0] : null

      insertMessage.run(msg.contactName, msg.direction, msg.content, msg.timestamp)
      upsertContact.run(msg.contactName, email, msg.timestamp)
      imported++
    }
  })

  run()
  return { imported, skipped }
}

/** 把各种日期格式统一为 "YYYY-MM-DD HH:MM:SS" */
export function normalizeTimestamp(raw: string): string {
  // 已经是标准格式
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return raw

  // 飞书斜线格式：2024/1/1 12:00:00 → 补零
  const slash = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{2}:\d{2}(?::\d{2})?)$/)
  if (slash) {
    const [, y, m, d, t] = slash
    const time = t.length === 5 ? `${t}:00` : t
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${time}`
  }

  // Unix 时间戳（毫秒）
  if (/^\d{13}$/.test(raw)) {
    return toLocalTime(new Date(parseInt(raw, 10)))
  }

  // Unix 时间戳（秒）
  if (/^\d{10}$/.test(raw)) {
    return toLocalTime(new Date(parseInt(raw, 10) * 1000))
  }

  // ISO 格式 fallback
  try {
    return toLocalTime(new Date(raw))
  } catch {
    return raw
  }
}
