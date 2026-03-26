// POST /api/send/feishu — 发送飞书消息（移植自 MCP send_feishu_message）
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getSetting, getAppAccessToken, sendMessage } from '@/lib/feishu'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { contact_name, content } = await req.json()

  if (!contact_name || !content) {
    return NextResponse.json({ error: '缺少 contact_name 和 content' }, { status: 400 })
  }

  const db = getDb()

  // 1. Find receive_id
  let receiveId: string | null = null
  let receiveIdType: 'open_id' | 'chat_id' = 'open_id'

  const userRow = db.prepare(
    'SELECT open_id FROM feishu_users WHERE name = ? LIMIT 1'
  ).get(contact_name) as any
  if (userRow) {
    receiveId = userRow.open_id
  } else {
    const contactRow = db.prepare(
      'SELECT feishu_open_id FROM contacts WHERE name = ? AND feishu_open_id IS NOT NULL'
    ).get(contact_name) as any
    receiveId = contactRow?.feishu_open_id ?? null
  }

  if (!receiveId) {
    const stateRow = db.prepare(
      'SELECT chat_id FROM feishu_sync_state WHERE chat_name = ? LIMIT 1'
    ).get(contact_name) as any
    if (!stateRow) {
      return NextResponse.json({
        success: false,
        message: `找不到"${contact_name}"的飞书账号`,
      }, { status: 404 })
    }
    receiveId = stateRow.chat_id
    receiveIdType = 'chat_id'
  }

  // 2. Check permission mode
  const mode = getSetting('permission_mode') || 'suggest'
  if (mode === 'suggest') {
    return NextResponse.json({
      success: true,
      mode: 'suggest',
      message: '建议模式：请确认后发送',
      draft: { to: contact_name, content },
    })
  }

  // 3. Send via app bot
  try {
    const appToken = await getAppAccessToken()
    const { message_id } = await sendMessage(appToken, receiveId!, content, receiveIdType)

    // 4. Record in messages table
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    db.prepare(
      'INSERT INTO messages(contact_name, direction, content, timestamp, source_id) VALUES (?, ?, ?, ?, ?)'
    ).run(contact_name, 'sent', content, now, message_id)
    db.prepare(
      'UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1 WHERE name = ?'
    ).run(now, contact_name)

    return NextResponse.json({
      success: true,
      mode: 'sent',
      message: `飞书消息已发送给 ${contact_name}`,
      message_id,
    })
  } catch (err) {
    return NextResponse.json({
      success: false,
      message: err instanceof Error ? err.message : '发送失败',
    }, { status: 500 })
  }
}
