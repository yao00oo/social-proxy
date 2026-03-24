import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const contact = searchParams.get('contact') || ''
  const q = searchParams.get('q') || ''
  const page = parseInt(searchParams.get('page') || '1')
  const pageSize = 50

  const db = getDb()
  const offset = (page - 1) * pageSize

  let where = 'WHERE 1=1'
  const params: any[] = []

  if (contact) {
    where += ' AND contact_name = ?'
    params.push(contact)
  }
  if (q) {
    where += ' AND content LIKE ?'
    params.push(`%${q}%`)
  }

  const total = (db.prepare(`SELECT COUNT(*) as n FROM messages ${where}`).get(...params) as any).n
  const rows = db.prepare(
    `SELECT id, contact_name, direction, content, timestamp FROM messages ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset)

  return NextResponse.json({ messages: rows, total, page, pageSize })
}
