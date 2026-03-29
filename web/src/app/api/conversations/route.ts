// GET  /api/conversations — 加载最近的对话
// POST /api/conversations — 保存对话消息
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne, exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

// GET — 加载最近的对话（最近一个 conversation 的所有消息）
export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  // 找到最近的 conversation
  const conv = await queryOne<{ id: number; title: string }>(
    'SELECT id, title FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
    [userId],
  )
  if (!conv) return NextResponse.json({ messages: [] })

  const messages = await query<{ role: string; content: string; tool_calls: string | null; created_at: string }>(
    'SELECT role, content, tool_calls, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC',
    [conv.id],
  )

  return NextResponse.json({
    conversationId: conv.id,
    title: conv.title,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content || '',
      toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
    })),
  })
}

// POST — 保存对话消息（全量覆盖）
export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { conversationId, messages } = await req.json() as {
    conversationId?: number
    messages: Array<{ role: string; content: string; toolCall?: any; draft?: any }>
  }

  if (!messages || messages.length === 0) {
    return NextResponse.json({ ok: true })
  }

  // 生成标题：取第一条用户消息的前 50 个字
  const firstUserMsg = messages.find(m => m.role === 'user')
  const title = firstUserMsg?.content?.slice(0, 50) || '新对话'

  let convId = conversationId

  if (convId) {
    // 更新已有对话
    await exec('UPDATE conversations SET title = ?, updated_at = NOW() WHERE id = ? AND user_id = ?', [title, convId, userId])
    // 清空旧消息，重新写入
    await exec('DELETE FROM conversation_messages WHERE conversation_id = ?', [convId])
  } else {
    // 创建新对话
    const row = await queryOne<{ id: number }>(
      'INSERT INTO conversations (user_id, title) VALUES (?, ?) RETURNING id',
      [userId, title],
    )
    convId = row!.id
  }

  // 批量写入消息
  for (const msg of messages) {
    // 跳过 welcome 消息
    if (msg.role === 'assistant' && msg.content.startsWith('你好！我是小林')) continue

    const toolCalls = msg.toolCall ? JSON.stringify(msg.toolCall) : msg.draft ? JSON.stringify({ draft: msg.draft }) : null
    await exec(
      'INSERT INTO conversation_messages (conversation_id, role, content, tool_calls) VALUES (?, ?, ?, ?)',
      [convId, msg.role, msg.content || '', toolCalls],
    )
  }

  return NextResponse.json({ ok: true, conversationId: convId })
}
