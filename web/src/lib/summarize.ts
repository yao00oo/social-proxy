// Shared summary generation logic — called from /api/summarize and after sync
import { query, queryOne, exec } from '@/lib/db'
import https from 'https'

interface ThreadToSummarize {
  thread_id: number
  thread_name: string
  msg_count: number
  existing_count: number | null
}

interface MessageRow {
  timestamp: string
  sender_name: string | null
  content: string
  direction: string
}

// Call OpenRouter AI to generate summary
async function callAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return ''

  const body = JSON.stringify({
    model: 'deepseek/deepseek-chat',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 500,
  })

  return new Promise((resolve) => {
    const req = https.request(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            resolve(parsed.choices?.[0]?.message?.content || '')
          } catch {
            console.error('[summarize] AI response parse error:', data.slice(0, 200))
            resolve('')
          }
        })
      },
    )
    req.setTimeout(30000, () => {
      req.destroy()
      resolve('')
    })
    req.on('error', (err) => {
      console.error('[summarize] AI request error:', err.message)
      resolve('')
    })
    req.write(body)
    req.end()
  })
}

/**
 * Generate AI summaries for threads that have enough new messages.
 * Returns the number of summaries generated.
 */
export async function generateSummaries(userId: string): Promise<number> {
  console.log(`[summarize] Starting for user ${userId}`)

  // Find threads needing summarization:
  // - >= 5 messages AND (no summary yet OR message_count > summary.message_count + 10)
  const threads = await query<ThreadToSummarize>(
    `SELECT
       m.thread_id,
       t.name AS thread_name,
       COUNT(*)::int AS msg_count,
       s.message_count AS existing_count
     FROM messages m
     JOIN threads t ON t.id = m.thread_id
     LEFT JOIN summaries s ON s.thread_id = m.thread_id AND s.user_id = m.user_id
     WHERE m.user_id = ?
     GROUP BY m.thread_id, t.name, s.message_count
     HAVING COUNT(*) >= 5
       AND (s.message_count IS NULL OR COUNT(*) > s.message_count + 10)
     ORDER BY COUNT(*) DESC
     LIMIT 5`,
    [userId],
  )

  if (threads.length === 0) {
    console.log('[summarize] No threads need summarization')
    return 0
  }

  console.log(`[summarize] Found ${threads.length} threads to summarize`)

  let generated = 0

  for (const thread of threads) {
    try {
      // Fetch last 100 messages for this thread
      const messages = await query<MessageRow>(
        `SELECT timestamp, sender_name, content, direction
         FROM messages
         WHERE user_id = ? AND thread_id = ?
         ORDER BY timestamp DESC
         LIMIT 100`,
        [userId, thread.thread_id],
      )

      if (messages.length === 0) continue

      // Reverse to chronological order
      messages.reverse()

      const startTime = messages[0].timestamp
      const endTime = messages[messages.length - 1].timestamp

      // Format messages for the prompt
      const formatted = messages
        .map((m) => {
          const time = m.timestamp ? m.timestamp.replace('T', ' ').slice(0, 19) : '?'
          const sender = m.sender_name || (m.direction === 'sent' ? '我' : '对方')
          return `[${time} ${sender}] ${m.content}`
        })
        .join('\n')

      const prompt = `你是一个社交关系分析助手。请对以下聊天记录生成简洁的摘要。

会话：${thread.thread_name || '未知会话'}
消息数：${thread.msg_count}
时间范围：${startTime} ~ ${endTime}

聊天记录：
${formatted}

请用中文生成摘要，包含：
1. 主要讨论话题（2-3个）
2. 关键结论或待办事项
3. 关系描述（如果能判断的话）

摘要控制在200字以内。`

      console.log(`[summarize] Generating summary for thread "${thread.thread_name}" (${thread.msg_count} msgs)`)
      const summary = await callAI(prompt)

      if (!summary) {
        console.log(`[summarize] Empty AI response for thread "${thread.thread_name}", skipping`)
        continue
      }

      // Upsert into summaries table
      await exec(
        `INSERT INTO summaries (user_id, thread_id, summary, start_time, end_time, message_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON CONFLICT (user_id, thread_id) DO UPDATE SET
           summary = EXCLUDED.summary,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           message_count = EXCLUDED.message_count,
           updated_at = NOW()`,
        [userId, thread.thread_id, summary, startTime, endTime, thread.msg_count],
      )

      generated++
      console.log(`[summarize] Saved summary for thread "${thread.thread_name}"`)
    } catch (err: any) {
      console.error(`[summarize] Error processing thread ${thread.thread_id}:`, err.message)
    }
  }

  console.log(`[summarize] Done. Generated ${generated} summaries.`)
  return generated
}
