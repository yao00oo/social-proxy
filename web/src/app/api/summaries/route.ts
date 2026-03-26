// GET /api/summaries — 会话 AI 摘要（移植自 MCP get_summaries）
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const search = req.nextUrl.searchParams.get('search') || undefined

  const summaries = await query(`
    SELECT chat_name, start_time, end_time, message_count, summary
    FROM chat_summaries
    WHERE summary IS NOT NULL ${search ? 'AND (chat_name LIKE ? OR summary LIKE ?)' : ''}
    ORDER BY end_time DESC
  `, search ? [`%${search}%`, `%${search}%`] : [])

  return NextResponse.json({ summaries })
}
