// API: GET /api/settings — 获取所有配置
//      POST /api/settings — 批量保存配置（除密码外明文存储）
import { NextRequest, NextResponse } from 'next/server'
import { query, exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const rows = await query<{ key: string; value: string }>(`SELECT key, value FROM settings`)
  const settings: Record<string, string> = {}
  for (const { key, value } of rows) settings[key] = value
  return NextResponse.json({ settings })
}

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const body = await req.json() as Record<string, string>

  for (const [key, value] of Object.entries(body)) {
    await exec(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [key, value])
  }

  return NextResponse.json({ ok: true })
}
