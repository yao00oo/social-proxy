// API: GET /api/contacts — 获取联系人列表
//      PATCH /api/contacts — 更新联系人邮箱
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET() {
  const db = getDb()
  const contacts = db.prepare(`
    SELECT id, name, email, last_contact_at, message_count FROM contacts ORDER BY name ASC
  `).all()
  return NextResponse.json({ contacts })
}

export async function PATCH(req: NextRequest) {
  const { id, email } = await req.json() as { id: number; email: string }

  const db = getDb()
  db.prepare(`UPDATE contacts SET email = ? WHERE id = ?`).run(email.trim(), id)

  return NextResponse.json({ ok: true })
}
