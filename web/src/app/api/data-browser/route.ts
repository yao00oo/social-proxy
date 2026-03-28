// GET /api/data-browser — 分页获取会话列表和消息
// ?type=threads&platform=feishu&offset=0&limit=20 — 获取会话列表
// ?type=messages&thread_id=123&offset=0&limit=20 — 获取某会话的消息
// ?type=search&q=关键词&offset=0&limit=20 — 搜索消息
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const type = req.nextUrl.searchParams.get('type') || 'threads'
  const platform = req.nextUrl.searchParams.get('platform')
  const threadId = req.nextUrl.searchParams.get('thread_id')
  const searchQuery = req.nextUrl.searchParams.get('q')
  const offset = parseInt(req.nextUrl.searchParams.get('offset') || '0')
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '20'), 50)

  if (type === 'threads') {
    const platformFilter = platform && platform !== 'all' ? `AND ch.platform = ?` : ''
    const params: any[] = platform && platform !== 'all' ? [userId, platform, limit, offset] : [userId, limit, offset]

    const threads = await query<any>(`
      SELECT t.id, t.name, t.type, ch.platform,
        (SELECT COUNT(*) FROM messages WHERE thread_id = t.id) as message_count,
        (SELECT content FROM messages WHERE thread_id = t.id ORDER BY timestamp DESC LIMIT 1) as last_message,
        (SELECT sender_name FROM messages WHERE thread_id = t.id ORDER BY timestamp DESC LIMIT 1) as last_sender,
        (SELECT timestamp FROM messages WHERE thread_id = t.id ORDER BY timestamp DESC LIMIT 1) as last_time
      FROM threads t
      JOIN channels ch ON t.channel_id = ch.id
      WHERE t.user_id = ? ${platformFilter}
      ORDER BY last_time DESC NULLS LAST
      LIMIT ? OFFSET ?
    `, params)

    const totalRow = await queryOne<{ n: number }>(`
      SELECT COUNT(*) as n FROM threads t
      JOIN channels ch ON t.channel_id = ch.id
      WHERE t.user_id = ? ${platformFilter}
    `, platform && platform !== 'all' ? [userId, platform] : [userId])

    return NextResponse.json({ threads, total: totalRow?.n || 0, offset, limit })
  }

  if (type === 'messages' && threadId) {
    const messages = await query<any>(`
      SELECT m.id, m.direction, m.sender_name, m.content, m.timestamp, m.msg_type, ch.platform
      FROM messages m
      JOIN channels ch ON m.channel_id = ch.id
      WHERE m.thread_id = ? AND m.user_id = ?
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `, [threadId, userId, limit, offset])

    const totalRow = await queryOne<{ n: number }>(
      `SELECT COUNT(*) as n FROM messages WHERE thread_id = ? AND user_id = ?`, [threadId, userId]
    )

    return NextResponse.json({ messages: messages.reverse(), total: totalRow?.n || 0, offset, limit })
  }

  if (type === 'search' && searchQuery) {
    const messages = await query<any>(`
      SELECT m.id, m.direction, m.sender_name, m.content, m.timestamp, t.name as thread_name, ch.platform
      FROM messages m
      JOIN threads t ON m.thread_id = t.id
      JOIN channels ch ON m.channel_id = ch.id
      WHERE m.user_id = ? AND m.content LIKE ?
      ORDER BY m.timestamp DESC
      LIMIT ? OFFSET ?
    `, [userId, `%${searchQuery}%`, limit, offset])

    return NextResponse.json({ messages, total: messages.length, offset, limit })
  }

  return NextResponse.json({ error: 'invalid type' }, { status: 400 })
}

// DELETE /api/data-browser?thread_id=123 — 删除单个会话
export async function DELETE(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const threadId = req.nextUrl.searchParams.get('thread_id')
  if (!threadId) return NextResponse.json({ error: 'missing thread_id' }, { status: 400 })

  await query(`DELETE FROM messages WHERE thread_id = ? AND user_id = ?`, [threadId, userId])
  await query(`DELETE FROM summaries WHERE thread_id = ? AND user_id = ?`, [threadId, userId])
  await query(`DELETE FROM threads WHERE id = ? AND user_id = ?`, [threadId, userId])

  return NextResponse.json({ ok: true })
}
