// GET /api/contacts — 联系人列表（移植自 MCP get_contacts）
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const search = req.nextUrl.searchParams.get('search') || undefined
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50'), 200)

  const db = getDb()
  const where = search ? `WHERE name LIKE '%' || ? || '%'` : ''
  const params: any[] = search ? [search] : []

  const contacts = db.prepare(`
    SELECT
      name, email, phone, feishu_open_id, last_contact_at, message_count,
      CASE
        WHEN last_contact_at IS NULL THEN 9999
        ELSE CAST((julianday('now') - julianday(last_contact_at)) AS INTEGER)
      END AS days_since_last_contact
    FROM contacts
    ${where}
    ORDER BY last_contact_at DESC
    LIMIT ?
  `).all(...params, limit)

  const total = (db.prepare('SELECT COUNT(*) as n FROM contacts').get() as any).n

  return NextResponse.json({ contacts, total })
}
