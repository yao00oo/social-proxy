// GET /api/messages/new — 获取最近新消息（统一多平台模型）
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const minutes = parseInt(req.nextUrl.searchParams.get('minutes') || '30')
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '50'), 200)

  const rows = await query<any>(`
    SELECT
      m.id,
      m.platform_msg_id as message_id,
      t.name as contact_name,
      m.content as incoming_content,
      m.timestamp as created_at,
      m.sender_name,
      COALESCE(m.is_read, 0) as is_read
    FROM messages m
    JOIN threads t ON m.thread_id = t.id AND t.user_id = ?
    WHERE m.timestamp::timestamp > NOW() - (? || ' minutes')::interval
      AND m.direction = 'received'
      AND m.user_id = ?
    ORDER BY m.timestamp DESC
    LIMIT ?
  `, [userId, minutes, userId, limit])

  const messages = rows.map(row => ({
    ...row,
    is_at_me: false,
    is_read: !!row.is_read,
  }))

  return NextResponse.json({ messages })
}
