// POST /api/feishu-complete — 前端拿到 code 后调此接口换 token
import { NextRequest, NextResponse } from 'next/server'
import { exec } from '@/lib/db'
import https from 'https'
import { getUserId, unauthorized } from '@/lib/auth-helper'

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

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { code } = await req.json() as { code: string }
  if (!code) return NextResponse.json({ error: '缺少 code' }, { status: 400 })

  const appId = process.env.FEISHU_APP_ID
  const appSecret = process.env.FEISHU_APP_SECRET
  if (!appId || !appSecret) return NextResponse.json({ error: '未配置飞书 App ID/Secret（环境变量）' }, { status: 500 })

  // 1. 获取 app_access_token
  const appTokenRes = await httpsPost(
    'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
    { app_id: appId, app_secret: appSecret }
  )
  if (appTokenRes.code !== 0) {
    return NextResponse.json({ error: `获取 app token 失败: ${appTokenRes.msg}` }, { status: 500 })
  }

  // 2. code 换 user_access_token
  const userTokenRes = await httpsPost(
    'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
    { grant_type: 'authorization_code', code },
    { Authorization: `Bearer ${appTokenRes.app_access_token}` }
  )
  if (userTokenRes.code !== 0) {
    return NextResponse.json({ error: `换取 user token 失败: ${userTokenRes.msg}` }, { status: 500 })
  }

  const d = userTokenRes.data
  console.log('[feishu-complete] token data keys:', Object.keys(d || {}))
  const upsertSql = `INSERT INTO settings(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value`
  await exec(upsertSql, [userId, 'feishu_user_access_token', d.access_token ?? ''])
  await exec(upsertSql, [userId, 'feishu_refresh_token', d.refresh_token ?? ''])
  await exec(upsertSql, [userId, 'feishu_user_name', d.name ?? ''])
  await exec(upsertSql, [userId, 'feishu_user_id', d.open_id ?? d.user_id ?? ''])
  await exec(upsertSql, [userId, 'feishu_token_time', Date.now().toString()])
  await exec(upsertSql, [userId, 'feishu_auth_done', '1'])

  return NextResponse.json({ ok: true, name: d.name ?? '' })
}
