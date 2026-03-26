// Tool: get_history — 获取某联系人的聊天记录（摘要 + 最近 N 条原文）
import { getDb } from '../db'

export interface MessageRow {
  direction: 'sent' | 'received'
  content: string
  timestamp: string
}

export interface HistoryResult {
  total: number          // 该联系人消息总数
  summary?: string       // 历史摘要（当消息数超过 limit 时提供）
  summaryRange?: string  // 摘要覆盖的时间范围
  messages: MessageRow[] // 最近 limit 条原文
}

export function getHistory(userId?: string, contactName?: string, limit = 50): HistoryResult {
  const db = getDb()
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'

  const totalRow = db.prepare(
    `SELECT COUNT(*) as n FROM messages WHERE contact_name = ? AND user_id = ?`
  ).get(contactName, uid) as { n: number }
  const total = totalRow.n

  // 最近 limit 条原文，正序排列
  const messages = db.prepare(`
    SELECT direction, content, timestamp
    FROM (
      SELECT direction, content, timestamp
      FROM messages
      WHERE contact_name = ? AND user_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    )
    ORDER BY timestamp ASC
  `).all(contactName, uid, limit) as MessageRow[]

  // 消息总数超过 limit 时，附带历史摘要作为背景
  if (total > limit) {
    const summaryRow = db.prepare(
      `SELECT summary, start_time, end_time FROM chat_summaries
       WHERE chat_name = ? AND user_id = ? AND summary IS NOT NULL`
    ).get(contactName, uid) as { summary: string; start_time: string; end_time: string } | undefined

    return {
      total,
      summary: summaryRow?.summary,
      summaryRange: summaryRow
        ? `${summaryRow.start_time?.slice(0, 10)} ~ ${summaryRow.end_time?.slice(0, 10)}`
        : undefined,
      messages,
    }
  }

  return { total, messages }
}
