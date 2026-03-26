import { auth } from '@/auth'
import { NextResponse } from 'next/server'

export async function getUserId(): Promise<string | null> {
  const session = await auth()
  return session?.user?.id ?? null
}

export function unauthorized() {
  return NextResponse.json({ error: '请先登录' }, { status: 401 })
}
