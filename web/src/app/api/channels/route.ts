// GET /api/channels — List all channels for the current user
// DELETE /api/channels?id=123 — Delete a channel and all its data
import { NextRequest, NextResponse } from 'next/server'
import { query, exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const channels = await query(`
    SELECT id, platform, name, enabled, created_at, sync_state
    FROM channels
    WHERE user_id = ?
    ORDER BY created_at DESC
  `, [userId])

  const msgCounts = await query<{ channel_id: number; msg_count: number }>(`
    SELECT channel_id, COUNT(*)::int as msg_count
    FROM messages
    WHERE user_id = ?
    GROUP BY channel_id
  `, [userId])

  const threadCounts = await query<{ channel_id: number; thread_count: number }>(`
    SELECT channel_id, COUNT(*)::int as thread_count
    FROM threads
    WHERE user_id = ?
    GROUP BY channel_id
  `, [userId])

  const msgMap = new Map(msgCounts.map(r => [r.channel_id, r.msg_count]))
  const threadMap = new Map(threadCounts.map(r => [r.channel_id, r.thread_count]))

  const result = channels.map((ch: any) => ({
    id: ch.id,
    platform: ch.platform,
    name: ch.name,
    enabled: ch.enabled,
    created_at: ch.created_at,
    sync_state: ch.sync_state,
    msg_count: msgMap.get(ch.id) || 0,
    thread_count: threadMap.get(ch.id) || 0,
  }))

  return NextResponse.json({ channels: result })
}

export async function DELETE(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const channelId = parseInt(id)

  // Delete in order: messages, threads, contact_identities, documents, then channel
  await exec('DELETE FROM messages WHERE channel_id = ? AND user_id = ?', [channelId, userId])
  await exec('DELETE FROM threads WHERE channel_id = ? AND user_id = ?', [channelId, userId])
  await exec('DELETE FROM contact_identities WHERE channel_id = ? AND channel_id IN (SELECT id FROM channels WHERE user_id = ?)', [channelId, userId])
  await exec('DELETE FROM documents WHERE channel_id = ? AND user_id = ?', [channelId, userId])
  await exec('DELETE FROM channels WHERE id = ? AND user_id = ?', [channelId, userId])

  return NextResponse.json({ ok: true })
}
