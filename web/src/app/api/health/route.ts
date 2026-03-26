// GET /api/health — 简单健康检查
import { NextResponse } from 'next/server'
import { queryOne } from '@/lib/db'

export async function GET() {
  try {
    const row = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM contacts')
    return NextResponse.json({ ok: true, contacts: row?.n ?? 0 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
