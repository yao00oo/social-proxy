// Tool: send_feishu_message — 通过应用机器人给飞书联系人发消息
// 飞书 API 限制：发消息只支持 tenant_access_token（应用身份），不支持 user_access_token
import { getDb } from '../db'
import { getSetting } from '../feishu/auth'
import { getAppAccessToken, sendMessage } from '../feishu/api'

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

async function getAppToken(): Promise<string> {
  const appId = getSetting('feishu_app_id')
  const appSecret = getSetting('feishu_app_secret')
  if (!appId || !appSecret) throw new Error('未配置飞书 App ID / App Secret，请先在配置页面填写')
  return getAppAccessToken(appId, appSecret)
}

export async function sendFeishuMessage(args: SendFeishuArgs): Promise<SendFeishuResult> {
  const { contact_name, content } = args
  const db = getDb()

  // 1. 确定接收方 open_id：先查 feishu_users（真实姓名），再 fallback 到 contacts
  let receiveId: string | null = null
  let receiveIdType: 'open_id' | 'chat_id' = 'open_id'

  const userRow = db.prepare(`
    SELECT open_id FROM feishu_users WHERE name = ? LIMIT 1
  `).get(contact_name) as { open_id: string } | undefined

  if (userRow) {
    receiveId = userRow.open_id
  } else {
    const contactRow = db.prepare(`
      SELECT feishu_open_id FROM contacts WHERE name = ? AND feishu_open_id IS NOT NULL
    `).get(contact_name) as { feishu_open_id: string } | undefined
    receiveId = contactRow?.feishu_open_id ?? null
  }

  if (!receiveId) {
    // fallback：用 chat_id
    const stateRow = db.prepare(`
      SELECT chat_id FROM feishu_sync_state WHERE chat_name = ? LIMIT 1
    `).get(contact_name) as { chat_id: string } | undefined

    if (!stateRow) {
      return {
        success: false,
        mode: 'sent',
        message: `找不到"${contact_name}"的飞书账号，请先同步飞书记录，或确认姓名与飞书一致。`,
      }
    }
    receiveId = stateRow.chat_id
    receiveIdType = 'chat_id'
  }

  const permissionMode = getSetting('permission_mode') || 'suggest'

  // 2. suggest 模式：返回草稿
  if (permissionMode === 'suggest') {
    return {
      success: true,
      mode: 'suggest',
      message: `[建议模式] 以下是起草的飞书消息（将以应用机器人名义发送），请确认后告诉我"发送"或"修改后发送"。`,
      draft: { to: contact_name, content },
    }
  }

  // 3. auto 模式：用 app_access_token 发（飞书要求，只能机器人发）
  const appToken = await getAppToken()
  const { message_id } = await sendMessage(appToken, receiveId, content, receiveIdType)

  // 4. 写入发送记录
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  db.prepare(`
    INSERT INTO messages(contact_name, direction, content, timestamp, source_id)
    VALUES (?, 'sent', ?, ?, ?)
  `).run(contact_name, content, now, message_id)
  db.prepare(`
    UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1 WHERE name = ?
  `).run(now, contact_name)

  return {
    success: true,
    mode: 'sent',
    message: `飞书消息已发送给 ${contact_name}（通过应用机器人）`,
  }
}
