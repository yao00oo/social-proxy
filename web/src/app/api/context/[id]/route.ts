// GET /api/context/[name] — 联系人上下文（统一多平台模型）
import { NextRequest, NextResponse } from 'next/server'
import { queryOne } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { id } = await params
  const name = decodeURIComponent(id)

  const contact = await queryOne<any>(`
    SELECT name, last_contact_at,
      CASE WHEN last_contact_at IS NULL THEN 9999
        ELSE EXTRACT(DAY FROM NOW() - last_contact_at::timestamp)::integer
      END AS days_since
    FROM contacts WHERE name = ? AND user_id = ?
  `, [name, userId])

  if (!contact) {
    return NextResponse.json({ error: '联系人不存在' }, { status: 404 })
  }

  const summaryRow = await queryOne<{ summary: string }>(
    `SELECT s.summary
     FROM summaries s
     JOIN threads t ON s.thread_id = t.id AND t.user_id = ?
     WHERE t.name = ? AND s.user_id = ? AND s.summary IS NOT NULL`, [userId, name, userId]
  )

  return NextResponse.json({
    daysSinceContact: contact.days_since,
    summary: summaryRow?.summary || null,
  })
}
