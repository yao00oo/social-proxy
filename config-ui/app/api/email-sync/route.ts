// API: POST /api/email-sync — 触发邮件 IMAP 同步
// GET  /api/email-sync — 查询同步状态
import { NextResponse } from 'next/server'
import { ImapFlow } from 'imapflow'
import { getDb } from '@/lib/db'

let syncRunning = false
let syncLog: string[] = []
let lastResult: any = null

export async function GET() {
  return NextResponse.json({
    running: syncRunning,
    log: syncLog.slice(-50),
    lastResult,
  })
}

function log(msg: string) {
  console.log(msg)
  syncLog.push(msg)
}

function extractName(addr: { name?: string; address?: string }): string {
  if (addr.name) return addr.name.trim()
  if (addr.address) return addr.address.split('@')[0]
  return '未知'
}

function extractEmail(addr: { name?: string; address?: string }): string {
  return addr.address || ''
}

async function syncFolder(
  client: ImapFlow,
  folder: string,
  direction: 'received' | 'sent',
  myEmail: string,
): Promise<number> {
  const db = getDb()

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_sync_state (
      folder   TEXT PRIMARY KEY,
      last_uid INTEGER DEFAULT 0
    )
  `)

  // source_id unique index
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source ON messages(source_id) WHERE source_id IS NOT NULL`)

  const stateRow = db.prepare(
    `SELECT last_uid FROM email_sync_state WHERE folder = ?`
  ).get(folder) as { last_uid: number } | undefined
  const lastUid = stateRow?.last_uid || 0

  const lock = await client.getMailboxLock(folder)
  let imported = 0

  try {
    const status = await client.status(folder, { messages: true })
    log(`  ${folder}: ${status.messages} 封邮件，从 UID ${lastUid + 1} 开始`)

    if (!status.messages || status.messages === 0) return 0

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
      { envelope: true, uid: true },
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
        const from = env.from?.[0]
        if (!from) continue
        contactName = extractName(from)
        contactEmail = extractEmail(from)
      } else {
        const to = env.to?.[0]
        if (!to) continue
        contactName = extractName(to)
        contactEmail = extractEmail(to)
      }

      if (contactEmail === myEmail) continue

      const content = `[邮件] 主题: ${subject}`
      const result = insertMessage.run(contactName, direction, content, ts, sourceId)

      if (result.changes > 0) {
        upsertContact.run(contactName, contactEmail, ts)
        imported++
      }

      if (msg.uid > maxUid) maxUid = msg.uid
    }

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

export async function POST() {
  if (syncRunning) {
    return NextResponse.json({ error: '同步正在进行中' }, { status: 409 })
  }

  syncRunning = true
  syncLog = []
  lastResult = null

  ;(async () => {
    try {
      const db = getDb()
      const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]
      const cfg: Record<string, string> = {}
      for (const { key, value } of rows) cfg[key] = value

      const imapHost = cfg['imap_host'] || cfg['smtp_host']?.replace('smtp.', 'imap.') || ''
      const imapPort = parseInt(cfg['imap_port'] || '993', 10)
      const imapUser = cfg['imap_user'] || cfg['smtp_user'] || ''
      const imapPass = cfg['imap_pass'] || cfg['smtp_pass'] || ''

      if (!imapHost || !imapUser) {
        throw new Error('IMAP 配置不完整，请先配置邮件服务器信息')
      }

      log(`连接 ${imapHost}:${imapPort}...`)

      const client = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: imapPort === 993,
        auth: { user: imapUser, pass: imapPass },
        logger: false,
      })

      await client.connect()
      log('已连接')

      let inbox = 0, sent = 0
      const errors: string[] = []

      // 同步收件箱
      log('同步收件箱...')
      try {
        inbox = await syncFolder(client, 'INBOX', 'received', imapUser)
      } catch (e: any) {
        errors.push(`收件箱: ${e.message}`)
        log(`  ⚠ ${e.message}`)
      }

      // 同步已发送
      const sentFolders = [
        '[Gmail]/Sent Mail', '[Gmail]/已发邮件',
        'Sent', 'Sent Messages', 'INBOX.Sent',
        '已发送', 'Sent Items',
      ]

      log('同步已发送邮件...')
      let sentSynced = false
      for (const folder of sentFolders) {
        try {
          sent = await syncFolder(client, folder, 'sent', imapUser)
          sentSynced = true
          break
        } catch {
          // folder doesn't exist, try next
        }
      }
      if (!sentSynced) {
        const mailboxes = await client.list()
        const folders = mailboxes.map(m => m.path).join(', ')
        log(`  ⚠ 未找到已发送文件夹，可用: ${folders}`)
      }

      await client.logout()
      lastResult = { inbox, sent, errors }
      log(`\n✅ 同步完成: 收件 ${inbox} 封，已发送 ${sent} 封`)
    } catch (e: any) {
      log(`❌ ${e.message}`)
      lastResult = { error: e.message }
    } finally {
      syncRunning = false
    }
  })()

  return NextResponse.json({ started: true })
}
