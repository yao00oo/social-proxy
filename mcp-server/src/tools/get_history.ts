// Tool: get_history — 获取某联系人的聊天记录
import { getDb } from '../db'

export interface MessageRow {
  direction: 'sent' | 'received'
  content: string
  timestamp: string
}

export function getHistory(contactName: string, limit = 30): MessageRow[] {
  const db = getDb()

  // 先取最近 limit 条，再按时间正序排（方便 agent 理解对话流）
  const rows = db.prepare(`
    SELECT direction, content, timestamp
    FROM (
      SELECT direction, content, timestamp
      FROM messages
      WHERE contact_name = ?
      ORDER BY timestamp DESC
      LIMIT ?
    )
    ORDER BY timestamp ASC
  `).all(contactName, limit) as MessageRow[]

  return rows
}
