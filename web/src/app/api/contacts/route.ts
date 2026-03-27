// GET /api/contacts — 会话列表（threads = 群聊/私聊/通知群，统一展示）
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const search = req.nextUrl.searchParams.get('search') || undefined
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '100'), 500)

  const searchClause = search ? `AND t.name LIKE '%' || ? || '%'` : ''
  const params: any[] = search ? [userId, search] : [userId]

  const contacts = await query(`
    SELECT
      t.name,
      t.type,
      t.last_message_at as last_contact_at,
      COUNT(m.id)::int as message_count,
      ch.platform,
      CASE
        WHEN t.last_message_at IS NULL THEN 9999
        ELSE EXTRACT(DAY FROM NOW() - t.last_message_at::timestamp)::integer
      END AS days_since_last_contact
    FROM threads t
    LEFT JOIN messages m ON m.thread_id = t.id
    LEFT JOIN channels ch ON t.channel_id = ch.id
    WHERE t.user_id = ? ${searchClause}
    GROUP BY t.id, t.name, t.type, t.last_message_at, ch.platform
    ORDER BY t.last_message_at DESC NULLS LAST
    LIMIT ?
  `, [...params, limit])

  const totalRow = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM threads WHERE user_id = ?', [userId])
  const total = totalRow?.n || 0

  return NextResponse.json({ contacts, total })
}
