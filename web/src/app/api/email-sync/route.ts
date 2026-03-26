// API: POST /api/email-sync — 触发邮件 IMAP 同步
// GET  /api/email-sync — 查询同步状态
import { NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'

let syncRunning = false
let syncLog: string[] = []
let lastResult: any = null

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()
  return NextResponse.json({ running: syncRunning, log: syncLog.slice(-50), lastResult })
}

export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()
  // TODO: implement PG-based email sync
  return NextResponse.json({ ok: true, message: '邮件同步功能即将上线' })
}
