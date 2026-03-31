// POST /api/agent — 小林 Agent endpoint (真正流式)
import { NextRequest } from 'next/server'
import { runAgent } from '@/lib/agent'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { queryOne } from '@/lib/db'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const body = await req.json()

  // 读用户选择的模型
  const modelSetting = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE user_id = ? AND key = 'agent_model'",
    [userId],
  )
  const modelId = modelSetting?.value || undefined

  let messages = body.messages
  if (Array.isArray(messages)) {
    messages = messages.map((m: any) => {
      if (m.parts && Array.isArray(m.parts)) {
        const text = m.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')
        return { role: m.role, content: text || m.content || '' }
      }
      return { role: m.role, content: m.content || '' }
    }).filter((m: any) => m.role === 'tool' || m.content)
  }

  if (!messages || messages.length === 0) {
    return new Response('No messages', { status: 400 })
  }

  let result
  try {
    result = await runAgent(userId, messages, modelId)
  } catch (err: any) {
    console.error('[agent] runAgent error:', err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of result.fullStream) {
          switch (event.type) {
            case 'tool-call': {
              const toolEvent = { type: 'tool_call', name: event.toolName, args: (event as any).input ?? {} }
              controller.enqueue(encoder.encode(`\n@@TOOL:${JSON.stringify(toolEvent)}@@\n`))
              break
            }
            case 'tool-result': {
              const resultEvent = { type: 'tool_result', name: event.toolName, result: (event as any).output ?? {} }
              controller.enqueue(encoder.encode(`\n@@RESULT:${JSON.stringify(resultEvent)}@@\n`))
              break
            }
            case 'text-delta': {
              controller.enqueue(encoder.encode((event as any).text ?? ''))
              break
            }
          }
        }
      } catch (err: any) {
        controller.enqueue(encoder.encode(`\n[错误: ${err.message}]`))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
