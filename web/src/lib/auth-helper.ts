import { getServerSession } from 'next-auth'
import { authOptions } from '@/auth'
import { NextResponse } from 'next/server'
import { exec, queryOne } from '@/lib/db'
import { headers } from 'next/headers'

export async function getUserId(): Promise<string | null> {
  // 1. 先尝试 Bearer token（终端/API 调用）
  const headerList = await headers()
  const authHeader = headerList.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7)
    if (token) {
      const row = await queryOne<{ user_id: string }>(
        `SELECT user_id FROM settings WHERE key = 'agent_api_token' AND value = ?`,
        [token]
      )
      if (row) return row.user_id
    }
  }

  // 2. 再尝试 session cookie（Web 登录）
  const session = await getServerSession(authOptions)
  if (!session?.user) return null

  const userId = session.user.id ?? session.user.email
  if (!userId) return null

  // Ensure user exists in PG (JWT mode doesn't auto-create)
  try {
    await exec(
      `INSERT INTO users(id, name, email, image) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, image=excluded.image`,
      [userId, session.user.name || '', session.user.email || '', session.user.image || '']
    )
  } catch {}

  return userId
}

export function unauthorized() {
  return NextResponse.json({ error: '请先登录' }, { status: 401 })
}
