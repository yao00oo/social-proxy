// POST /api/gmail-auth — 生成 Google OAuth 授权 URL
// GET  /api/gmail-auth — 查询授权状态
import { NextRequest, NextResponse } from 'next/server'
import { queryOne, exec } from '@/lib/db'
import crypto from 'crypto'
import { getUserId, unauthorized } from '@/lib/auth-helper'

const RELAY_URL = 'https://relay.botook.ai'
const REDIRECT_URI = `${RELAY_URL}/gmail/callback`
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')

// POST — 生成授权 URL
export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const clientIdRow = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'gmail_client_id' AND user_id = ?", [userId]
  )
  const clientId = clientIdRow?.value
  if (!clientId) return NextResponse.json({ error: '请先填写 Gmail Client ID' }, { status: 400 })

  const state = crypto.randomBytes(16).toString('hex')
  await exec(
    `INSERT INTO settings(user_id, key, value) VALUES(?, 'gmail_oauth_state', ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    [userId, state]
  )

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`

  return NextResponse.json({ authUrl })
}

// GET — 查询授权状态（从 channels 表读）
export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const channel = await queryOne<{ credentials: any }>(
    "SELECT credentials FROM channels WHERE user_id = ? AND platform = 'gmail'",
    [userId]
  )
  const creds = channel?.credentials || {}
  return NextResponse.json({
    authed: !!creds.access_token,
    email: creds.email || '',
  })
}
