// GET /api/context/[name] — 联系人上下文（从 summaries 表读取）
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { id } = await params
  const name = decodeURIComponent(id)
  const db = getDb()

  const contact = db.prepare(`
    SELECT name, last_contact_at,
      CASE WHEN last_contact_at IS NULL THEN 9999
        ELSE CAST((julianday('now') - julianday(last_contact_at)) AS INTEGER)
      END AS days_since
    FROM contacts WHERE name = ?
  `).get(name) as any

  if (!contact) {
    return NextResponse.json({ error: '联系人不存在' }, { status: 404 })
  }

  const summaryRow = db.prepare(
    `SELECT summary FROM chat_summaries WHERE chat_name = ? AND summary IS NOT NULL`
  ).get(name) as any

  return NextResponse.json({
    daysSinceContact: contact.days_since,
    summary: summaryRow?.summary || null,
  })
}
