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

  return NextResponse.json({
    running: syncRunning,
    log: syncLog.slice(-50),
    lastResult,
  })
}

export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  if (syncRunning) {
    return NextResponse.json({ error: '同步正在进行中' }, { status: 409 })
  }

  syncRunning = true
  syncLog = []
  lastResult = null

  ;(async () => {
    try {
      const { syncEmail } = await import('@mcp/email/sync')
      lastResult = await syncEmail((msg) => { syncLog.push(msg) })
    } catch (e: any) {
      syncLog.push(`❌ ${e.message}`)
      lastResult = { error: e.message }
    } finally {
      syncRunning = false
    }
  })()

  return NextResponse.json({ started: true })
}
