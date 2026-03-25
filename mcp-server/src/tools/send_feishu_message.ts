// Tool: send_feishu_message — 以用户身份给飞书联系人发消息
import { getDb } from '../db'
import { ensureValidToken, getSetting } from '../feishu/auth'
import { sendMessage } from '../feishu/api'

interface SendFeishuArgs {
  contact_name: string
  content: string
}

interface SendFeishuResult {
  success: boolean
  mode: 'sent' | 'suggest'
  message: string
  draft?: {
    to: string
    content: string
  }
}

export async function sendFeishuMessage(args: SendFeishuArgs): Promise<SendFeishuResult> {
  const { contact_name, content } = args
  const db = getDb()

  // 1. 查联系人是否存在
  const contact = db.prepare(`SELECT name FROM contacts WHERE name = ?`).get(contact_name) as
    | { name: string }
    | undefined

  if (!contact) {
    return {
      success: false,
      mode: 'sent',
      message: `找不到联系人"${contact_name}"，请先同步飞书记录。`,
    }
  }

  // 2. 从 feishu_sync_state 查找 p2p 会话 chat_id
  // 优先匹配 p2p，fallback 到 chat_type 为空（历史数据未记录类型）
  const stateRow = (
    db.prepare(`
      SELECT chat_id FROM feishu_sync_state
      WHERE chat_name = ? AND chat_type = 'p2p'
      LIMIT 1
    `).get(contact_name) ??
    db.prepare(`
      SELECT chat_id FROM feishu_sync_state
      WHERE chat_name = ? AND (chat_type IS NULL OR chat_type = '')
      LIMIT 1
    `).get(contact_name)
  ) as { chat_id: string } | undefined

  if (!stateRow) {
    return {
      success: false,
      mode: 'sent',
      message: `未找到与"${contact_name}"的飞书会话，请先完成飞书同步。`,
    }
  }

  const permissionMode = getSetting('permission_mode') || 'suggest'

  // 3. suggest 模式：返回草稿，不发送
  if (permissionMode === 'suggest') {
    return {
      success: true,
      mode: 'suggest',
      message: `[建议模式] 以下是起草的飞书消息，请确认后告诉我"发送"或"修改后发送"。`,
      draft: {
        to: contact_name,
        content,
      },
    }
  }

  // 4. auto 模式：调用飞书 API 发送
  const userToken = await ensureValidToken()
  const { message_id } = await sendMessage(userToken, stateRow.chat_id, content)

  // 5. 写入发送记录，更新 last_contact_at
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

  db.prepare(`
    INSERT INTO messages(contact_name, direction, content, timestamp, source_id)
    VALUES (?, 'sent', ?, ?, ?)
  `).run(contact_name, content, now, message_id)

  db.prepare(`
    UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1
    WHERE name = ?
  `).run(now, contact_name)

  return {
    success: true,
    mode: 'sent',
    message: `飞书消息已发送给 ${contact_name}`,
  }
}
