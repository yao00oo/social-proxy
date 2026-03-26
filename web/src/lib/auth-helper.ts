import { getServerSession } from 'next-auth'
import { authOptions } from '@/auth'
import { NextResponse } from 'next/server'

export async function getUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions)
  return session?.user?.id ?? session?.user?.email ?? null
}

export function unauthorized() {
  return NextResponse.json({ error: '请先登录' }, { status: 401 })
}
