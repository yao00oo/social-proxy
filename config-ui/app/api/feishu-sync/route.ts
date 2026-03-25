// API: POST /api/feishu-sync — 触发飞书消息同步
// GET  /api/feishu-sync — 查询同步状态
import { NextResponse } from 'next/server'

let syncRunning = false
let syncLog: string[] = []
let lastResult: any = null
let autoSyncInterval: ReturnType<typeof setInterval> | null = null
let autoSyncSeconds = 0

export async function GET() {
  return NextResponse.json({
    running: syncRunning,
    log: syncLog.slice(-50),
    lastResult,
    autoSync: autoSyncSeconds > 0,
    autoSyncSeconds,
  })
}

async function generateSuggestion(contactName: string, history: any[], content: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return ''
  const historyText = history.map((m: any) =>
    `${m.direction === 'sent' ? '我' : contactName}: ${m.content}`
  ).join('\n')
  const prompt = `联系人：${contactName}\n最近对话：\n${historyText || '（无）'}\n\n${contactName}刚发来：${content}\n\n请判断是否需要回复（是/否及理由），如需回复给2-3个简短选项（不超过50字/个）。\n格式：\n需要回复：[是/否] — [理由]\n选项1：[...]\n选项2：[...]`
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'deepseek/deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 300 }),
    })
    if (!res.ok) return ''
    const data = await res.json()
    return data.choices?.[0]?.message?.content || ''
  } catch { return '' }
}

async function runQuickSync() {
  if (syncRunning) return
  try {
    const { quickSync } = await import('../../../../mcp-server/src/feishu/sync')
    const { getDb } = await import('../../../../mcp-server/src/db')
    const result = await quickSync()
    if (result.imported > 0) {
      lastResult = { ...lastResult, quickImported: result.imported, quickAt: new Date().toLocaleTimeString() }
      console.log(`[快速同步] 新消息 ${result.imported} 条`)
      // macOS 系统通知
      try {
        const { execSync } = await import('child_process')
        execSync(`osascript -e 'display notification "收到 ${result.imported} 条新飞书消息" with title "Social Proxy" sound name "Ping"'`)
      } catch {}

      // 为没有建议的新消息生成 AI 建议
      const db = getDb()
      const pending = db.prepare(
        `SELECT id, message_id, contact_name, incoming_content FROM reply_suggestions WHERE suggestion IS NULL AND is_read = 0 LIMIT 10`
      ).all() as any[]

      for (const row of pending) {
        const history = db.prepare(
          `SELECT direction, content FROM messages WHERE contact_name = ? ORDER BY timestamp DESC LIMIT 10`
        ).all(row.contact_name).reverse()
        const suggestion = await generateSuggestion(row.contact_name, history, row.incoming_content)
        if (suggestion) {
          db.prepare(`UPDATE reply_suggestions SET suggestion = ? WHERE id = ?`).run(suggestion, row.id)
        }
      }
    }
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
    const { syncFeishu } = await import('../../../../mcp-server/src/feishu/sync')
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
