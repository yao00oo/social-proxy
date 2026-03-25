// API: POST /api/import — 接收 .txt/.csv 上传，解析微信聊天记录
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

// 旧 TXT 格式：2024-01-01 12:00 张三: 消息内容
const LINE_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s+(.+?):\s+(.+)$/
// 微信电脑端多选复制格式：张三 2024/09/16 2:51 PM  或  张三 2024/09/16 下午2:51
const WECHAT_HEADER_RE = /^(.+?)\s+(\d{4}\/\d{2}\/\d{2}\s+(?:(?:AM|PM|上午|下午|凌晨|晚上)\s*)?\d{1,2}:\d{2}(?:\s*(?:AM|PM|上午|下午|凌晨|晚上))?)$/
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g

// 简易 CSV 行解析（处理引号内的逗号）
function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current); current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

// WeChatMsg CSV 自动检测列索引
function detectCSVColumns(header: string[]): { time: number; sender: number; content: number; type: number } | null {
  const h = header.map(s => s.trim().toLowerCase())
  // WeChatMsg 导出格式：localId, TalkerId, Type, SubType, IsSender, CreateTime, Remark, NickName, Sender, StrContent, ...
  // 或中文列名：消息ID, 发送人, 类型, 子类型, 是否发送, 时间, 备注, 昵称, 发送者, 内容, ...
  const time = h.findIndex(c => c === 'createtime' || c === '时间' || c === 'timestamp' || c === 'create_time')
  const sender = h.findIndex(c => c === 'remark' || c === '备注' || c === 'nickname' || c === '昵称')
  const content = h.findIndex(c => c === 'strcontent' || c === '内容' || c === 'content' || c === 'message')
  const type = h.findIndex(c => c === 'issender' || c === '是否发送' || c === 'is_sender' || c === 'direction')

  if (time === -1 || content === -1) return null
  return { time, sender: sender !== -1 ? sender : -1, content, type }
}

function importCSV(text: string, db: ReturnType<typeof getDb>) {
  const lines = text.split('\n').filter(l => l.trim())
  if (lines.length < 2) return { imported: 0, skipped: 0 }

  const header = parseCSVLine(lines[0])
  const cols = detectCSVColumns(header)

  if (!cols) {
    // 尝试按位置猜测（简单 CSV：时间,发送者,内容）
    if (header.length >= 3) {
      return importSimpleCSV(lines, db)
    }
    return { imported: 0, skipped: 0, error: '无法识别 CSV 列格式' }
  }

  const insertMessage = db.prepare(
    `INSERT INTO messages(contact_name, direction, content, timestamp) VALUES (?, ?, ?, ?)`
  )
  const upsertContact = db.prepare(`
    INSERT INTO contacts(name, email, last_contact_at, message_count) VALUES (?, ?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      message_count = message_count + 1,
      last_contact_at = CASE WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at ELSE last_contact_at END,
      email = CASE WHEN email IS NULL OR email = '' THEN excluded.email ELSE email END
  `)

  let imported = 0, skipped = 0
  const run = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i])
      const content = fields[cols.content]?.trim()
      if (!content) { skipped++; continue }

      // 解析时间：支持 Unix 时间戳或日期字符串
      let timestamp = fields[cols.time]?.trim() || ''
      if (/^\d{10,13}$/.test(timestamp)) {
        const ms = timestamp.length === 10 ? parseInt(timestamp) * 1000 : parseInt(timestamp)
        timestamp = new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
      }
      if (!timestamp) { skipped++; continue }

      // 判断方向
      let isSender = false
      if (cols.type !== -1) {
        const val = fields[cols.type]?.trim().toLowerCase()
        isSender = val === '1' || val === 'true' || val === '是' || val === 'sent'
      }
      const direction = isSender ? 'sent' : 'received'

      // 发送者名称
      const sender = cols.sender !== -1 ? fields[cols.sender]?.trim() : ''
      if (!sender && !isSender) { skipped++; continue }

      // 跳过非文本消息（type 列如果存在且不是 1/text）
      const typeIdx = header.findIndex(h => h.trim().toLowerCase() === 'type' || h.trim().toLowerCase() === '类型')
      if (typeIdx !== -1) {
        const msgType = fields[typeIdx]?.trim()
        if (msgType && msgType !== '1' && msgType !== 'text' && msgType !== '文本') { skipped++; continue }
      }

      const emails = content.match(EMAIL_RE)
      const email = emails ? emails[0] : null
      const contactName = isSender ? (sender || '我') : sender

      if (contactName === '我') { skipped++; continue }

      insertMessage.run(contactName, direction, content, timestamp)
      if (!isSender) upsertContact.run(contactName, email, timestamp)
      imported++
    }
  })
  run()
  return { imported, skipped }
}

// 简单 3 列 CSV：时间,发送者,内容
function importSimpleCSV(lines: string[], db: ReturnType<typeof getDb>) {
  const insertMessage = db.prepare(
    `INSERT INTO messages(contact_name, direction, content, timestamp) VALUES (?, ?, ?, ?)`
  )
  const upsertContact = db.prepare(`
    INSERT INTO contacts(name, email, last_contact_at, message_count) VALUES (?, ?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      message_count = message_count + 1,
      last_contact_at = CASE WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at ELSE last_contact_at END,
      email = CASE WHEN email IS NULL OR email = '' THEN excluded.email ELSE email END
  `)

  let imported = 0, skipped = 0
  const run = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i])
      if (fields.length < 3) { skipped++; continue }
      const [timestamp, sender, content] = fields.map(f => f.trim())
      if (!timestamp || !sender || !content) { skipped++; continue }

      const isSelf = sender === '我' || sender === 'Me' || sender === 'me'
      if (isSelf) { skipped++; continue }

      const emails = content.match(EMAIL_RE)
      insertMessage.run(sender, 'received', content, timestamp)
      upsertContact.run(sender, emails?.[0] || null, timestamp)
      imported++
    }
  })
  run()
  return { imported, skipped }
}

// 把微信复制的时间 "2024/09/16 2:51 PM" 转成标准格式 "2024-09-16 14:51"
function normalizeWechatTime(raw: string): string {
  // 处理 AM/PM 或 上午/下午
  let ts = raw.trim()
  let isPM = false
  let isAM = false
  if (/PM|下午|晚上/i.test(ts)) isPM = true
  if (/AM|上午|凌晨/i.test(ts)) isAM = true
  ts = ts.replace(/\s*(AM|PM|上午|下午|凌晨|晚上)\s*/gi, ' ').trim()

  // 解析 YYYY/MM/DD H:MM
  const m = ts.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})/)
  if (!m) return raw
  let [, y, mo, d, h, min] = m
  let hour = parseInt(h)
  if (isPM && hour < 12) hour += 12
  if (isAM && hour === 12) hour = 0
  return `${y}-${mo}-${d} ${hour.toString().padStart(2, '0')}:${min}`
}

function importTXT(text: string, db: ReturnType<typeof getDb>) {
  const lines = text.split('\n')
  const insertMessage = db.prepare(
    `INSERT INTO messages(contact_name, direction, content, timestamp) VALUES (?, ?, ?, ?)`
  )
  const upsertContact = db.prepare(`
    INSERT INTO contacts(name, email, last_contact_at, message_count) VALUES (?, ?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      message_count = message_count + 1,
      last_contact_at = CASE WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at ELSE last_contact_at END,
      email = CASE WHEN email IS NULL OR email = '' THEN excluded.email ELSE email END
  `)

  // 先检测是不是微信电脑端多选复制的格式（有 YYYY/MM/DD 的 header 行）
  const isWechatFormat = lines.some(l => WECHAT_HEADER_RE.test(l.trim()))

  let imported = 0, skipped = 0

  if (isWechatFormat) {
    // 微信格式：header 行 + 下一行是内容（可能多行内容）
    // 张三 2024/09/16 2:51 PM
    // 消息内容（可能多行）
    const messages: { sender: string; timestamp: string; content: string }[] = []
    let current: { sender: string; timestamp: string; lines: string[] } | null = null

    for (const line of lines) {
      const trimmed = line.trim()
      const headerMatch = WECHAT_HEADER_RE.exec(trimmed)
      if (headerMatch) {
        // 保存上一条消息
        if (current && current.lines.length > 0) {
          messages.push({ sender: current.sender, timestamp: current.timestamp, content: current.lines.join('\n') })
        }
        current = {
          sender: headerMatch[1].trim(),
          timestamp: normalizeWechatTime(headerMatch[2]),
          lines: [],
        }
      } else if (current) {
        // 内容行（包括空行也属于当前消息）
        if (trimmed || current.lines.length > 0) {
          current.lines.push(trimmed)
        }
      }
    }
    // 最后一条
    if (current && current.lines.length > 0) {
      messages.push({ sender: current.sender, timestamp: current.timestamp, content: current.lines.join('\n') })
    }

    const run = db.transaction(() => {
      for (const msg of messages) {
        const isSelf = msg.sender === '我' || msg.sender === 'Me' || msg.sender === 'me'
        const direction = isSelf ? 'sent' : 'received'
        // 跳过非文本消息
        if (/^\[(图片|表情|动画表情|语音|视频|文件|红包|位置|链接)\]$/.test(msg.content.trim())) {
          skipped++; continue
        }
        const emails = msg.content.match(EMAIL_RE)
        insertMessage.run(msg.sender, direction, msg.content, msg.timestamp)
        if (!isSelf) upsertContact.run(msg.sender, emails?.[0] || null, msg.timestamp)
        imported++
      }
    })
    run()
  } else {
    // 旧的单行格式：2024-01-01 12:00 张三: 消息内容
    const run = db.transaction(() => {
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const match = LINE_RE.exec(trimmed)
        if (!match) { skipped++; continue }
        const [, timestamp, sender, content] = match
        const isSelf = sender === '我' || sender === 'Me' || sender === 'me'
        const direction = isSelf ? 'sent' : 'received'
        const emails = content.match(EMAIL_RE)
        insertMessage.run(sender, direction, content, timestamp)
        if (!isSelf) upsertContact.run(sender, emails?.[0] || null, timestamp)
        imported++
      }
    })
    run()
  }

  return { imported, skipped }
}

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const file = formData.get('file') as File | null
  if (!file) {
    return NextResponse.json({ error: '没有上传文件' }, { status: 400 })
  }

  const text = await file.text()
  const db = getDb()
  const isCSV = file.name.endsWith('.csv') || text.trimStart().startsWith('"') || text.split('\n')[0].includes(',')

  const result = isCSV ? importCSV(text, db) : importTXT(text, db)
  return NextResponse.json(result)
}
