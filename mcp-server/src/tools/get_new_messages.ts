import { getDb } from '../db'

export interface NewMessage {
  id: number
  message_id: string
  contact_name: string
  incoming_content: string
  created_at: string
  is_at_me: boolean
  is_read: boolean
  recent_history: { direction: string; content: string; timestamp: string }[]
}

/**
 * 获取最近的收到的消息
 * @param minutes 时间窗口（分钟），默认5分钟
 * @param limit 最大返回条数
 */
export function getNewMessages(minutes = 5, limit = 50): NewMessage[] {
  const db = getDb()

  const rows = db.prepare(`
    SELECT id, message_id, contact_name, incoming_content, created_at, is_at_me, is_read
    FROM reply_suggestions
    WHERE created_at > datetime('now', '-' || ? || ' minutes')
    ORDER BY created_at ASC
    LIMIT ?
  `).all(minutes, limit) as any[]

  return rows.map(row => ({
    ...row,
    is_at_me: !!row.is_at_me,
    is_read: !!row.is_read,
    recent_history: db.prepare(`
      SELECT direction, content, timestamp FROM messages
      WHERE contact_name = ?
      ORDER BY timestamp DESC LIMIT 10
    `).all(row.contact_name).reverse() as any[],
  }))
}

export function markMessagesRead(ids: number[]) {
  const db = getDb()
  if (ids.length === 0) return
  db.prepare(`UPDATE reply_suggestions SET is_read = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids)
}
