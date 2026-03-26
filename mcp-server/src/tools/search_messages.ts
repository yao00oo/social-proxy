// Tool: search_messages — 按关键词搜索原始聊天记录
import { getDb } from '../db'

export interface SearchResult {
  contact_name: string
  direction: 'sent' | 'received'
  content: string
  timestamp: string
}

export function searchMessages(userId?: string, keyword?: string, contactName?: string, limit = 30): SearchResult[] {
  const db = getDb()
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'

  if (contactName) {
    return db.prepare(`
      SELECT contact_name, direction, content, timestamp
      FROM messages
      WHERE contact_name = ? AND content LIKE ? AND user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(contactName, `%${keyword}%`, uid, limit) as SearchResult[]
  }

  return db.prepare(`
    SELECT contact_name, direction, content, timestamp
    FROM messages
    WHERE content LIKE ? AND user_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(`%${keyword}%`, uid, limit) as SearchResult[]
}
