// POST /api/terminal/connect — 注册终端为联系人
// 创建 channel(platform='terminal') + thread(type='dm')
import { NextRequest, NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { query, queryOne, exec } from '@/lib/db'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { name, hostname, platform, arch } = await req.json()
  const terminalName = name || hostname || 'Terminal'

  // 检查是否已有同名终端
  const existing = await queryOne<{ id: number; channel_id: number; thread_id: number }>(
    `SELECT c.id as channel_id, t.id as thread_id
     FROM channels c JOIN threads t ON t.channel_id = c.id
     WHERE c.user_id = ? AND c.platform = 'terminal' AND c.name = ?`,
    [userId, terminalName]
  )

  if (existing) {
    // 更新在线状态
    await exec(
      `UPDATE channels SET sync_state = jsonb_set(COALESCE(sync_state, '{}'), '{last_seen}', to_jsonb(now()::text))
       WHERE id = ?`,
      [existing.channel_id]
    )

    const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId])

    return NextResponse.json({
      channel_id: existing.channel_id,
      thread_id: existing.thread_id,
      terminal_id: existing.channel_id,
      email: user?.email || '',
      name: terminalName,
      message: '终端已重新连接',
    })
  }

  // 创建 channel
  const channel = await queryOne<{ id: number }>(
    `INSERT INTO channels (user_id, platform, name, credentials, sync_state)
     VALUES (?, 'terminal', ?, ?, ?)
     RETURNING id`,
    [
      userId,
      terminalName,
      JSON.stringify({ hostname, platform, arch }),
      JSON.stringify({ last_seen: new Date().toISOString(), online: true }),
    ]
  )

  if (!channel) {
    return NextResponse.json({ error: '创建终端失败' }, { status: 500 })
  }

  // 创建 thread（必须设 last_message_at，否则 Web 端联系人列表看不到）
  const now = new Date().toISOString()
  const thread = await queryOne<{ id: number }>(
    `INSERT INTO threads (user_id, channel_id, platform_thread_id, name, type, last_message_at)
     VALUES (?, ?, ?, ?, 'dm', ?)
     RETURNING id`,
    [userId, channel.id, `terminal_${channel.id}`, terminalName, now]
  )

  if (!thread) {
    return NextResponse.json({ error: '创建会话失败' }, { status: 500 })
  }

  // 创建一个联系人
  await exec(
    `INSERT INTO contacts (user_id, name, tags, last_contact_at, message_count)
     VALUES (?, ?, '["终端"]', ?, 0)
     ON CONFLICT (user_id, name) DO NOTHING`,
    [userId, terminalName, new Date().toISOString()]
  )

  const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId])

  return NextResponse.json({
    channel_id: channel.id,
    thread_id: thread.id,
    terminal_id: channel.id,
    email: user?.email || '',
    name: terminalName,
    message: '终端已连接',
  }, { status: 201 })
}
