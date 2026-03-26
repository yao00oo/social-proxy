// POST /api/feishu-auth   — 生成授权 URL
// GET  /api/feishu-auth   — 查询授权状态
// POST /api/feishu-auth/complete — 拿 code 换 token（前端轮询到 code 后调用）
import { NextRequest, NextResponse } from 'next/server'
import { queryOne, exec } from '@/lib/db'
import crypto from 'crypto'
import https from 'https'
import { getUserId, unauthorized } from '@/lib/auth-helper'

const RELAY_URL = 'https://relay.botook.ai'
const REDIRECT_URI = `${RELAY_URL}/feishu/callback`

function httpsPost(url: string, body: object, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve(JSON.parse(data)))
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

// POST /api/feishu-auth — 生成授权 URL
export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const appIdRow = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key='feishu_app_id'`)
  const appId = appIdRow?.value
  if (!appId) return NextResponse.json({ error: '请先填写飞书 App ID' }, { status: 400 })

  const state = crypto.randomBytes(16).toString('hex')
  await exec(`INSERT INTO settings(key,value) VALUES('feishu_oauth_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [state])
  await exec(`INSERT INTO settings(key,value) VALUES('feishu_auth_done','0') ON CONFLICT(key) DO UPDATE SET value='0'`)

  const params = new URLSearchParams({
    app_id: appId,
    redirect_uri: REDIRECT_URI,
    scope: 'im:chat:readonly im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user search:message drive:drive:readonly docx:document:readonly',
    state,
  })
  const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?${params}`

  return NextResponse.json({ authUrl, state })
}

// GET /api/feishu-auth — 查询授权状态
export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const doneRow = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key='feishu_auth_done'`)
  const nameRow = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key='feishu_user_name'`)
  return NextResponse.json({ done: doneRow?.value === '1', name: nameRow?.value || '' })
}
