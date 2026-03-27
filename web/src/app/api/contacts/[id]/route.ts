// GET /api/contacts/[name] — 联系人详情 + 聊天记录（统一多平台模型）
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
    SELECT name, avatar, tags, notes, last_contact_at, message_count,
      CASE WHEN last_contact_at IS NULL THEN 9999
        ELSE EXTRACT(DAY FROM NOW() - last_contact_at::timestamp)::integer
      END AS days_since_last_contact
    FROM contacts WHERE name = ? AND user_id = ?
  `, [name, userId])

  if (!contact) {
    return NextResponse.json({ error: '联系人不存在' }, { status: 404 })
  }

  // Total message count
  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) as n FROM messages m
     JOIN threads t ON m.thread_id = t.id
     WHERE t.name = ? AND t.user_id = ? AND m.user_id = ?`, [name, userId, userId]
  )
  const total = totalRow?.n || 0

  // Recent messages (latest 50, ordered ascending)
  const messages = await query(`
    SELECT direction, content, timestamp, sender_name
    FROM (
      SELECT m.direction, m.content, m.timestamp, m.sender_name
      FROM messages m
      JOIN threads t ON m.thread_id = t.id
      WHERE t.name = ? AND t.user_id = ? AND m.user_id = ?
      ORDER BY m.timestamp DESC LIMIT ?
    ) sub ORDER BY timestamp ASC
  `, [name, userId, userId, limit])

  // Summary if exists
  const summaryRow = await queryOne<{ summary: string; start_time: string; end_time: string }>(
    `SELECT s.summary, s.start_time, s.end_time
     FROM summaries s
     JOIN threads t ON s.thread_id = t.id
     WHERE t.name = ? AND t.user_id = ? AND s.user_id = ? AND s.summary IS NOT NULL`, [name, userId, userId]
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
