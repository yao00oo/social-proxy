import { getDb } from '../db'

export interface NewMessage {
  id: number
  message_id: string
  contact_name: string
  incoming_content: string
  created_at: string
  is_at_me: boolean
  is_read: boolean
  suggestion: string | null
  recent_history: { direction: string; content: string; timestamp: string }[]
}

/**
 * 获取最近收到的消息 — 直接从 messages 表读，不依赖 reply_suggestions
 */
export function getNewMessages(userId?: string, minutes = 5, limit = 50): NewMessage[] {
  const db = getDb()
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'

  // 读取已读状态（reply_suggestions 表有标记的用它，没有的默认未读）
  const rows = db.prepare(`
    SELECT
      m.id,
      m.source_id as message_id,
      m.contact_name,
      m.content as incoming_content,
      m.timestamp as created_at,
      COALESCE(r.is_at_me, 0) as is_at_me,
      COALESCE(r.is_read, 0) as is_read,
      r.suggestion
    FROM messages m
    LEFT JOIN reply_suggestions r ON m.source_id = r.message_id
    WHERE m.timestamp > datetime('now', '-' || ? || ' minutes')
      AND m.direction = 'received'
      AND m.user_id = ?
    ORDER BY m.timestamp ASC
    LIMIT ?
  `).all(minutes, uid, limit) as any[]

  return rows.map(row => ({
    ...row,
    is_at_me: !!row.is_at_me,
    is_read: !!row.is_read,
    suggestion: row.suggestion || null,
    recent_history: db.prepare(`
      SELECT direction, content, timestamp FROM messages
      WHERE contact_name = ? AND user_id = ?
      ORDER BY timestamp DESC LIMIT 10
    `).all(row.contact_name, uid).reverse() as any[],
  }))
}

export function markMessagesRead(userId?: string, ids: number[] = []) {
  const db = getDb()
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'
  if (ids.length === 0) return
  // 标记 reply_suggestions（如果存在）
  db.prepare(`UPDATE reply_suggestions SET is_read = 1 WHERE id IN (${ids.map(() => '?').join(',')}) AND user_id = ?`).run(...ids, uid)
  // 也在 messages 表对应的 source_id 上做标记（通过 reply_suggestions 关联）
}
