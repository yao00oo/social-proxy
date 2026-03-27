// POST /api/messages/read — 标记消息已读
import { NextRequest, NextResponse } from 'next/server'
import { exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { ids } = await req.json()
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: '需要提供消息 ID 列表' }, { status: 400 })
  }

  const placeholders = ids.map(() => '?').join(',')
  await exec(
    `UPDATE messages SET is_read = 1 WHERE id IN (${placeholders}) AND user_id = ?`,
    [...ids, userId]
  )

  return NextResponse.json({ success: true, count: ids.length })
}
