import { getDb } from '../db'

export function getDocSummaries(userId: string, search?: string) {
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'
  const db = getDb()
  return db.prepare(`
    SELECT doc_id, title, doc_type, url, modified_time, summary
    FROM feishu_docs
    WHERE user_id = ? ${search ? "AND (title LIKE ? OR summary LIKE ? OR content LIKE ?)" : ""}
    ORDER BY modified_time DESC
  `).all(uid, ...(search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [])) as any[]
}

// 获取单个文档的完整内容（从数据库读，如果没有则实时拉取）
export async function getDocContent(userId: string, docId: string): Promise<{ title: string; doc_type: string; url: string; content: string } | null> {
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'
  const db = getDb()
  const row = db.prepare(`SELECT title, doc_type, url, content FROM feishu_docs WHERE doc_id = ? AND user_id = ?`).get(docId, uid) as any
  if (!row) return null

  // 如果有内容直接返回
  if (row.content) return row

  // 没有内容，尝试实时拉取（支持 docx 和 sheet）
  if (['docx', 'sheet'].includes(row.doc_type)) {
    const token = (db.prepare(`SELECT value FROM settings WHERE key='feishu_user_access_token' AND user_id = ?`).get(uid) as any)?.value
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
