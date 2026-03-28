// POST /api/send/email — 发送邮件（统一多平台模型）
import { NextRequest, NextResponse } from 'next/server'
import nodemailer from 'nodemailer'
import { query, queryOne, exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { getOrCreateChannel, getOrCreateThread, insertUnifiedMessage, updateContactStats } from '@/lib/sync-helpers'

export async function POST(req: NextRequest) {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const { contact_name, subject, body } = await req.json()

  if (!contact_name || !body) {
    return NextResponse.json({ error: '缺少 contact_name 和 body' }, { status: 400 })
  }

  // Look up contact
  const contact = await queryOne<{ id: number; name: string }>(
    'SELECT id, name FROM contacts WHERE name = ? AND user_id = ?', [contact_name, userId]
  )
  if (!contact) {
    return NextResponse.json({ success: false, message: `联系人"${contact_name}"不存在` }, { status: 404 })
  }

  // Get email from contact_identities（优先 gmail channel 的）
  const emailRow = await queryOne<{ email: string }>(
    `SELECT ci.email
     FROM contact_identities ci
     JOIN contacts c ON ci.contact_id = c.id
     WHERE c.name = ? AND c.user_id = ? AND ci.email IS NOT NULL AND ci.email != ''
     ORDER BY ci.id ASC
     LIMIT 1`,
    [contact_name, userId]
  )
  const email = emailRow?.email

  if (!email) {
    return NextResponse.json({ success: false, message: `"${contact_name}"没有邮箱` }, { status: 400 })
  }

  const emailSubject = subject || body.slice(0, 30).replace(/\n/g, ' ') + (body.length > 30 ? '...' : '')

  // Check permission mode
  const modeRow = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'permission_mode' AND user_id = ?", [userId]
  )
  if ((modeRow?.value || 'suggest') === 'suggest') {
    return NextResponse.json({
      success: true,
      mode: 'suggest',
      message: '建议模式：请确认后发送',
      draft: { to: email, subject: emailSubject, body },
    })
  }

  // Send via SMTP
  const getSetting = async (key: string) => {
    const row = await queryOne<{ value: string }>(
      'SELECT value FROM settings WHERE key = ? AND user_id = ?', [key, userId]
    )
    return row?.value || ''
  }

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

    // Record sent message — find or create thread
    const now = new Date().toISOString()
    const channel = await getOrCreateChannel(userId, 'gmail', 'Gmail')
    const thread = await getOrCreateThread(userId, channel.id, `email:${email}`, contact_name, 'email_thread')

    await insertUnifiedMessage(userId, thread.id, channel.id, {
      direction: 'sent',
      senderName: '我',
      content: `[邮件] 主题: ${emailSubject}\n\n${body}`,
      msgType: 'email',
      timestamp: now,
      platformMsgId: `sent:${Date.now()}`,
      metadata: { subject: emailSubject, to: email },
    })

    await updateContactStats(userId, contact_name, now)

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
