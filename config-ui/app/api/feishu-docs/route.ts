import { NextResponse } from 'next/server'

let syncRunning = false
let syncLog: string[] = []
let lastResult: any = null

export async function GET() {
  return NextResponse.json({ running: syncRunning, log: syncLog.slice(-50), lastResult })
}

export async function POST() {
  if (syncRunning) return NextResponse.json({ error: '同步进行中' }, { status: 409 })

  syncRunning = true
  syncLog = []
  lastResult = null

  ;(async () => {
    try {
      const { syncDocs } = await import('../../../../mcp-server/src/feishu/docs')
      lastResult = await syncDocs((msg) => syncLog.push(msg))
    } catch (e: any) {
      syncLog.push(`❌ 失败: ${e.message}`)
      lastResult = { error: e.message }
    } finally {
      syncRunning = false
    }
  })()

  return NextResponse.json({ ok: true })
}
