// API: POST /api/feishu-sync — 触发飞书消息同步
// GET  /api/feishu-sync — 查询同步状态
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

// 同步状态放 settings 里（简单方案，避免引入 Redis）
let syncRunning = false
let syncLog: string[] = []
let lastResult: any = null

export async function GET() {
  return NextResponse.json({ running: syncRunning, log: syncLog.slice(-50), lastResult })
}

export async function POST() {
  if (syncRunning) {
    return NextResponse.json({ error: '同步正在进行中' }, { status: 409 })
  }

  syncRunning = true
  syncLog = []
  lastResult = null

  // 异步执行，不阻塞响应
  ;(async () => {
    try {
      // 动态 import 避免在 Next.js 初始化时加载 better-sqlite3
      const { syncFeishu } = await import('../../../../mcp-server/src/feishu/sync')
      lastResult = await syncFeishu((msg) => {
        syncLog.push(msg)
      })
    } catch (err: any) {
      const msg = err?.message || String(err)
      const stack = err?.stack || ''
      console.error('[feishu-sync] error:', stack || msg)
      syncLog.push(`❌ 同步失败: ${msg}`)
      syncLog.push(`Stack: ${stack.split('\n').slice(0, 5).join(' | ')}`)
      lastResult = { error: msg }
    } finally {
      syncRunning = false
    }
  })()

  return NextResponse.json({ ok: true, message: '同步已启动' })
}
