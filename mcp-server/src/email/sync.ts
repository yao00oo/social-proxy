// 邮件同步主逻辑 — IMAP 增量拉取收件箱 + 已发送
import { ImapFlow } from 'imapflow'
import { getDb } from '../db'

export interface EmailSyncResult {
  inbox: number
  sent: number
  errors: string[]
}

interface EmailConfig {
  imap_host: string
  imap_port: number
  imap_user: string
  imap_pass: string
  smtp_from_name: string
}

function getEmailConfig(): EmailConfig {
  const db = getDb()
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]
  const cfg: Record<string, string> = {}
  for (const { key, value } of rows) cfg[key] = value

  return {
    imap_host: cfg['imap_host'] || cfg['smtp_host']?.replace('smtp.', 'imap.') || '',
    imap_port: parseInt(cfg['imap_port'] || '993', 10),
    imap_user: cfg['imap_user'] || cfg['smtp_user'] || '',
    imap_pass: cfg['imap_pass'] || cfg['smtp_pass'] || '',
    smtp_from_name: cfg['smtp_from_name'] || '',
  }
}

function initSyncState() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS email_sync_state (
      folder   TEXT PRIMARY KEY,
      last_uid INTEGER DEFAULT 0
    )
  `)
}

// 从邮件地址提取名字："张三 <zhangsan@gmail.com>" → "张三", "zhangsan@gmail.com" → "zhangsan"
function extractName(addr: { name?: string; address?: string }): string {
  if (addr.name) return addr.name.trim()
  if (addr.address) return addr.address.split('@')[0]
  return '未知'
}

function extractEmail(addr: { name?: string; address?: string }): string {
  return addr.address || ''
}

// 解析邮件正文：优先纯文本，回退 HTML 去标签
function parseBody(msg: any): string {
  if (msg.text?.plain) return msg.text.plain.trim()
  if (msg.text?.html) return msg.text.html.replace(/<[^>]+>/g, '').trim()
  return '[无法解析邮件内容]'
}

async function syncFolder(
  client: ImapFlow,
  folder: string,
  direction: 'received' | 'sent',
  myEmail: string,
  onProgress?: (msg: string) => void,
): Promise<number> {
  const db = getDb()
  const log = (msg: string) => { console.log(msg); onProgress?.(msg) }

  // 获取上次同步位置
  const stateRow = db.prepare(
    `SELECT last_uid FROM email_sync_state WHERE folder = ?`
  ).get(folder) as { last_uid: number } | undefined
  const lastUid = stateRow?.last_uid || 0

  const lock = await client.getMailboxLock(folder)
  let imported = 0

  try {
    const status = await client.status(folder, { messages: true, uidNext: true })
    log(`  ${folder}: ${status.messages} 封邮件，从 UID ${lastUid + 1} 开始`)

    if (!status.messages || status.messages === 0) return 0

    // 拉取 lastUid 之后的所有邮件
    const range = lastUid > 0 ? `${lastUid + 1}:*` : '1:*'

    const insertMessage = db.prepare(`
      INSERT OR IGNORE INTO messages(contact_name, direction, content, timestamp, source_id)
      VALUES (?, ?, ?, ?, ?)
    `)
    const upsertContact = db.prepare(`
      INSERT INTO contacts(name, email, last_contact_at, message_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(name) DO UPDATE SET
        message_count = message_count + 1,
        last_contact_at = CASE
          WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at
          ELSE last_contact_at
        END,
        email = CASE
          WHEN email IS NULL OR email = '' THEN excluded.email
          ELSE email
        END
    `)

    let maxUid = lastUid

    for await (const msg of client.fetch(
      { uid: range },
      { envelope: true, uid: true, bodyStructure: true, source: false },
      { uid: true }
    )) {
      if (msg.uid <= lastUid) continue

      const env = msg.envelope
      if (!env || !env.date) continue

      const ts = new Date(env.date).toISOString().replace('T', ' ').slice(0, 19)
      const subject = env.subject || '(无主题)'
      const sourceId = `email:${folder}:${msg.uid}`

      let contactName: string
      let contactEmail: string

      if (direction === 'received') {
        // 收件：发件人是联系人
        const from = env.from?.[0]
        if (!from) continue
        contactName = extractName(from)
        contactEmail = extractEmail(from)
      } else {
        // 已发送：收件人是联系人
        const to = env.to?.[0]
        if (!to) continue
        contactName = extractName(to)
        contactEmail = extractEmail(to)
      }

      // 跳过自己发给自己的
      if (contactEmail === myEmail) continue

      const content = `[邮件] 主题: ${subject}`
      const result = insertMessage.run(contactName, direction, content, ts, sourceId)

      if (result.changes > 0) {
        upsertContact.run(contactName, contactEmail, ts)
        imported++
      }

      if (msg.uid > maxUid) maxUid = msg.uid
    }

    // 更新同步进度
    if (maxUid > lastUid) {
      db.prepare(`
        INSERT INTO email_sync_state(folder, last_uid) VALUES (?, ?)
        ON CONFLICT(folder) DO UPDATE SET last_uid = excluded.last_uid
      `).run(folder, maxUid)
    }

    log(`    → 导入 ${imported} 封`)
  } finally {
    lock.release()
  }

  return imported
}

export async function syncEmail(onProgress?: (msg: string) => void): Promise<EmailSyncResult> {
  const config = getEmailConfig()
  const log = (msg: string) => { console.log(msg); onProgress?.(msg) }
  const result: EmailSyncResult = { inbox: 0, sent: 0, errors: [] }

  if (!config.imap_host || !config.imap_user) {
    throw new Error('IMAP 配置不完整，请在配置页面填写邮件服务器信息')
  }

  initSyncState()

  log(`连接 ${config.imap_host}:${config.imap_port}...`)

  const client = new ImapFlow({
    host: config.imap_host,
    port: config.imap_port,
    secure: config.imap_port === 993,
    auth: {
      user: config.imap_user,
      pass: config.imap_pass,
    },
    logger: false,
  })

  try {
    await client.connect()
    log('已连接')

    // 同步收件箱
    log('同步收件箱...')
    try {
      result.inbox = await syncFolder(client, 'INBOX', 'received', config.imap_user, onProgress)
    } catch (e: any) {
      result.errors.push(`收件箱: ${e.message}`)
      log(`  ⚠ 收件箱错误: ${e.message}`)
    }

    // 同步已发送（不同邮箱服务商文件夹名不同）
    const sentFolders = [
      '[Gmail]/Sent Mail', '[Gmail]/已发邮件',       // Gmail
      'Sent', 'Sent Messages', 'INBOX.Sent',        // 通用
      '已发送', 'Sent Items',                         // QQ / Outlook
    ]

    log('同步已发送邮件...')
    let sentSynced = false
    for (const folder of sentFolders) {
      try {
        result.sent = await syncFolder(client, folder, 'sent', config.imap_user, onProgress)
        sentSynced = true
        break
      } catch {
        // 文件夹不存在，尝试下一个
      }
    }
    if (!sentSynced) {
      // 列出所有文件夹帮助排查
      const mailboxes = await client.list()
      const folders = mailboxes.map(m => m.path).join(', ')
      log(`  ⚠ 未找到已发送文件夹，可用文件夹: ${folders}`)
      result.errors.push(`未找到已发送文件夹`)
    }

    await client.logout()
  } catch (e: any) {
    result.errors.push(e.message)
    log(`⚠ 连接错误: ${e.message}`)
  }

  log(`\n✅ 邮件同步完成: 收件 ${result.inbox} 封，已发送 ${result.sent} 封，${result.errors.length} 个错误`)
  return result
}
