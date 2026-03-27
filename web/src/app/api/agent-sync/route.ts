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
    for (const msg of data) {
      try {
        await exec(
          `INSERT INTO messages (user_id, contact_name, direction, content, timestamp, source_id, sender_name, is_read)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT (user_id, source_id) DO NOTHING`,
          [userId, msg.contact_name || msg.thread_name || 'Unknown', msg.direction, msg.content || '', msg.timestamp, `${platform}:${msg.platform_msg_id}`, msg.sender_name || null]
        )
        imported++
      } catch {}
    }

    // Upsert contacts
    const contactNames = new Set(data.filter((m: any) => m.direction === 'received').map((m: any) => m.contact_name || m.thread_name))
    for (const name of contactNames) {
      if (!name) continue
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
