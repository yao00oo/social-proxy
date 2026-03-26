import { NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'

let running = false
let log: string[] = []
let lastResult: any = null

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()
  return NextResponse.json({ running, log: log.slice(-50), lastResult })
}

export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()
  // TODO: implement PG-based doc sync
  return NextResponse.json({ ok: true, message: '文档同步功能即将上线' })
}
