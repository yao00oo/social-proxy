// POST /api/gmail-complete — 用 OAuth code 换 Gmail access token
import { NextRequest, NextResponse } from 'next/server'
import { queryOne, exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

const RELAY_URL = 'https://relay.botook.ai'
const REDIRECT_URI = `${RELAY_URL}/gmail/callback`

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { code } = await req.json() as { code: string }
  if (!code) return NextResponse.json({ error: '缺少 code' }, { status: 400 })

  const getSetting = async (key: string) => (await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key=?`, [key]))?.value || ''
  const clientId = await getSetting('gmail_client_id')
  const clientSecret = await getSetting('gmail_client_secret')

  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: '请先配置 Gmail Client ID 和 Secret' }, { status: 400 })
  }

  // code 换 token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })
  const tokenData = await tokenRes.json()

  if (tokenData.error) {
    return NextResponse.json({ error: `${tokenData.error}: ${tokenData.error_description}` }, { status: 500 })
  }

  const upsertSql = `INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  await exec(upsertSql, ['gmail_access_token', tokenData.access_token])
  await exec(upsertSql, ['gmail_refresh_token', tokenData.refresh_token || ''])
  await exec(upsertSql, ['gmail_token_time', Date.now().toString()])
  await exec(upsertSql, ['gmail_token_expires', (tokenData.expires_in || 3600).toString()])

  // 获取用户邮箱
  const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const profile = await profileRes.json()
  const email = profile.emailAddress || ''
  if (email) await exec(upsertSql, ['gmail_email', email])

  return NextResponse.json({ ok: true, email })
}
