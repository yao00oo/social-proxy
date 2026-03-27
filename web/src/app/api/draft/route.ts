// POST /api/draft — AI 生成消息草稿（通过 OpenRouter）
import { NextRequest } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || ''

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { contact_id, intent, tone } = await req.json()

  if (!contact_id || !intent) {
    return new Response(JSON.stringify({ error: '缺少 contact_id 和 intent' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (!OPENROUTER_KEY) {
    return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY 未配置' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const contactName = typeof contact_id === 'number'
    ? (await queryOne<{ name: string }>('SELECT name FROM contacts WHERE id = ? AND user_id = ?', [contact_id, userId]))?.name
    : contact_id

  // Get recent messages for context
  const recentMsgs = await query<any>(`
    SELECT direction, content, timestamp FROM messages
    WHERE contact_name = ? AND user_id = ? ORDER BY timestamp DESC LIMIT 10
  `, [contactName || '', userId])

  // Get summary
  const summaryRow = await queryOne<{ summary: string }>(
    `SELECT summary FROM chat_summaries WHERE chat_name = ? AND user_id = ? AND summary IS NOT NULL`,
    [contactName || '', userId]
  )

  const context = [
    summaryRow?.summary ? `关系摘要：${summaryRow.summary}` : '',
    recentMsgs.length > 0
      ? `最近聊天：\n${recentMsgs.reverse().map(m => `[${m.direction === 'sent' ? '我' : contactName}] ${m.content}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n')

  const prompt = `你是一个社交助手。用户想给"${contactName}"发消息。

${context}

用户意图：${intent}
语气：${tone || '随意'}

请生成3个版本的消息草稿，用JSON数组格式返回：
[{"version":1,"content":"消息内容","tone_label":"语气标签"},...]

要求：
- 符合中文社交习惯
- 自然、不生硬
- 3个版本语气递进（随意→正式）`

  // Call OpenRouter API (compatible with OpenAI format)
  const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat-v3-0324',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!orRes.ok) {
    const errText = await orRes.text()
    return new Response(JSON.stringify({ error: `OpenRouter 错误: ${errText.slice(0, 200)}` }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Stream SSE from OpenRouter → plain text to frontend
  const encoder = new TextEncoder()
  const reader = orRes.body!.getReader()
  const decoder = new TextDecoder()

  const readable = new ReadableStream({
    async start(controller) {
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Parse SSE lines
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            const content = parsed.choices?.[0]?.delta?.content
            if (content) {
              controller.enqueue(encoder.encode(content))
            }
          } catch {
            // skip unparseable
          }
        }
      }
      controller.close()
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    },
  })
}
