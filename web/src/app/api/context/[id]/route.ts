// GET /api/context/[name] — 联系人上下文（从 summaries 表读取）
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
    FROM contacts WHERE name = ?
  `, [name])

  if (!contact) {
    return NextResponse.json({ error: '联系人不存在' }, { status: 404 })
  }

  const summaryRow = await queryOne<{ summary: string }>(
    `SELECT summary FROM chat_summaries WHERE chat_name = ? AND summary IS NOT NULL`, [name]
  )

  return NextResponse.json({
    daysSinceContact: contact.days_since,
    summary: summaryRow?.summary || null,
  })
}
