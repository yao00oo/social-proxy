import { getDb } from '../db'

const MAX_OUTPUT_CHARS = 55000

export function getSummaries(userId: string, search?: string) {
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'
  const db = getDb()

  return db.prepare(`
    SELECT chat_name, start_time, end_time, message_count, summary
    FROM chat_summaries
    WHERE summary IS NOT NULL AND user_id = ? ${search ? 'AND (chat_name LIKE ? OR summary LIKE ?)' : ''}
    ORDER BY end_time DESC
  `).all(uid, ...(search ? [`%${search}%`, `%${search}%`] : [])) as any[]
}

export function formatSummaries(summaries: any[]): string {
  const lines: string[] = []
  let charCount = 0

  for (const s of summaries) {
    const line = `【${s.chat_name}】${s.start_time?.slice(0,10)} ~ ${s.end_time?.slice(0,10)} (${s.message_count}条)\n${s.summary}`
    if (charCount + line.length > MAX_OUTPUT_CHARS) {
      lines.push(`\n...(已截断,共 ${summaries.length} 条,显示了 ${lines.length} 条,可用 search 参数缩小范围)`)
      break
    }
    lines.push(line)
    charCount += line.length
  }

  return `共 ${summaries.length} 个会话摘要：\n\n${lines.join('\n\n---\n\n')}`
}
