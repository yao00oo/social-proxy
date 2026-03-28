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

  // 检查是否已有同名终端 channel
  let existingChannel = await queryOne<{ id: number }>(
    `SELECT id FROM channels WHERE user_id = ? AND platform = 'terminal' AND name = ?`,
    [userId, terminalName]
  )

  const now = new Date().toISOString()

  // 没有 channel → 创建
  if (!existingChannel) {
    existingChannel = await queryOne<{ id: number }>(
      `INSERT INTO channels (user_id, platform, name, credentials, sync_state)
       VALUES (?, 'terminal', ?, ?, ?)
       RETURNING id`,
      [
        userId,
        terminalName,
        JSON.stringify({ hostname, platform, arch }),
        JSON.stringify({ last_seen: now, online: true }),
      ]
    )
    if (!existingChannel) {
      return NextResponse.json({ error: '创建终端失败' }, { status: 500 })
    }
  } else {
    // 更新在线状态
    await exec(
      `UPDATE channels SET sync_state = jsonb_set(COALESCE(sync_state, '{}'), '{last_seen}', to_jsonb(now()::text))
       WHERE id = ?`,
      [existingChannel.id]
    )
  }

  const channelId = existingChannel.id

  // 确保 thread 存在（channel 在但 thread 被删的情况自动修复）
  let thread = await queryOne<{ id: number }>(
    `SELECT id FROM threads WHERE channel_id = ? AND user_id = ?`,
    [channelId, userId]
  )
  if (!thread) {
    thread = await queryOne<{ id: number }>(
      `INSERT INTO threads (user_id, channel_id, platform_thread_id, name, type, last_message_at)
       VALUES (?, ?, ?, ?, 'dm', ?)
       RETURNING id`,
      [userId, channelId, `terminal_${channelId}`, terminalName, now]
    )
    if (!thread) {
      return NextResponse.json({ error: '创建会话失败' }, { status: 500 })
    }
  }

  // 确保联系人存在
  await exec(
    `INSERT INTO contacts (user_id, name, tags, last_contact_at, message_count)
     VALUES (?, ?, '["终端"]', ?, 0)
     ON CONFLICT (user_id, name) DO NOTHING`,
    [userId, terminalName, now]
  )

  const user = await queryOne<{ email: string }>('SELECT email FROM users WHERE id = ?', [userId])

  return NextResponse.json({
    channel_id: channelId,
    thread_id: thread.id,
    terminal_id: channelId,
    email: user?.email || '',
    name: terminalName,
    message: '终端已连接',
  })
}
