// GET /api/health — 简单健康检查
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET() {
  try {
    const db = getDb()
    const count = (db.prepare('SELECT COUNT(*) as n FROM contacts').get() as any).n
    return NextResponse.json({ ok: true, contacts: count })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
