// POST /api/terminal/send — 终端发送消息
// 终端发来的消息写入 messages 表，Web 端可以看到
import { NextRequest, NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { queryOne, exec } from '@/lib/db'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { thread_id, content } = await req.json()

  if (!thread_id || !content) {
    return NextResponse.json({ error: '需要 thread_id 和 content' }, { status: 400 })
  }

  // 验证 thread 属于该用户且是终端类型
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

  // 写入消息（direction='sent' 表示从终端视角发出，在 Web 端显示为从终端收到的）
  await exec(
    `INSERT INTO messages (user_id, thread_id, channel_id, direction, sender_name, content, msg_type, timestamp)
     VALUES (?, ?, ?, 'sent', ?, ?, 'text', ?)`,
    [userId, thread_id, thread.channel_id, thread.name, content, now]
  )

  // 更新 thread 最后消息时间
  await exec(
    `UPDATE threads SET last_message_at = ? WHERE id = ?`,
    [now, thread_id]
  )

  return NextResponse.json({ success: true })
}
