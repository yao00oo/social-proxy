// POST /api/terminal/send — 向终端发消息
// from=web: Web 端发给终端（direction='received'，终端 daemon 会 poll 到）
// from=terminal: 终端发给 Web（direction='sent'，Web 端能看到）
import { NextRequest, NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { queryOne, exec } from '@/lib/db'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { thread_id, content, from } = await req.json()

  if (!thread_id || !content) {
    return NextResponse.json({ error: '需要 thread_id 和 content' }, { status: 400 })
  }

  const thread = await queryOne<{ id: number; channel_id: number; name: string }>(
    `SELECT t.id, t.channel_id, t.name FROM threads t
     JOIN channels c ON c.id = t.channel_id
     WHERE t.id = ? AND t.user_id = ? AND c.platform = 'terminal'`,
    [thread_id, userId]
  )

  if (!thread) {
    return NextResponse.json({ error: '会话不存在' }, { status: 404 })
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  // 方向以终端视角存储（daemon 依赖此约定）：
  // from=web（默认）→ 终端收到命令 → direction='received'
  // from=terminal → 终端发出结果 → direction='sent'
  // Web UI 渲染时会翻转方向
  const direction = from === 'terminal' ? 'sent' : 'received'
  const senderName = from === 'terminal' ? thread.name : '我'

  await exec(
    `INSERT INTO messages (user_id, thread_id, channel_id, direction, sender_name, content, msg_type, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, 'text', ?)`,
    [userId, thread_id, thread.channel_id, direction, senderName, content, now]
  )

  await exec(
    `UPDATE threads SET last_message_at = ? WHERE id = ?`,
    [now, thread_id]
  )

  return NextResponse.json({ success: true })
}
