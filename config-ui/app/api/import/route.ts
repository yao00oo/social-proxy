// API: POST /api/import — 接收 .txt 上传，解析微信聊天记录
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

const LINE_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s+(.+?):\s+(.+)$/
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: '没有上传文件' }, { status: 400 })
  }

  const text = await file.text()
  const lines = text.split('\n')
  const db = getDb()

  let imported = 0
  let skipped = 0

  const insertMessage = db.prepare(`
    INSERT INTO messages(contact_name, direction, content, timestamp) VALUES (?, ?, ?, ?)
  `)

  const upsertContact = db.prepare(`
    INSERT INTO contacts(name, email, last_contact_at, message_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      message_count   = message_count + 1,
      last_contact_at = CASE
        WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at
        ELSE last_contact_at
      END,
      email = CASE
        WHEN email IS NULL OR email = '' THEN excluded.email
        ELSE email
      END
  `)

  const run = db.transaction(() => {
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      const match = LINE_RE.exec(trimmed)
      if (!match) { skipped++; continue }

      const [, timestamp, sender, content] = match
      const isSelf = sender === '我' || sender === 'Me' || sender === 'me'
      if (isSelf) { skipped++; continue }

      const emails = content.match(EMAIL_RE)
      const email = emails ? emails[0] : null

      insertMessage.run(sender, 'received', content, timestamp)
      upsertContact.run(sender, email, timestamp)
      imported++
    }
  })

  run()

  return NextResponse.json({ imported, skipped })
}
