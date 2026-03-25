// 独立后台同步进程 — 每15秒增量同步飞书消息，生成 AI 回复建议
// 运行: DB_PATH=... OPENROUTER_API_KEY=... npx ts-node -r tsconfig-paths/register sync-daemon.ts

import path from 'path'
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, 'social-proxy.db')

import { quickSync } from './mcp-server/src/feishu/sync'
import { getDb } from './mcp-server/src/db'

const INTERVAL_MS = 15000

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
    const data = await res.json() as any
    return data.choices?.[0]?.message?.content || ''
  } catch { return '' }
}

async function tick() {
  try {
    const result = await quickSync()
    if (result.imported > 0) {
      console.log(`[${new Date().toLocaleTimeString()}] 新消息 ${result.imported} 条`)

      // macOS 系统通知
      try {
        const { execSync } = await import('child_process')
        execSync(`osascript -e 'display notification "收到 ${result.imported} 条新飞书消息" with title "Social Proxy" sound name "Ping"'`)
      } catch {}

      // 生成 AI 建议
      const db = getDb()
      const pending = db.prepare(
        `SELECT id, contact_name, incoming_content FROM reply_suggestions WHERE suggestion IS NULL AND is_read = 0 LIMIT 10`
      ).all() as any[]

      for (const row of pending) {
        const history = db.prepare(
          `SELECT direction, content FROM messages WHERE contact_name = ? ORDER BY timestamp DESC LIMIT 10`
        ).all(row.contact_name).reverse()
        const suggestion = await generateSuggestion(row.contact_name, history, row.incoming_content)
        if (suggestion) {
          db.prepare(`UPDATE reply_suggestions SET suggestion = ? WHERE id = ?`).run(suggestion, row.id)
          console.log(`  [建议] ${row.contact_name}: ${suggestion.slice(0, 60)}...`)
        }
      }
    }
  } catch (e: any) {
    console.error(`[错误] ${e.message}`)
  }
}

console.log(`[Social Proxy 同步守护进程] 已启动，每 ${INTERVAL_MS / 1000}s 轮询一次`)
tick()
setInterval(tick, INTERVAL_MS)
