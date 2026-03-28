// GET /api/channel-data?platform=feishu — 获取某数据源的数据统计
// DELETE /api/channel-data?platform=feishu — 删除某数据源的数据
// PATCH /api/channel-data — 停用/启用数据源
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne, exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const platform = req.nextUrl.searchParams.get('platform')

  // Get all channels for this user
  const channels = await query<any>(
    platform
      ? `SELECT id, platform, name, enabled, created_at FROM channels WHERE user_id = ? AND platform = ?`
      : `SELECT id, platform, name, enabled, created_at FROM channels WHERE user_id = ?`,
    platform ? [userId, platform] : [userId]
  )

  const result = []
  for (const ch of channels) {
    const stats = await queryOne<any>(`
      SELECT
        (SELECT COUNT(*) FROM threads WHERE channel_id = ? AND user_id = ?) as threads,
        (SELECT COUNT(*) FROM messages WHERE channel_id = ? AND user_id = ?) as messages,
        (SELECT MAX(timestamp) FROM messages WHERE channel_id = ? AND user_id = ?) as last_message_at
    `, [ch.id, userId, ch.id, userId, ch.id, userId])

    result.push({
      id: ch.id,
      platform: ch.platform,
      name: ch.name,
      enabled: !!ch.enabled,
      created_at: ch.created_at,
      threads: parseInt(stats?.threads || '0'),
      messages: parseInt(stats?.messages || '0'),
      last_message_at: stats?.last_message_at || null,
    })
  }

  return NextResponse.json({ channels: result })
}

export async function DELETE(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const platform = req.nextUrl.searchParams.get('platform')
  if (!platform) return NextResponse.json({ error: 'missing platform' }, { status: 400 })

  const channel = await queryOne<{ id: number }>(
    `SELECT id FROM channels WHERE user_id = ? AND platform = ? LIMIT 1`, [userId, platform]
  )
  if (!channel) return NextResponse.json({ error: 'channel not found' }, { status: 404 })

  // Delete in order: messages → threads → documents → channel data (keep channel record)
  await exec(`DELETE FROM messages WHERE channel_id = ? AND user_id = ?`, [channel.id, userId])
  await exec(`DELETE FROM summaries WHERE thread_id IN (SELECT id FROM threads WHERE channel_id = ? AND user_id = ?)`, [channel.id, userId])
  await exec(`DELETE FROM threads WHERE channel_id = ? AND user_id = ?`, [channel.id, userId])
  await exec(`DELETE FROM documents WHERE channel_id = ? AND user_id = ?`, [channel.id, userId])
  await exec(`DELETE FROM contact_identities WHERE channel_id = ?`, [channel.id])

  return NextResponse.json({ ok: true, message: `已删除 ${platform} 的所有数据` })
}

export async function PATCH(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { platform, enabled } = await req.json()
  if (!platform || enabled === undefined) return NextResponse.json({ error: 'missing platform or enabled' }, { status: 400 })

  await exec(
    `UPDATE channels SET enabled = ? WHERE user_id = ? AND platform = ?`,
    [enabled ? 1 : 0, userId, platform]
  )

  return NextResponse.json({ ok: true, enabled: !!enabled })
}
