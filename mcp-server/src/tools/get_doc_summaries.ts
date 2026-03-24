import { getDb } from '../db'

export function getDocSummaries(search?: string) {
  const db = getDb()
  return db.prepare(`
    SELECT doc_id, title, doc_type, url, modified_time, summary
    FROM feishu_docs
    WHERE ${search ? "(title LIKE ? OR summary LIKE ? OR content LIKE ?)" : "1=1"}
    ORDER BY modified_time DESC
  `).all(...(search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [])) as any[]
}
