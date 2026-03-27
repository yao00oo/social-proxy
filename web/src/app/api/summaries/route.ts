// GET /api/summaries — 会话 AI 摘要（统一多平台模型）
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const search = req.nextUrl.searchParams.get('search') || undefined

  const summaries = await query(`
    SELECT t.name as chat_name, s.start_time, s.end_time, s.message_count, s.summary
    FROM summaries s
    JOIN threads t ON s.thread_id = t.id AND t.user_id = ?
    WHERE s.summary IS NOT NULL AND s.user_id = ? ${search ? 'AND (t.name LIKE ? OR s.summary LIKE ?)' : ''}
    ORDER BY s.end_time DESC
  `, search ? [userId, userId, `%${search}%`, `%${search}%`] : [userId, userId])

  return NextResponse.json({ summaries })
}
