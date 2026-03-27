// GET /api/contacts/[name] — 联系人详情 + 聊天记录（移植自 MCP get_history）
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { id: contactName } = await params
  const name = decodeURIComponent(contactName)
  const limit = 50

  // Contact info
  const contact = await queryOne(`
    SELECT name, email, phone, feishu_open_id, last_contact_at, message_count,
      CASE WHEN last_contact_at IS NULL THEN 9999
        ELSE EXTRACT(DAY FROM NOW() - last_contact_at::timestamp)::integer
      END AS days_since_last_contact
    FROM contacts WHERE name = ?
  `, [name])

  if (!contact) {
    return NextResponse.json({ error: '联系人不存在' }, { status: 404 })
  }

  // Total message count
  const totalRow = await queryOne<{ n: number }>(
    'SELECT COUNT(*) as n FROM messages WHERE contact_name = ?', [name]
  )
  const total = totalRow?.n || 0

  // Recent messages
  const messages = await query(`
    SELECT direction, content, timestamp, sender_name
    FROM (
      SELECT direction, content, timestamp, sender_name FROM messages
      WHERE contact_name = ? ORDER BY timestamp DESC LIMIT ?
    ) sub ORDER BY timestamp ASC
  `, [name, limit])

  // Summary if exists
  const summaryRow = await queryOne<{ summary: string; start_time: string; end_time: string }>(
    `SELECT summary, start_time, end_time FROM chat_summaries
     WHERE chat_name = ? AND summary IS NOT NULL`, [name]
  )

  return NextResponse.json({
    contact,
    total,
    messages,
    summary: summaryRow?.summary || null,
    summaryRange: summaryRow
      ? `${summaryRow.start_time?.slice(0, 10)} ~ ${summaryRow.end_time?.slice(0, 10)}`
      : null,
  })
}
