// GET /api/auth/device/poll?code=xxx — agent 轮询检查设备码是否已授权
import { NextRequest, NextResponse } from 'next/server'
import { queryOne } from '@/lib/db'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 })

  const row = await queryOne<{ value: string }>(
    `SELECT value FROM settings WHERE user_id = '__device__' AND key = ?`,
    [`device_code_${code}`]
  )

  if (!row) return NextResponse.json({ status: 'not_found' }, { status: 404 })

  const data = JSON.parse(row.value)

  if (data.status === 'authorized') {
    return NextResponse.json({ status: 'authorized', token: data.apiToken, userId: data.userId })
  }

  if (new Date(data.expiresAt) < new Date()) {
    return NextResponse.json({ status: 'expired' })
  }

  return NextResponse.json({ status: 'pending' })
}
