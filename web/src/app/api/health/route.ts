// GET /api/health — 简单健康检查 + 自动 migration
import { NextResponse } from 'next/server'
import { queryOne, exec } from '@/lib/db'

async function migrate() {
  // 给 messages 表加 sender_name 列（如果没有）
  try {
    await exec(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name TEXT`)
  } catch { /* 已存在则忽略 */ }
}

export async function GET() {
  try {
    await migrate()
    const row = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM contacts')
    return NextResponse.json({ ok: true, contacts: row?.n ?? 0 })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
