// POST /api/agent-sync — 接收 botook-agent 上传的数据（iMessage、微信等）
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne, exec } from '@/lib/db'

export const maxDuration = 60

// 通过 API token 认证（不用 session）
async function getUserIdFromToken(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)

  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM settings WHERE key = 'agent_api_token' AND value = ?`,
    [token]
  )
  return row?.user_id || null
}

// Ensure channel exists, return channel_id
async function ensureChannel(userId: string, platform: string): Promise<number> {
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM channels WHERE user_id = ? AND platform = ? LIMIT 1`,
    [userId, platform]
  )
  if (existing) return existing.id

  // Create channel
  await exec(
    `INSERT INTO channels (user_id, platform, name, enabled) VALUES (?, ?, ?, 1)`,
    [userId, platform, platform]
  )
  const created = await queryOne<{ id: number }>(
    `SELECT id FROM channels WHERE user_id = ? AND platform = ? LIMIT 1`,
    [userId, platform]
  )
  return created!.id
}

// Ensure thread exists, return thread_id
async function ensureThread(userId: string, channelId: number, threadName: string): Promise<number> {
  const platformThreadId = threadName // use name as platform ID for simplicity

  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM threads WHERE channel_id = ? AND platform_thread_id = ? AND user_id = ? LIMIT 1`,
    [channelId, platformThreadId, userId]
  )
  if (existing) return existing.id

  await exec(
    `INSERT INTO threads (user_id, channel_id, platform_thread_id, name, type) VALUES (?, ?, ?, ?, 'dm')`,
    [userId, channelId, platformThreadId, threadName]
  )
  const created = await queryOne<{ id: number }>(
    `SELECT id FROM threads WHERE channel_id = ? AND platform_thread_id = ? AND user_id = ? LIMIT 1`,
    [channelId, platformThreadId, userId]
  )
  return created!.id
}

export async function POST(req: NextRequest) {
  const userId = await getUserIdFromToken(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json()
  const { type, platform, data } = body

  if (!type || !platform || !Array.isArray(data)) {
    return NextResponse.json({ error: 'invalid payload: need type, platform, data[]' }, { status: 400 })
  }

  let imported = 0

  if (type === 'messages') {
    const channelId = await ensureChannel(userId, platform)

    // Group messages by thread (contact_name or thread_name)
    const threadCache = new Map<string, number>()

    for (const msg of data) {
      try {
        const threadName = msg.thread_name || msg.contact_name || 'Unknown'

        // Get or create thread
        let threadId = threadCache.get(threadName)
        if (!threadId) {
          threadId = await ensureThread(userId, channelId, threadName)
          threadCache.set(threadName, threadId)
        }

        await exec(
          `INSERT INTO messages (user_id, thread_id, channel_id, direction, content, timestamp, platform_msg_id, sender_name, is_read, msg_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'text')
           ON CONFLICT (channel_id, platform_msg_id) DO NOTHING`,
          [userId, threadId, channelId, msg.direction, msg.content || '', msg.timestamp, msg.platform_msg_id, msg.sender_name || null]
        )
        imported++
      } catch (e: any) {
        // Skip individual message errors silently
      }
    }

    // Upsert contacts
    const contactNames = new Set(data.map((m: any) => m.contact_name || m.thread_name).filter(Boolean))
    for (const name of contactNames) {
      try {
        await exec(
          `INSERT INTO contacts (user_id, name, last_contact_at, message_count)
           VALUES (?, ?, NOW()::text, 1)
           ON CONFLICT (user_id, name) DO UPDATE SET
             message_count = contacts.message_count + 1,
             last_contact_at = NOW()::text`,
          [userId, name]
        )
      } catch {}
    }
  }

  if (type === 'contacts') {
    for (const c of data) {
      try {
        await exec(
          `INSERT INTO contacts (user_id, name, message_count)
           VALUES (?, ?, 0)
           ON CONFLICT (user_id, name) DO NOTHING`,
          [userId, c.name]
        )
        imported++
      } catch {}
    }
  }

  return NextResponse.json({ ok: true, imported })
}
