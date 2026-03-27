// GET /api/search — 搜索消息（统一多平台模型）
import { NextRequest, NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const keyword = req.nextUrl.searchParams.get('q') || ''
  const contactName = req.nextUrl.searchParams.get('contact') || undefined
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '30'), 100)

  if (!keyword) {
    return NextResponse.json({ results: [] })
  }

  const results = contactName
    ? await query(`
        SELECT t.name as contact_name, m.direction, m.content, m.timestamp
        FROM messages m
        JOIN threads t ON m.thread_id = t.id AND t.user_id = ?
        WHERE t.name = ? AND m.content LIKE ? AND m.user_id = ?
        ORDER BY m.timestamp DESC LIMIT ?
      `, [userId, contactName, `%${keyword}%`, userId, limit])
    : await query(`
        SELECT t.name as contact_name, m.direction, m.content, m.timestamp
        FROM messages m
        JOIN threads t ON m.thread_id = t.id AND t.user_id = ?
        WHERE m.content LIKE ? AND m.user_id = ?
        ORDER BY m.timestamp DESC LIMIT ?
      `, [userId, `%${keyword}%`, userId, limit])

  return NextResponse.json({ results })
}
