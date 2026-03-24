import { getDb } from '../db'

export function getSummaries(search?: string) {
  const db = getDb()
  const where = search ? `WHERE chat_name LIKE '%' || ? || '%' OR summary LIKE '%' || ? || '%'` : ''
  const params = search ? [search, search] : []

  return db.prepare(`
    SELECT chat_name, start_time, end_time, message_count, summary
    FROM chat_summaries
    WHERE summary IS NOT NULL ${search ? 'AND (chat_name LIKE ? OR summary LIKE ?)' : ''}
    ORDER BY end_time DESC
  `).all(...(search ? [`%${search}%`, `%${search}%`] : [])) as any[]
}
