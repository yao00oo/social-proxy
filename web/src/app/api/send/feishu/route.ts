// POST /api/send/feishu — 发送飞书消息（统一多平台模型）
import { NextRequest, NextResponse } from 'next/server'
import { queryOne, exec } from '@/lib/db'
import { getSetting, getAppAccessToken, sendMessage } from '@/lib/feishu'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { contact_name, content } = await req.json()

  if (!contact_name || !content) {
    return NextResponse.json({ error: '缺少 contact_name 和 content' }, { status: 400 })
  }

  // 1. Find receive_id via contact_identities (feishu platform)
  let receiveId: string | null = null
  let receiveIdType: 'open_id' | 'chat_id' = 'open_id'

  // Look up feishu identity for this contact
  const identityRow = await queryOne<{ platform_uid: string }>(
    `SELECT ci.platform_uid
     FROM contact_identities ci
     JOIN channels ch ON ci.channel_id = ch.id
     JOIN contacts c ON ci.contact_id = c.id
     WHERE ch.platform = 'feishu' AND c.name = ? AND ch.user_id = ?
     LIMIT 1`,
    [contact_name, userId]
  )
  if (identityRow) {
    receiveId = identityRow.platform_uid
  }

  // Fallback: look up thread (group chat) by name
  if (!receiveId) {
    const threadRow = await queryOne<{ platform_thread_id: string }>(
      `SELECT t.platform_thread_id
       FROM threads t
       JOIN channels ch ON t.channel_id = ch.id
       WHERE ch.platform = 'feishu' AND t.name = ? AND t.user_id = ?
       LIMIT 1`,
      [contact_name, userId]
    )
    if (!threadRow) {
      return NextResponse.json({
        success: false,
        message: `找不到"${contact_name}"的飞书账号`,
      }, { status: 404 })
    }
    receiveId = threadRow.platform_thread_id
    receiveIdType = 'chat_id'
  }

  // 2. Check permission mode
  const mode = await getSetting('permission_mode') || 'suggest'
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
    const appToken = await getAppAccessToken(userId)
    const { message_id } = await sendMessage(appToken, receiveId!, content, receiveIdType)

    // 4. Record in messages table — find thread for this contact
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const thread = await queryOne<{ id: number; channel_id: number }>(
      `SELECT t.id, t.channel_id
       FROM threads t
       JOIN channels ch ON t.channel_id = ch.id
       WHERE ch.platform = 'feishu' AND t.name = ? AND t.user_id = ?
       LIMIT 1`,
      [contact_name, userId]
    )

    if (thread) {
      await exec(
        `INSERT INTO messages(user_id, thread_id, channel_id, direction, content, timestamp, platform_msg_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, thread.id, thread.channel_id, 'sent', content, now, message_id]
      )
    } else {
      await exec(
        `INSERT INTO messages(user_id, direction, content, timestamp, platform_msg_id)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, 'sent', content, now, message_id]
      )
    }

    await exec(
      'UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1 WHERE name = ? AND user_id = ?',
      [now, contact_name, userId]
    )

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
