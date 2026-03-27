// GET /api/auth/device?code=xxx — 设备登录页（浏览器打开后用户 Google 登录）
// POST /api/auth/device — agent 请求创建 device code
import { NextRequest, NextResponse } from 'next/server'
import { exec, queryOne } from '@/lib/db'
import { getUserId } from '@/lib/auth-helper'
import crypto from 'crypto'

// POST: agent 请求创建设备码
export async function POST() {
  const code = crypto.randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 min expiry

  await exec(
    `INSERT INTO settings(user_id, key, value) VALUES('__device__', ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    [`device_code_${code}`, JSON.stringify({ status: 'pending', expiresAt })]
  )

  return NextResponse.json({ code, expiresAt })
}

// GET: 检查是否已登录并关联（浏览器登录后调用）
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 })

  const userId = await getUserId()
  if (!userId) {
    // 未登录，重定向到登录页（带回调）
    const callbackUrl = `${req.nextUrl.origin}/api/auth/device?code=${code}`
    return NextResponse.redirect(new URL(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`, req.nextUrl.origin))
  }

  // 已登录，生成 API token 并关联
  const apiToken = crypto.randomBytes(32).toString('hex')
  await exec(
    `INSERT INTO settings(user_id, key, value) VALUES('__device__', ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    [`device_code_${code}`, JSON.stringify({ status: 'authorized', userId, apiToken, authorizedAt: new Date().toISOString() })]
  )

  // 保存 API token 到用户 settings
  await exec(
    `INSERT INTO settings(user_id, key, value) VALUES(?, 'agent_api_token', ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    [userId, apiToken]
  )

  return new Response(`
    <html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;background:#fbf9f4">
      <div style="text-align:center">
        <div style="font-size:48px;margin-bottom:16px">✅</div>
        <h1 style="color:#003728;margin:0">设备已授权</h1>
        <p style="color:#707974;margin-top:8px">你可以关闭这个窗口了，botook-agent 正在同步...</p>
      </div>
    </body></html>
  `, { headers: { 'Content-Type': 'text/html' } })
}
