// GET/POST /api/contacts/[name]/interactions — 互动记录
import { NextRequest, NextResponse } from 'next/server'
import { query, exec } from '@/lib/db'
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
    SELECT direction, content, timestamp FROM messages
    WHERE contact_name = ? ORDER BY timestamp DESC LIMIT 20
  `, [name])

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

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  await exec(`
    INSERT INTO messages(contact_name, direction, content, timestamp) VALUES (?, ?, ?, ?)
  `, [name, direction, content, now])

  await exec(`
    UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1 WHERE name = ?
  `, [now, name])

  return NextResponse.json({ success: true }, { status: 201 })
}
