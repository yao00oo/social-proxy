// POST /api/schedule/draft — placeholder
import { NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  return NextResponse.json({ message: '日程功能开发中' }, { status: 501 })
}
