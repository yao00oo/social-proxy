// POST /api/gmail-auth — 生成 Google OAuth 授权 URL
// GET  /api/gmail-auth — 查询授权状态
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import crypto from 'crypto'

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
  const db = getDb()
  const clientId = (db.prepare(`SELECT value FROM settings WHERE key='gmail_client_id'`).get() as any)?.value
  if (!clientId) return NextResponse.json({ error: '请先填写 Gmail Client ID' }, { status: 400 })

  const state = crypto.randomBytes(16).toString('hex')
  const upsert = db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
  upsert.run('gmail_oauth_state', state)

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

// GET — 查询授权状态
export async function GET() {
  const db = getDb()
  const token = (db.prepare(`SELECT value FROM settings WHERE key='gmail_access_token'`).get() as any)?.value
  const email = (db.prepare(`SELECT value FROM settings WHERE key='gmail_email'`).get() as any)?.value
  return NextResponse.json({ authed: !!token, email: email || '' })
}
