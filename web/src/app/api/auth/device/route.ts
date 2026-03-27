// POST /api/auth/device — agent 请求创建设备码（公开，不需要登录）
// GET /api/auth/device?code=xxx — 前端调用，完成设备授权（需要登录）
import { NextRequest, NextResponse } from 'next/server'
import { query, queryOne, exec } from '@/lib/db'
import { getUserId } from '@/lib/auth-helper'
import crypto from 'crypto'

// 设备码存在独立的 KV 表（不受 users 外键约束）
async function ensureDeviceCodesTable() {
  await exec(`CREATE TABLE IF NOT EXISTS device_codes (
    code TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    user_id TEXT,
    api_token TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`)
}

// POST: agent 请求创建设备码（不需要登录）
export async function POST() {
  await ensureDeviceCodesTable()
  const code = crypto.randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

  await exec(
    `INSERT INTO device_codes(code, status, expires_at) VALUES(?, 'pending', ?)`,
    [code, expiresAt]
  )

  return NextResponse.json({ code, expiresAt })
}

// GET: 前端登录后调用，关联 device code 与用户
export async function GET(req: NextRequest) {
  try {
  await ensureDeviceCodesTable()
  const code = req.nextUrl.searchParams.get('code')
  if (!code) return NextResponse.json({ error: 'missing code' }, { status: 400 })

  const userId = await getUserId()
  if (!userId) {
    return NextResponse.json({ error: 'not logged in' }, { status: 401 })
  }

  // 检查 device code 是否存在
  const row = await queryOne<{ status: string; expires_at: string }>(
    `SELECT status, expires_at FROM device_codes WHERE code = ?`, [code]
  )
  if (!row) return NextResponse.json({ error: 'invalid code' }, { status: 404 })
  if (new Date(row.expires_at) < new Date()) return NextResponse.json({ error: 'code expired' }, { status: 410 })
  if (row.status === 'authorized') return NextResponse.json({ ok: true, message: 'already authorized' })

  // 生成 API token
  const apiToken = crypto.randomBytes(32).toString('hex')

  // 更新 device code
  await exec(
    `UPDATE device_codes SET status = 'authorized', user_id = ?, api_token = ? WHERE code = ?`,
    [userId, apiToken, code]
  )

  // 保存 API token 到用户 settings
  await exec(
    `INSERT INTO settings(user_id, key, value) VALUES(?, 'agent_api_token', ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
    [userId, apiToken]
  )

  return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[device-auth] error:', e)
    return NextResponse.json({ error: e.message || 'internal error' }, { status: 500 })
  }
}
