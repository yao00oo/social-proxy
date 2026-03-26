// GET /api/search — 搜索消息（移植自 MCP search_messages）
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
        SELECT contact_name, direction, content, timestamp
        FROM messages WHERE contact_name = ? AND content LIKE ?
        ORDER BY timestamp DESC LIMIT ?
      `, [contactName, `%${keyword}%`, limit])
    : await query(`
        SELECT contact_name, direction, content, timestamp
        FROM messages WHERE content LIKE ?
        ORDER BY timestamp DESC LIMIT ?
      `, [`%${keyword}%`, limit])

  return NextResponse.json({ results })
}
