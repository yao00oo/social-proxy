// GET /api/contacts/[name] — 会话详情 + 聊天记录
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

  // Thread info (会话 = 群聊/私聊/通知群)
  const thread = await queryOne(`
    SELECT t.name, t.type, t.last_message_at as last_contact_at,
      COUNT(m.id)::int as message_count,
      CASE WHEN t.last_message_at IS NULL THEN 9999
        ELSE EXTRACT(DAY FROM NOW() - t.last_message_at::timestamp)::integer
      END AS days_since_last_contact
    FROM threads t
    LEFT JOIN messages m ON m.thread_id = t.id
    WHERE t.name = ? AND t.user_id = ?
    GROUP BY t.id, t.name, t.type, t.last_message_at
  `, [name, userId])

  if (!thread) {
    return NextResponse.json({ error: '会话不存在' }, { status: 404 })
  }

  // Total message count
  const totalRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) as n FROM messages m
     JOIN threads t ON m.thread_id = t.id
     WHERE t.name = ? AND t.user_id = ?`, [name, userId]
  )
  const total = totalRow?.n || 0

  // Recent messages (latest 50, ordered ascending)
  const messages = await query(`
    SELECT direction, content, timestamp, sender_name
    FROM (
      SELECT m.direction, m.content, m.timestamp, m.sender_name
      FROM messages m
      JOIN threads t ON m.thread_id = t.id
      WHERE t.name = ? AND t.user_id = ?
      ORDER BY m.timestamp DESC LIMIT ?
    ) sub ORDER BY timestamp ASC
  `, [name, userId, limit])

  // Summary if exists
  const summaryRow = await queryOne<{ summary: string; start_time: string; end_time: string }>(
    `SELECT s.summary, s.start_time, s.end_time
     FROM summaries s
     JOIN threads t ON s.thread_id = t.id
     WHERE t.name = ? AND t.user_id = ? AND s.summary IS NOT NULL`, [name, userId]
  )

  return NextResponse.json({
    contact: thread,
    total,
    messages,
    summary: summaryRow?.summary || null,
    summaryRange: summaryRow
      ? `${summaryRow.start_time?.slice(0, 10)} ~ ${summaryRow.end_time?.slice(0, 10)}`
      : null,
  })
}
