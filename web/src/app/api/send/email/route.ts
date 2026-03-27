// POST /api/send/email — 发送邮件（统一多平台模型）
import { NextRequest, NextResponse } from 'next/server'
import nodemailer from 'nodemailer'
import { queryOne, exec } from '@/lib/db'
import { getSetting } from '@/lib/feishu'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { contact_name, subject, body } = await req.json()

  if (!contact_name || !body) {
    return NextResponse.json({ error: '缺少 contact_name 和 body' }, { status: 400 })
  }

  // Look up contact
  const contact = await queryOne<{ name: string }>(
    'SELECT name FROM contacts WHERE name = ? AND user_id = ?', [contact_name, userId]
  )

  if (!contact) {
    return NextResponse.json({ success: false, message: `联系人"${contact_name}"不存在` }, { status: 404 })
  }

  // Get email from contact_identities
  const emailRow = await queryOne<{ email: string }>(
    `SELECT ci.email
     FROM contact_identities ci
     JOIN contacts c ON ci.contact_id = c.id
     WHERE c.name = ? AND c.user_id = ? AND ci.email IS NOT NULL AND ci.email != ''
     LIMIT 1`,
    [contact_name, userId]
  )
  const email = emailRow?.email

  if (!email) {
    return NextResponse.json({ success: false, message: `"${contact_name}"没有邮箱` }, { status: 400 })
  }

  const emailSubject = subject || body.slice(0, 30).replace(/\n/g, ' ') + (body.length > 30 ? '...' : '')

  // Check permission mode
  const mode = await getSetting('permission_mode') || 'suggest'
  if (mode === 'suggest') {
    return NextResponse.json({
      success: true,
      mode: 'suggest',
      message: '建议模式：请确认后发送',
      draft: { to: email, subject: emailSubject, body },
    })
  }

  // Send via SMTP
  const smtpHost = await getSetting('smtp_host')
  const smtpUser = await getSetting('smtp_user')
  if (!smtpHost || !smtpUser) {
    return NextResponse.json({ success: false, message: 'SMTP 未配置' }, { status: 500 })
  }

  try {
    const smtpPort = await getSetting('smtp_port')
    const smtpPass = await getSetting('smtp_pass')
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort || '587', 10),
      secure: smtpPort === '465',
      auth: { user: smtpUser, pass: smtpPass },
    })

    const fromName = await getSetting('smtp_from_name')
    await transporter.sendMail({
      from: fromName ? `"${fromName}" <${smtpUser}>` : smtpUser,
      to: email,
      subject: emailSubject,
      text: body,
    })

    // Record in messages table — find thread for this contact
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    const thread = await queryOne<{ id: number; channel_id: number }>(
      `SELECT t.id, t.channel_id
       FROM threads t
       JOIN channels ch ON t.channel_id = ch.id
       WHERE ch.platform = 'gmail' AND t.name = ? AND t.user_id = ?
       LIMIT 1`,
      [contact_name, userId]
    )

    const msgContent = `[邮件] 主题: ${emailSubject}\n\n${body}`
    if (thread) {
      await exec(
        `INSERT INTO messages(user_id, thread_id, channel_id, direction, content, timestamp, msg_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, thread.id, thread.channel_id, 'sent', msgContent, now, 'email']
      )
    } else {
      await exec(
        `INSERT INTO messages(user_id, direction, content, timestamp, msg_type)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, 'sent', msgContent, now, 'email']
      )
    }

    await exec(
      'UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1 WHERE name = ? AND user_id = ?',
      [now, contact_name, userId]
    )

    return NextResponse.json({
      success: true,
      mode: 'sent',
      message: `邮件已发送至 ${email}`,
    })
  } catch (err) {
    return NextResponse.json({
      success: false,
      message: err instanceof Error ? err.message : '发送失败',
    }, { status: 500 })
  }
}
