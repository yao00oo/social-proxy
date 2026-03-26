// 回复建议生成 — 对 reply_suggestions 表中 suggestion IS NULL 的记录批量生成 AI 建议

import OpenAI from 'openai'
import { getDb } from '../db'

function getApiKey(): string {
  const envKey = process.env.OPENROUTER_API_KEY
  if (envKey) return envKey
  // fallback: 从 DB settings 读取
  try {
    const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'openrouter_api_key'`).get() as any
    return row?.value || ''
  } catch {
    return ''
  }
}

async function generateOne(
  contactName: string,
  recentHistory: { direction: string; content: string }[],
  incomingMessage: string,
  client: OpenAI,
): Promise<string> {
  const historyText = recentHistory.map(m =>
    `${m.direction === 'sent' ? '我' : contactName}: ${m.content}`
  ).join('\n')

  const prompt = `你是用户的助手，帮助判断飞书消息是否需要回复并提供建议。

联系人：${contactName}
最近对话（最新10条）：
${historyText || '（无历史记录）'}

${contactName}刚发来：${incomingMessage}

请简洁回答：
1. 是否需要回复（是/否）及一句话理由
2. 如需回复，给2-3个简短回复选项（每个不超过50字）

格式：
需要回复：[是/否] — [理由]
选项1：[...]
选项2：[...]`

  const res = await client.chat.completions.create({
    model: 'deepseek/deepseek-chat',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 300,
  })

  return res.choices[0].message.content || ''
}

/**
 * 批量为 reply_suggestions 中 suggestion IS NULL 的记录生成回复建议
 * 如果没有设置 OPENROUTER_API_KEY 则静默跳过
 */
export async function generateReplySuggestions(): Promise<number> {
  const apiKey = getApiKey()
  if (!apiKey) return 0

  const db = getDb()
  const client = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey })

  // 找出需要生成建议的记录（最多处理 20 条，避免一次调用太多）
  const pending = db.prepare(`
    SELECT id, contact_name, incoming_content
    FROM reply_suggestions
    WHERE suggestion IS NULL
    ORDER BY created_at DESC
    LIMIT 20
  `).all() as { id: number; contact_name: string; incoming_content: string }[]

  if (pending.length === 0) return 0

  const updateStmt = db.prepare(`UPDATE reply_suggestions SET suggestion = ? WHERE id = ?`)
  let generated = 0

  for (const row of pending) {
    try {
      const history = db.prepare(`
        SELECT direction, content FROM messages
        WHERE contact_name = ?
        ORDER BY timestamp DESC LIMIT 10
      `).all(row.contact_name).reverse() as { direction: string; content: string }[]

      const suggestion = await generateOne(row.contact_name, history, row.incoming_content, client)
      updateStmt.run(suggestion || '', row.id)
      if (suggestion) generated++
    } catch (e: any) {
      // 单条失败不影响其他，标记为空字符串避免重复处理
      updateStmt.run('', row.id)
      console.error(`[回复建议] ${row.contact_name} 失败: ${e.message}`)
    }
  }

  if (generated > 0) {
    console.error(`[回复建议] 生成了 ${generated} 条回复建议`)
  }
  return generated
}
