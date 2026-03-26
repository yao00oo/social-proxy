// POST /api/gmail-sync — 用 Gmail API 同步邮件到本地数据库
// GET  /api/gmail-sync — 查询同步状态
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

let syncRunning = false
let syncLog: string[] = []
let lastResult: any = null

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  return NextResponse.json({ running: syncRunning, log: syncLog.slice(-50), lastResult })
}

function log(msg: string) { console.log(msg); syncLog.push(msg) }

// 确保 token 有效，过期则刷新
async function ensureToken(): Promise<string> {
  const db = getDb()
  const get = (key: string) => (db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as any)?.value || ''
  const upsert = db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)

  let token = get('gmail_access_token')
  const tokenTime = parseInt(get('gmail_token_time') || '0')
  const expiresIn = parseInt(get('gmail_token_expires') || '3600')
  const refreshToken = get('gmail_refresh_token')

  // 提前 5 分钟刷新
  if (Date.now() - tokenTime > (expiresIn - 300) * 1000 && refreshToken) {
    log('刷新 Gmail token...')
    const clientId = get('gmail_client_id')
    const clientSecret = get('gmail_client_secret')

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    const data = await res.json()
    if (data.access_token) {
      token = data.access_token
      upsert.run('gmail_access_token', token)
      upsert.run('gmail_token_time', Date.now().toString())
      upsert.run('gmail_token_expires', (data.expires_in || 3600).toString())
      log('token 刷新成功')
    } else {
      throw new Error(`刷新 token 失败: ${data.error_description || data.error}`)
    }
  }

  if (!token) throw new Error('未授权 Gmail，请先完成 OAuth 授权')
  return token
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds: string[]
  payload: {
    headers: { name: string; value: string }[]
    body?: { data?: string }
    parts?: any[]
  }
  internalDate: string
}

function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload.headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''
}

// 解析 "张三 <zhangsan@gmail.com>" → { name, email }
function parseAddress(raw: string): { name: string; email: string } {
  const match = raw.match(/^"?(.+?)"?\s*<(.+?)>$/)
  if (match) return { name: match[1].trim(), email: match[2].trim() }
  // 纯邮箱
  const emailOnly = raw.trim()
  return { name: emailOnly.split('@')[0], email: emailOnly }
}

function decodeBody(msg: GmailMessage): string {
  // 尝试从 parts 里找 text/plain
  const parts = msg.payload.parts || []
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8').trim()
    }
  }
  // 回退到 payload.body
  if (msg.payload.body?.data) {
    return Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8').trim()
  }
  return ''
}

async function fetchMessages(token: string, query: string, maxResults = 200): Promise<string[]> {
  const ids: string[] = []
  let pageToken = ''

  while (ids.length < maxResults) {
    const params = new URLSearchParams({ q: query, maxResults: '100' })
    if (pageToken) params.set('pageToken', pageToken)

    const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    if (data.error) throw new Error(`Gmail API: ${data.error.message}`)

    for (const m of data.messages || []) ids.push(m.id)
    if (!data.nextPageToken || ids.length >= maxResults) break
    pageToken = data.nextPageToken
  }

  return ids.slice(0, maxResults)
}

async function fetchMessage(token: string, id: string): Promise<GmailMessage> {
  const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.json()
}

export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  if (syncRunning) return NextResponse.json({ error: '同步中' }, { status: 409 })

  syncRunning = true
  syncLog = []
  lastResult = null

  ;(async () => {
    try {
      const token = await ensureToken()
      const db = getDb()
      const myEmail = (db.prepare(`SELECT value FROM settings WHERE key='gmail_email'`).get() as any)?.value || ''

      // 获取上次同步时间
      db.exec(`CREATE TABLE IF NOT EXISTS email_sync_state (folder TEXT PRIMARY KEY, last_uid INTEGER DEFAULT 0)`)
      const lastSyncRow = db.prepare(`SELECT last_uid FROM email_sync_state WHERE folder='gmail_last_ts'`).get() as any
      const lastSyncTs = lastSyncRow?.last_uid || 0

      // 构建查询：只拉上次同步后的邮件
      let query = 'in:inbox OR in:sent'
      if (lastSyncTs > 0) {
        const afterDate = new Date(lastSyncTs).toISOString().slice(0, 10).replace(/-/g, '/')
        query = `(in:inbox OR in:sent) after:${afterDate}`
      }

      log(`搜索邮件: ${query}`)
      const msgIds = await fetchMessages(token, query, 500)
      log(`找到 ${msgIds.length} 封邮件`)

      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source ON messages(source_id) WHERE source_id IS NOT NULL`)

      const insertMessage = db.prepare(`
        INSERT OR IGNORE INTO messages(contact_name, direction, content, timestamp, source_id)
        VALUES (?, ?, ?, ?, ?)
      `)
      const upsertContact = db.prepare(`
        INSERT INTO contacts(name, email, last_contact_at, message_count)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(name) DO UPDATE SET
          message_count = message_count + 1,
          last_contact_at = CASE WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at ELSE last_contact_at END,
          email = CASE WHEN email IS NULL OR email = '' THEN excluded.email ELSE email END
      `)

      let imported = 0, skipped = 0
      let maxTs = lastSyncTs
      const newMsgsByContact: Record<string, number> = {}

      for (let i = 0; i < msgIds.length; i++) {
        if (i > 0 && i % 50 === 0) log(`  处理中... ${i}/${msgIds.length}`)

        try {
          const msg = await fetchMessage(token, msgIds[i])
          const ts = parseInt(msg.internalDate)
          const _d = new Date(ts), _p = (n: number) => String(n).padStart(2, '0')
          const timestamp = `${_d.getFullYear()}-${_p(_d.getMonth() + 1)}-${_p(_d.getDate())} ${_p(_d.getHours())}:${_p(_d.getMinutes())}:${_p(_d.getSeconds())}`
          const sourceId = `gmail:${msg.id}`
          const subject = getHeader(msg, 'Subject') || '(无主题)'
          const from = parseAddress(getHeader(msg, 'From'))
          const to = parseAddress(getHeader(msg, 'To'))

          const isSent = (msg.labelIds || []).includes('SENT')
          const direction = isSent ? 'sent' : 'received'
          const contact = isSent ? to : from

          // 跳过自己发给自己的
          if (contact.email === myEmail) { skipped++; continue }

          // 提取正文摘要（截取前 200 字）
          const body = decodeBody(msg)
          const preview = body ? body.slice(0, 200) : ''
          const content = preview
            ? `[邮件] 主题: ${subject}\n${preview}`
            : `[邮件] 主题: ${subject}`

          const result = insertMessage.run(contact.name, direction, content, timestamp, sourceId)
          if (result.changes > 0) {
            upsertContact.run(contact.name, contact.email, timestamp)
            imported++
            // 统计每个联系人新增消息数
            newMsgsByContact[contact.name] = (newMsgsByContact[contact.name] || 0) + 1
          } else {
            skipped++
          }

          if (ts > maxTs) maxTs = ts
        } catch (e: any) {
          skipped++
        }

        // 限速：每 20 封暂停 100ms
        if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100))
      }

      // 保存同步进度
      if (maxTs > lastSyncTs) {
        db.prepare(`INSERT INTO email_sync_state(folder, last_uid) VALUES('gmail_last_ts', ?)
          ON CONFLICT(folder) DO UPDATE SET last_uid=excluded.last_uid`).run(maxTs)
      }

      // 统计需要摘要的联系人
      const SUMMARIZE_THRESHOLD = 5
      const needSummarize = Object.entries(newMsgsByContact).filter(([, n]) => n >= SUMMARIZE_THRESHOLD)
      if (needSummarize.length > 0) {
        log(`\n📝 ${needSummarize.length} 个联系人有 ≥${SUMMARIZE_THRESHOLD} 条新邮件，需更新摘要`)
        // 标记到数据库，MCP server 下次调用 get_summaries 时会发现过期
        for (const [name, count] of needSummarize) {
          log(`  ${name}: ${count} 封新邮件`)
        }
      }

      lastResult = { imported, skipped, total: msgIds.length, needSummarize: needSummarize.length }
      log(`\n✅ 同步完成: 导入 ${imported} 封，跳过 ${skipped} 封`)
    } catch (e: any) {
      log(`❌ ${e.message}`)
      lastResult = { error: e.message }
    } finally {
      syncRunning = false
    }
  })()

  return NextResponse.json({ started: true })
}
