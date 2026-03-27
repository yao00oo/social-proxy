// GET /api/messages/new — 获取最近新消息（移植自 MCP get_new_messages）
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
      m.source_id as message_id,
      m.contact_name,
      m.content as incoming_content,
      m.timestamp as created_at,
      COALESCE(r.is_at_me, 0) as is_at_me,
      COALESCE(r.is_read, 0) as is_read,
      r.suggestion
    FROM messages m
    LEFT JOIN reply_suggestions r ON m.source_id = r.message_id
    WHERE m.timestamp::timestamp > NOW() - (? || ' minutes')::interval
      AND m.direction = 'received'
    ORDER BY m.timestamp DESC
    LIMIT ?
  `, [minutes, limit])

  const messages = rows.map(row => ({
    ...row,
    is_at_me: !!row.is_at_me,
    is_read: !!row.is_read,
    suggestion: row.suggestion || null,
  }))

  return NextResponse.json({ messages })
}
