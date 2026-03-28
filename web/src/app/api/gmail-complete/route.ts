// POST /api/gmail-complete — 用 OAuth code 换 Gmail access token，存入 channels
import { NextRequest, NextResponse } from 'next/server'
import { exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { getOrCreateChannel } from '@/lib/sync-helpers'

const RELAY_URL = 'https://relay.botook.ai'
const REDIRECT_URI = `${RELAY_URL}/gmail/callback`

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { code } = await req.json() as { code: string }
  if (!code) return NextResponse.json({ error: '缺少 code' }, { status: 400 })

  const clientId = process.env.GMAIL_CLIENT_ID || ''
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || ''

  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: '服务端未配置 Gmail OAuth 凭证' }, { status: 500 })
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

  // 获取用户邮箱
  const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const profile = await profileRes.json()
  const email = profile.emailAddress || ''

  // 创建/更新 channel，凭证全部存入 credentials JSON
  const credentials = {
    client_id: clientId,
    client_secret: clientSecret,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || '',
    token_time: Date.now().toString(),
    expires_in: (tokenData.expires_in || 3600).toString(),
    email,
  }

  const channel = await getOrCreateChannel(userId, 'gmail', email || 'Gmail', credentials)

  // 更新 credentials（getOrCreateChannel 可能只创建不更新 credentials）
  await exec(
    'UPDATE channels SET credentials = ?::jsonb, name = ? WHERE id = ?',
    [JSON.stringify(credentials), email || 'Gmail', channel.id]
  )

  return NextResponse.json({ ok: true, email })
}
