// POST /api/gmail-complete — 用 OAuth code 换 Gmail access token
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

const RELAY_URL = 'https://relay.botook.ai'
const REDIRECT_URI = `${RELAY_URL}/gmail/callback`

export async function POST(req: NextRequest) {
  const { code } = await req.json() as { code: string }
  if (!code) return NextResponse.json({ error: '缺少 code' }, { status: 400 })

  const db = getDb()
  const get = (key: string) => (db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as any)?.value || ''
  const clientId = get('gmail_client_id')
  const clientSecret = get('gmail_client_secret')

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

  const upsert = db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
  upsert.run('gmail_access_token', tokenData.access_token)
  upsert.run('gmail_refresh_token', tokenData.refresh_token || '')
  upsert.run('gmail_token_time', Date.now().toString())
  upsert.run('gmail_token_expires', (tokenData.expires_in || 3600).toString())

  // 获取用户邮箱
  const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const profile = await profileRes.json()
  const email = profile.emailAddress || ''
  if (email) upsert.run('gmail_email', email)

  return NextResponse.json({ ok: true, email })
}
