import { getServerSession } from 'next-auth'
import { authOptions } from '@/auth'
import { NextResponse } from 'next/server'
import { exec } from '@/lib/db'

export async function getUserId(): Promise<string | null> {
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
