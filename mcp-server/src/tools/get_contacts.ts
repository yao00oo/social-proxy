// Tool: get_contacts — 获取联系人列表，按"最久未联系"排序
import { getDb } from '../db'

export interface ContactRow {
  name: string
  email: string | null
  last_contact_at: string | null
  message_count: number
  days_since_last_contact: number
}

export function getContacts(search?: string, limit = 50): ContactRow[] {
  const db = getDb()

  const where = search ? `WHERE name LIKE '%' || ? || '%'` : ''
  const params: any[] = search ? [search] : []

  const rows = db.prepare(`
    SELECT
      name,
      email,
      last_contact_at,
      message_count,
      CASE
        WHEN last_contact_at IS NULL THEN 9999
        ELSE CAST((julianday('now') - julianday(last_contact_at)) AS INTEGER)
      END AS days_since_last_contact
    FROM contacts
    ${where}
    ORDER BY days_since_last_contact DESC
    LIMIT ?
  `).all(...params, limit) as ContactRow[]

  return rows
}
