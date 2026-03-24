// 微信聊天记录导入脚本
// 用法: npx ts-node src/import.ts ./wechat.txt
// 格式: "2024-01-01 12:00 张三: 消息内容" 或 "2024-01-01 12:00 我: 消息内容"

import fs from 'fs'
import path from 'path'
import { getDb } from './db'

// 匹配行格式：日期 时间 发送者: 内容
// 支持 "2024-01-01 12:00" 和 "2024-01-01 12:00:00" 两种格式
const LINE_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)\s+(.+?):\s+(.+)$/

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

  const runImport = db.transaction(() => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const match = LINE_RE.exec(line)
      if (!match) {
        console.warn(`[跳过第${i + 1}行] 格式不匹配: ${line.slice(0, 60)}`)
        skipped++
        continue
      }

      const [, timestamp, sender, content] = match

      // "我" 表示自己发出的
      const isSelf = sender === '我' || sender === 'Me' || sender === 'me'
      const direction = isSelf ? 'sent' : 'received'
      const contactName = isSelf ? '' : sender

      if (!contactName) {
        // sent 消息没有明确对话对象，跳过（微信群记录里没有 context）
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
