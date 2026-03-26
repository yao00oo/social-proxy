// GET/POST /api/contacts/[name]/interactions — 互动记录
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { id } = await params
  const name = decodeURIComponent(id)
  const db = getDb()

  const messages = db.prepare(`
    SELECT direction, content, timestamp FROM messages
    WHERE contact_name = ? ORDER BY timestamp DESC LIMIT 20
  `).all(name)

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

  const db = getDb()
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  db.prepare(`
    INSERT INTO messages(contact_name, direction, content, timestamp) VALUES (?, ?, ?, ?)
  `).run(name, direction, content, now)

  db.prepare(`
    UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1 WHERE name = ?
  `).run(now, name)

  return NextResponse.json({ success: true }, { status: 201 })
}
