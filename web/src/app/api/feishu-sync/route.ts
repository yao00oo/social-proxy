// API: POST /api/feishu-sync — 触发飞书消息同步
// GET  /api/feishu-sync — 查询同步状态
import { NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'

let syncRunning = false
let syncLog: string[] = []
let lastResult: any = null
let autoSyncInterval: ReturnType<typeof setInterval> | null = null
let autoSyncSeconds = 0

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()
  return NextResponse.json({
    running: syncRunning,
    log: syncLog.slice(-50),
    lastResult,
    autoSync: autoSyncSeconds > 0,
    autoSyncSeconds,
  })
}

export async function POST(req: Request) {
  const userId = await getUserId()
  if (!userId) return unauthorized()
  const body = await req.json().catch(() => ({})) as any

  if (body.autoSyncSeconds !== undefined) {
    autoSyncSeconds = Number(body.autoSyncSeconds) || 0
    // TODO: implement PG-based sync for production
    return NextResponse.json({ ok: true, autoSyncSeconds })
  }

  // TODO: implement PG-based full sync
  return NextResponse.json({ ok: true, message: '同步功能即将上线' })
}
