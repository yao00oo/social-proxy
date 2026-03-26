// POST /api/messages/read — 标记消息已读
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { ids } = await req.json()
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: '需要提供消息 ID 列表' }, { status: 400 })
  }

  const db = getDb()
  db.prepare(
    `UPDATE reply_suggestions SET is_read = 1 WHERE id IN (${ids.map(() => '?').join(',')})`
  ).run(...ids)

  return NextResponse.json({ success: true, count: ids.length })
}
