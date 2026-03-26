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

function notifyNewMessages(count: number) {
  if (process.platform !== 'darwin' || count <= 0) return
  try {
    const { execSync } = require('child_process')
    execSync(`osascript -e 'display notification "收到 ${count} 条新飞书消息" with title "Social Proxy" sound name "Ping"'`)
  } catch {}
}

async function runQuickSync() {
  if (syncRunning) return
  try {
    const { quickSync } = await import('@mcp/feishu/sync')
    const { generateReplySuggestions } = await import('@mcp/sync/reply-suggest')
    const result = await quickSync()
    if (result.imported > 0) {
      lastResult = { ...lastResult, quickImported: result.imported, quickAt: new Date().toLocaleTimeString() }
      console.log(`[快速同步] 新消息 ${result.imported} 条`)
      notifyNewMessages(result.imported)
    }

    // 为未处理的消息生成 AI 回复建议
    const count = await generateReplySuggestions()
    if (count > 0) console.log(`[回复建议] 生成了 ${count} 条`)
  } catch (err: any) {
    console.error('[快速同步] error:', err?.message)
  }
}

async function runFullSync() {
  if (syncRunning) return
  syncRunning = true
  syncLog = []
  lastResult = null
  try {
    const { syncFeishu } = await import('@mcp/feishu/sync')
    lastResult = await syncFeishu((msg) => { syncLog.push(msg) })
  } catch (err: any) {
    const msg = err?.message || String(err)
    console.error('[feishu-sync] error:', err?.stack || msg)
    syncLog.push(`❌ 同步失败: ${msg}`)
    lastResult = { error: msg }
  } finally {
    syncRunning = false
  }
}

export async function POST(req: Request) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const body = await req.json().catch(() => ({})) as any

  if (body.autoSyncSeconds !== undefined) {
    autoSyncSeconds = Number(body.autoSyncSeconds) || 0
    if (autoSyncInterval) { clearInterval(autoSyncInterval); autoSyncInterval = null }
    if (autoSyncSeconds > 0) {
      const fn = autoSyncSeconds < 60 ? runQuickSync : runFullSync
      autoSyncInterval = setInterval(fn, autoSyncSeconds * 1000)
      console.log(`[feishu-sync] 自动同步已开启，每 ${autoSyncSeconds}s`)
    }
    return NextResponse.json({ ok: true, autoSyncSeconds })
  }

  runFullSync()
  return NextResponse.json({ ok: true, message: '同步已启动' })
}
