// GET /api/contacts — 联系人列表（统一多平台模型）
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const search = req.nextUrl.searchParams.get('search') || undefined
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50'), 200)

  const where = search ? `WHERE user_id = ? AND name LIKE '%' || ? || '%'` : 'WHERE user_id = ?'
  const params: any[] = search ? [userId, search] : [userId]

  const contacts = await query(`
    SELECT
      name, avatar, tags, last_contact_at, message_count,
      CASE
        WHEN last_contact_at IS NULL THEN 9999
        ELSE EXTRACT(DAY FROM NOW() - last_contact_at::timestamp)::integer
      END AS days_since_last_contact
    FROM contacts
    ${where}
    ORDER BY last_contact_at DESC
    LIMIT ?
  `, [...params, limit])

  const totalRow = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM contacts WHERE user_id = ?', [userId])
  const total = totalRow?.n || 0

  return NextResponse.json({ contacts, total })
}
