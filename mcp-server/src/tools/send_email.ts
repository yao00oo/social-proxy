// Tool: send_email — 以用户身份给联系人发邮件
import nodemailer from 'nodemailer'
import { getDb } from '../db'

interface SendEmailArgs {
  contact_name: string
  subject: string
  body: string
}

interface SendResult {
  success: boolean
  mode: 'sent' | 'suggest'
  message: string
  draft?: {
    to: string
    subject: string
    body: string
  }
}

export async function sendEmail(userId: string, args: SendEmailArgs): Promise<SendResult> {
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'
  const { contact_name, subject, body } = args
  const db = getDb()

  // 1. 查联系人邮箱
  const contact = db.prepare(`
    SELECT name, email FROM contacts WHERE name = ? AND user_id = ?
  `).get(contact_name, uid) as { name: string; email: string | null } | undefined

  if (!contact) {
    return {
      success: false,
      mode: 'sent',
      message: `找不到联系人"${contact_name}"，请先导入聊天记录或在配置页面添加。`,
    }
  }

  if (!contact.email) {
    return {
      success: false,
      mode: 'sent',
      message: `找不到"${contact_name}"的邮箱，请在配置页面补充联系人邮箱后再试。`,
    }
  }

  // 2. 读取 SMTP 配置
  const settings = db.prepare(`SELECT key, value FROM settings WHERE user_id = ?`).all(uid) as { key: string; value: string }[]
  const cfg: Record<string, string> = {}
  for (const { key, value } of settings) cfg[key] = value

  const permissionMode = cfg['permission_mode'] || 'suggest'

  // 3. suggest 模式：返回草稿，不发送
  if (permissionMode === 'suggest') {
    return {
      success: true,
      mode: 'suggest',
      message: `[建议模式] 以下是起草的邮件，请确认后告诉我"发送"或"修改后发送"。`,
      draft: {
        to: contact.email,
        subject,
        body,
      },
    }
  }

  // 4. auto 模式：直接发送
  if (!cfg['smtp_host'] || !cfg['smtp_user']) {
    return {
      success: false,
      mode: 'sent',
      message: 'SMTP 配置不完整，请先在配置页面填写邮件服务器信息。',
    }
  }

  const transporter = nodemailer.createTransport({
    host: cfg['smtp_host'],
    port: parseInt(cfg['smtp_port'] || '587', 10),
    secure: cfg['smtp_port'] === '465',
    auth: {
      user: cfg['smtp_user'],
      pass: cfg['smtp_pass'],
    },
  })

  await transporter.sendMail({
    from: cfg['smtp_from_name']
      ? `"${cfg['smtp_from_name']}" <${cfg['smtp_user']}>`
      : cfg['smtp_user'],
    to: contact.email,
    subject,
    text: body,
  })

  // 5. 写入发送记录，更新 last_contact_at
  const _d = new Date(), _p = (n: number) => String(n).padStart(2, '0')
  const now = `${_d.getFullYear()}-${_p(_d.getMonth() + 1)}-${_p(_d.getDate())} ${_p(_d.getHours())}:${_p(_d.getMinutes())}:${_p(_d.getSeconds())}`

  db.prepare(`
    INSERT INTO messages(contact_name, direction, content, timestamp, user_id)
    VALUES (?, 'sent', ?, ?, ?)
  `).run(contact_name, `[邮件] 主题: ${subject}\n\n${body}`, now, uid)

  db.prepare(`
    UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1
    WHERE name = ? AND user_id = ?
  `).run(now, contact_name, uid)

  return {
    success: true,
    mode: 'sent',
    message: `邮件已发送至 ${contact.email}`,
  }
}
