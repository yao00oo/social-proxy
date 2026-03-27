// GET /api/auth/device/poll?code=xxx — agent 轮询检查设备码是否已授权
import { NextRequest, NextResponse } from 'next/server'
import { queryOne } from '@/lib/db'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 })

  const row = await queryOne<{ status: string; user_id: string; api_token: string; expires_at: string }>(
    `SELECT status, user_id, api_token, expires_at FROM device_codes WHERE code = ?`,
    [code]
  )

  if (!row) return NextResponse.json({ status: 'not_found' }, { status: 404 })

  if (row.status === 'authorized') {
    return NextResponse.json({ status: 'authorized', token: row.api_token, userId: row.user_id })
  }

  if (new Date(row.expires_at) < new Date()) {
    return NextResponse.json({ status: 'expired' })
  }

  return NextResponse.json({ status: 'pending' })
}
