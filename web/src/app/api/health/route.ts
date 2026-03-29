// GET /api/health — 简单健康检查 + 自动 migration
import { NextResponse } from 'next/server'
import { queryOne, exec } from '@/lib/db'

async function migrate() {
  try { await exec(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name TEXT`) } catch {}
  try {
    await exec(`CREATE TABLE IF NOT EXISTS skills (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      content TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      source_url TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`)
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_user_name ON skills(user_id, name)`)
  } catch {}
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
