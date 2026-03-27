// GET/POST /api/contacts/[name]/interactions — 互动记录（统一多平台模型）
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne, exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { id } = await params
  const name = decodeURIComponent(id)

  const messages = await query(`
    SELECT m.direction, m.content, m.timestamp
    FROM messages m
    JOIN threads t ON m.thread_id = t.id
    WHERE t.name = ? AND t.user_id = ? AND m.user_id = ?
    ORDER BY m.timestamp DESC LIMIT 20
  `, [name, userId, userId])

  return NextResponse.json({ messages })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { id } = await params
  const name = decodeURIComponent(id)
  const { direction, content, platform } = await req.json()

  if (!direction || !content) {
    return NextResponse.json({ error: '缺少参数' }, { status: 400 })
  }

  // Find a thread by name for this user
  const thread = await queryOne<{ id: number; channel_id: number }>(
    `SELECT id, channel_id FROM threads WHERE name = ? AND user_id = ? LIMIT 1`,
    [name, userId]
  )

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  if (thread) {
    await exec(`
      INSERT INTO messages(user_id, thread_id, channel_id, direction, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [userId, thread.id, thread.channel_id, direction, content, now])
  } else {
    // No thread found — insert message without thread (fallback)
    await exec(`
      INSERT INTO messages(user_id, direction, content, timestamp)
      VALUES (?, ?, ?, ?)
    `, [userId, direction, content, now])
  }

  await exec(`
    UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1 WHERE name = ? AND user_id = ?
  `, [now, name, userId])

  return NextResponse.json({ success: true }, { status: 201 })
}
