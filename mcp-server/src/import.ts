// 微信聊天记录导入脚本
// 用法: npx ts-node src/import.ts ./wechat.txt
// 格式: "2024-01-01 12:00 张三: 消息内容" 或 "2024-01-01 12:00 我: 消息内容"

import fs from 'fs'
import path from 'path'
import { getDb } from './db'

// 微信格式：2024-01-01 12:00 张三: 消息内容
const WECHAT_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s+(.+?):\s+(.+)$/
// 微信复制粘贴格式：张三 2024/09/16 2:51 PM\n消息内容（两行一组）
const WECHAT_COPY_RE = /^(.+?)\s+(\d{4}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*$/
// WhatsApp 格式：[3/25/26, 2:30:15 PM] John: Hey  或  3/25/26, 2:30 - John: Hey
const WHATSAPP_RE = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*[AP]?M?)\]?\s*[-–]?\s*(.+?):\s+(.+)$/

// 从文本中提取邮箱地址
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g

function parseWechatFile(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')

  const db = getDb()

  // 统计
  let imported = 0
  let skipped = 0

  // 批量插入用事务，速度快很多
  const insertMessage = db.prepare(`
    INSERT INTO messages(contact_name, direction, content, timestamp)
    VALUES (?, ?, ?, ?)
  `)

  const upsertContact = db.prepare(`
    INSERT INTO contacts(name, email, last_contact_at, message_count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      message_count   = message_count + 1,
      last_contact_at = CASE
        WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at
        ELSE last_contact_at
      END,
      -- 只在 email 为空时才从聊天内容里更新
      email = CASE
        WHEN email IS NULL OR email = '' THEN excluded.email
        ELSE email
      END
  `)

  // 解析 WhatsApp 日期 "3/25/26, 2:30:15 PM" → "2026-03-25 14:30:15"
  function parseWhatsAppDate(raw: string): string {
    const cleaned = raw.replace(/[\[\]]/g, '').trim()
    const m = cleaned.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?/i)
    if (!m) return cleaned
    const [, month, day, yearRaw, hourRaw, min, sec, ampm] = m
    const year = yearRaw.length === 2 ? '20' + yearRaw : yearRaw
    let hour = parseInt(hourRaw)
    if (ampm?.toUpperCase() === 'PM' && hour < 12) hour += 12
    if (ampm?.toUpperCase() === 'AM' && hour === 12) hour = 0
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${String(hour).padStart(2, '0')}:${min}:${sec || '00'}`
  }

  // 解析微信复制粘贴日期 "2024/09/16 2:51 PM" → "2024-09-16 14:51:00"
  function parseWechatCopyDate(raw: string): string {
    const m = raw.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*([AP]M)?/i)
    if (!m) return raw
    const [, year, month, day, hourRaw, min, ampm] = m
    let hour = parseInt(hourRaw)
    if (ampm?.toUpperCase() === 'PM' && hour < 12) hour += 12
    if (ampm?.toUpperCase() === 'AM' && hour === 12) hour = 0
    return `${year}-${month}-${day} ${String(hour).padStart(2, '0')}:${min}:00`
  }

  const selfNames = new Set(['我', 'Me', 'me', 'You'])

  const runImport = db.transaction(() => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      let timestamp: string, sender: string, content: string

      // 尝试微信标准格式
      const wechatMatch = WECHAT_RE.exec(line)
      if (wechatMatch) {
        ;[, timestamp, sender, content] = wechatMatch
      } else {
        // 尝试 WhatsApp 格式
        const waMatch = WHATSAPP_RE.exec(line)
        if (waMatch) {
          timestamp = parseWhatsAppDate(waMatch[1])
          sender = waMatch[2]
          content = waMatch[3]
        } else {
          // 尝试微信复制粘贴格式（两行：名字+时间 / 内容）
          const copyMatch = WECHAT_COPY_RE.exec(line)
          if (copyMatch && i + 1 < lines.length) {
            sender = copyMatch[1]
            timestamp = parseWechatCopyDate(copyMatch[2])
            content = lines[++i].trim()
            if (!content) { skipped++; continue }
          } else {
            skipped++
            continue
          }
        }
      }

      const isSelf = selfNames.has(sender)
      const direction = isSelf ? 'sent' : 'received'
      const contactName = isSelf ? '' : sender

      if (!contactName) {
        skipped++
        continue
      }

      // 尝试从内容里提取邮箱
      const emails = content.match(EMAIL_RE)
      const email = emails ? emails[0] : null

      insertMessage.run(contactName, direction, content, timestamp)
      upsertContact.run(contactName, email, timestamp)

      imported++
    }
  })

  runImport()

  return { imported, skipped }
}

// ── 入口 ──────────────────────────────────────────────
const filePath = process.argv[2]
if (!filePath) {
  console.error('用法: npx ts-node src/import.ts ./wechat.txt')
  process.exit(1)
}

const absPath = path.resolve(filePath)
if (!fs.existsSync(absPath)) {
  console.error(`文件不存在: ${absPath}`)
  process.exit(1)
}

console.log(`开始导入: ${absPath}`)
const { imported, skipped } = parseWechatFile(absPath)
console.log(`✅ 导入完成: 成功 ${imported} 条，跳过 ${skipped} 条`)
