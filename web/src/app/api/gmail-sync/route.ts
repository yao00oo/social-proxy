// POST /api/gmail-sync — 用 Gmail API 同步邮件到本地数据库（统一 schema）
// GET  /api/gmail-sync — 查询同步状态
import { NextResponse } from 'next/server'
import { query, queryOne, exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import {
  getOrCreateChannel,
  getOrCreateThread,
  getOrCreateContact,
  getOrCreateContactIdentity,
  insertUnifiedMessage,
  updateContactStats,
} from '@/lib/sync-helpers'

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
// Now reads credentials from channels table instead of settings
async function ensureToken(channelId: number): Promise<string> {
  const row = await queryOne<{ credentials: any }>('SELECT credentials FROM channels WHERE id = ?', [channelId])
  const creds = row?.credentials || {}

  let token = creds.access_token || ''
  const tokenTime = parseInt(creds.token_time || '0')
  const expiresIn = parseInt(creds.expires_in || '3600')
  const refreshToken = creds.refresh_token || ''

  // 提前 5 分钟刷新
  if (Date.now() - tokenTime > (expiresIn - 300) * 1000 && refreshToken) {
    log('刷新 Gmail token...')
    const clientId = creds.client_id || ''
    const clientSecret = creds.client_secret || ''

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
      // Update credentials in channels table
      const newCreds = {
        ...creds,
        access_token: token,
        token_time: Date.now().toString(),
        expires_in: (data.expires_in || 3600).toString(),
      }
      await exec('UPDATE channels SET credentials = ?::jsonb WHERE id = ?', [JSON.stringify(newCreds), channelId])
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
  const emailOnly = raw.trim()
  return { name: emailOnly.split('@')[0], email: emailOnly }
}

function decodeBody(msg: GmailMessage): string {
  const parts = msg.payload.parts || []
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8').trim()
    }
  }
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
      // Get or create the gmail channel
      const channel = await getOrCreateChannel(userId, 'gmail', 'Gmail')
      const channelId = channel.id

      const token = await ensureToken(channelId)

      // Get my email from channel credentials or settings (fallback)
      const credRow = await queryOne<{ credentials: any }>('SELECT credentials FROM channels WHERE id = ?', [channelId])
      const creds = credRow?.credentials || {}
      let myEmail = creds.email || ''
      if (!myEmail) {
        const settingRow = await queryOne<{ value: string }>("SELECT value FROM settings WHERE key='gmail_email' AND user_id = ?", [userId])
        myEmail = settingRow?.value || ''
      }

      // Get last sync timestamp from channels.sync_state
      const syncStateRow = await queryOne<{ sync_state: any }>('SELECT sync_state FROM channels WHERE id = ?', [channelId])
      const syncState = syncStateRow?.sync_state || {}
      const lastSyncTs = parseInt(syncState.last_sync_ts || '0')

      // 构建查询：只拉上次同步后的邮件
      let gmailQuery = 'in:inbox OR in:sent'
      if (lastSyncTs > 0) {
        const afterDate = new Date(lastSyncTs).toISOString().slice(0, 10).replace(/-/g, '/')
        gmailQuery = `(in:inbox OR in:sent) after:${afterDate}`
      }

      log(`搜索邮件: ${gmailQuery}`)
      const msgIds = await fetchMessages(token, gmailQuery, 500)
      log(`找到 ${msgIds.length} 封邮件`)

      // Thread cache: gmail threadId → our thread ID
      const threadCache = new Map<string, number>()

      let imported = 0, skipped = 0
      let maxTs = lastSyncTs
      const newMsgsByContact: Record<string, number> = {}

      for (let i = 0; i < msgIds.length; i++) {
        if (i > 0 && i % 50 === 0) log(`  处理中... ${i}/${msgIds.length}`)

        try {
          const msg = await fetchMessage(token, msgIds[i])
          const ts = parseInt(msg.internalDate)
          const timestamp = new Date(ts).toISOString()
          const subject = getHeader(msg, 'Subject') || '(无主题)'
          const from = parseAddress(getHeader(msg, 'From'))
          const to = parseAddress(getHeader(msg, 'To'))
          const cc = getHeader(msg, 'Cc')

          const isSent = (msg.labelIds || []).includes('SENT')
          const direction: 'sent' | 'received' = isSent ? 'sent' : 'received'
          const contact = isSent ? to : from

          // 跳过自己发给自己的
          if (contact.email === myEmail) { skipped++; continue }

          // 提取正文摘要（截取前 200 字）
          const body = decodeBody(msg)
          const preview = body ? body.slice(0, 200) : ''
          const content = preview
            ? `[邮件] 主题: ${subject}\n${preview}`
            : `[邮件] 主题: ${subject}`

          // Get or create thread (using Gmail threadId as platform_thread_id)
          let threadId: number
          if (threadCache.has(msg.threadId)) {
            threadId = threadCache.get(msg.threadId)!
          } else {
            const thread = await getOrCreateThread(userId, channelId, msg.threadId, subject, 'email_thread')
            threadId = thread.id
            threadCache.set(msg.threadId, threadId)
          }

          // Get or create contact + identity
          const contactRecord = await getOrCreateContact(userId, contact.name)
          await getOrCreateContactIdentity(contactRecord.id, channelId, contact.email, contact.name, contact.email)

          // Insert message
          const inserted = await insertUnifiedMessage(userId, threadId, channelId, {
            direction,
            senderName: isSent ? '我' : contact.name,
            content,
            msgType: 'email',
            timestamp,
            platformMsgId: msg.id,
            metadata: { subject, to: to.email, cc: cc || undefined, from: from.email },
          })

          if (inserted) {
            imported++
            newMsgsByContact[contact.name] = (newMsgsByContact[contact.name] || 0) + 1
            // Update contact stats
            await updateContactStats(userId, contact.name, timestamp)
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

      // 保存同步进度到 channels.sync_state
      if (maxTs > lastSyncTs) {
        const newSyncState = { ...syncState, last_sync_ts: maxTs.toString() }
        await exec('UPDATE channels SET sync_state = ?::jsonb WHERE id = ?', [JSON.stringify(newSyncState), channelId])
      }

      // 统计需要摘要的联系人
      const SUMMARIZE_THRESHOLD = 5
      const needSummarize = Object.entries(newMsgsByContact).filter(([, n]) => n >= SUMMARIZE_THRESHOLD)
      if (needSummarize.length > 0) {
        log(`\n${needSummarize.length} 个联系人有 >=${SUMMARIZE_THRESHOLD} 条新邮件，需更新摘要`)
        for (const [name, count] of needSummarize) {
          log(`  ${name}: ${count} 封新邮件`)
        }
      }

      lastResult = { imported, skipped, total: msgIds.length, needSummarize: needSummarize.length }
      log(`\n同步完成: 导入 ${imported} 封，跳过 ${skipped} 封`)
    } catch (e: any) {
      log(`同步失败: ${e.message}`)
      lastResult = { error: e.message }
    } finally {
      syncRunning = false
    }
  })()

  return NextResponse.json({ started: true })
}
