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

// 获取单个文档的完整内容（从数据库读，如果没有则实时拉取）
export async function getDocContent(docId: string): Promise<{ title: string; doc_type: string; url: string; content: string } | null> {
  const db = getDb()
  const row = db.prepare(`SELECT title, doc_type, url, content FROM feishu_docs WHERE doc_id = ?`).get(docId) as any
  if (!row) return null

  // 如果有内容直接返回
  if (row.content) return row

  // 没有内容，尝试实时拉取（支持 docx 和 sheet）
  if (['docx', 'sheet'].includes(row.doc_type)) {
    const token = (db.prepare(`SELECT value FROM settings WHERE key='feishu_user_access_token'`).get() as any)?.value
    if (token) {
      try {
        const { getDocContent: fetchContent } = await import('../feishu/docs')
        const content = await fetchContent(token, docId, row.doc_type)
        if (content) {
          db.prepare(`UPDATE feishu_docs SET content = ?, synced_at = datetime('now') WHERE doc_id = ?`).run(content, docId)
          return { ...row, content }
        }
      } catch {}
    }
  }

  return row
}
