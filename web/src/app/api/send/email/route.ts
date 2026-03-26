// POST /api/send/email — 发送邮件（移植自 MCP send_email）
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

  const contact = await queryOne<{ name: string; email: string }>(
    'SELECT name, email FROM contacts WHERE name = ?', [contact_name]
  )

  if (!contact) {
    return NextResponse.json({ success: false, message: `联系人"${contact_name}"不存在` }, { status: 404 })
  }
  if (!contact.email) {
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
      draft: { to: contact.email, subject: emailSubject, body },
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
      to: contact.email,
      subject: emailSubject,
      text: body,
    })

    // Record
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    await exec(
      'INSERT INTO messages(contact_name, direction, content, timestamp) VALUES (?, ?, ?, ?)',
      [contact_name, 'sent', `[邮件] 主题: ${emailSubject}\n\n${body}`, now]
    )
    await exec(
      'UPDATE contacts SET last_contact_at = ?, message_count = message_count + 1 WHERE name = ?',
      [now, contact_name]
    )

    return NextResponse.json({
      success: true,
      mode: 'sent',
      message: `邮件已发送至 ${contact.email}`,
    })
  } catch (err) {
    return NextResponse.json({
      success: false,
      message: err instanceof Error ? err.message : '发送失败',
    }, { status: 500 })
  }
}
