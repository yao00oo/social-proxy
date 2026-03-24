// API: GET /api/settings — 获取所有配置
//      POST /api/settings — 批量保存配置（除密码外明文存储）
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET() {
  const db = getDb()
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]
  const settings: Record<string, string> = {}
  for (const { key, value } of rows) settings[key] = value
  return NextResponse.json({ settings })
}

export async function POST(req: NextRequest) {
  const body = await req.json() as Record<string, string>
  const db = getDb()

  const upsert = db.prepare(`
    INSERT INTO settings(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)

  const run = db.transaction(() => {
    for (const [key, value] of Object.entries(body)) {
      upsert.run(key, value)
    }
  })

  run()

  return NextResponse.json({ ok: true })
}
