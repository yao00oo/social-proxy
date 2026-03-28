// GET /api/terminal/poll — 终端拉取新消息（长轮询）
import { NextRequest, NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { query } from '@/lib/db'

export const maxDuration = 30

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const threadId = req.nextUrl.searchParams.get('thread_id')
  const afterId = parseInt(req.nextUrl.searchParams.get('after') || '0')

  if (!threadId) {
    return NextResponse.json({ error: '需要 thread_id' }, { status: 400 })
  }

  // 验证 thread 属于该用户
  // 查新消息（direction='received' = 终端收到的命令，即用户从 Web 发给终端的）
  const messages = await query<{
    id: number
    content: string
    sender_name: string
    direction: string
    timestamp: string
    msg_type: string
    metadata: any
  }>(
    `SELECT id, content, sender_name, direction, timestamp, msg_type, metadata
     FROM messages
     WHERE user_id = ? AND thread_id = ? AND id > ? AND direction = 'received'
     ORDER BY id ASC LIMIT 50`,
    [userId, threadId, afterId]
  )

  if (messages.length > 0) {
    return NextResponse.json({ messages })
  }

  // 长轮询：等最多 25 秒
  const start = Date.now()
  while (Date.now() - start < 25000) {
    await new Promise(r => setTimeout(r, 2000))

    const newMsgs = await query<{
      id: number
      content: string
      sender_name: string
      direction: string
      timestamp: string
      msg_type: string
      metadata: any
    }>(
      `SELECT id, content, sender_name, direction, timestamp, msg_type, metadata
       FROM messages
       WHERE user_id = ? AND thread_id = ? AND id > ?
       ORDER BY id ASC LIMIT 50`,
      [userId, threadId, afterId]
    )

    if (newMsgs.length > 0) {
      return NextResponse.json({ messages: newMsgs })
    }
  }

  // 超时，返回空
  return new Response(null, { status: 204 })
}
