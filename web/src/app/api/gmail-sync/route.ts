// POST /api/gmail-sync — 用 Gmail API 同步邮件到本地数据库（统一 schema）
// GET  /api/gmail-sync — 查询同步状态
import { NextResponse } from 'next/server'
import { query, queryOne, exec } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import {
  getChannelsByPlatform,
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
    const clientId = process.env.GMAIL_CLIENT_ID || creds.client_id || ''
    const clientSecret = process.env.GMAIL_CLIENT_SECRET || creds.client_secret || ''

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

// 拉取全部邮件 ID（不限数量）
async function fetchAllMessageIds(token: string, q: string): Promise<string[]> {
  const ids: string[] = []
  let pageToken = ''

  while (true) {
    const params = new URLSearchParams({ q, maxResults: '500' })
    if (pageToken) params.set('pageToken', pageToken)

    const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    if (data.error) throw new Error(`Gmail API: ${data.error.message}`)

    for (const m of data.messages || []) ids.push(m.id)
    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }

  return ids
}

async function fetchMessage(token: string, id: string): Promise<GmailMessage> {
  const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.json()
}

const TIMEOUT_MS = 50_000 // Vercel 60s 超时，留 10s 余量

export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  if (syncRunning) return NextResponse.json({ error: '同步中' }, { status: 409 })

  syncRunning = true
  syncLog = []
  lastResult = null

  ;(async () => {
    const startTime = Date.now()
    try {
      const gmailChannels = await getChannelsByPlatform(userId, 'gmail')
      if (gmailChannels.length === 0) throw new Error('未连接 Gmail，请先在设置页授权')

      for (const channel of gmailChannels) {
        const channelId = channel.id
        log(`同步 Gmail 账户: ${channel.name}`)

        const token = await ensureToken(channelId)

        const credRow = await queryOne<{ credentials: any }>('SELECT credentials FROM channels WHERE id = ?', [channelId])
        const creds = credRow?.credentials || {}
        let myEmail = creds.email || ''
        if (!myEmail) {
          const settingRow = await queryOne<{ value: string }>("SELECT value FROM settings WHERE key='gmail_email' AND user_id = ?", [userId])
          myEmail = settingRow?.value || ''
        }

        // 读取同步进度
        const syncStateRow = await queryOne<{ sync_state: any }>('SELECT sync_state FROM channels WHERE id = ?', [channelId])
        const syncState = syncStateRow?.sync_state || {}
        const lastSyncTs = parseInt(syncState.last_sync_ts || '0')
        // pending_ids: 上轮没处理完的邮件 ID 列表
        let pendingIds: string[] = syncState.pending_ids || []

        // 如果没有待处理的 ID，先拉取邮件列表
        if (pendingIds.length === 0) {
          let gmailQuery = 'in:inbox OR in:sent'
          if (lastSyncTs > 0) {
            const afterDate = new Date(lastSyncTs).toISOString().slice(0, 10).replace(/-/g, '/')
            gmailQuery = `(in:inbox OR in:sent) after:${afterDate}`
          }

          log(`搜索邮件: ${gmailQuery}`)
          pendingIds = await fetchAllMessageIds(token, gmailQuery)
          log(`找到 ${pendingIds.length} 封邮件`)

          if (pendingIds.length === 0) {
            lastResult = { imported: 0, skipped: 0, total: 0, done: true }
            log('没有新邮件')
            continue
          }
        } else {
          log(`续传: 还有 ${pendingIds.length} 封待处理`)
        }

        const totalCount = pendingIds.length
        const threadCache = new Map<string, number>()
        let imported = 0, skipped = 0
        let maxTs = lastSyncTs
        let timedOut = false

        for (let i = 0; i < pendingIds.length; i++) {
          // 超时保护
          if (Date.now() - startTime > TIMEOUT_MS) {
            timedOut = true
            pendingIds = pendingIds.slice(i)
            log(`⏱ 接近超时，已处理 ${i}/${totalCount}，剩余 ${pendingIds.length} 封待续传`)
            break
          }

          if (i > 0 && i % 50 === 0) log(`  处理中... ${i}/${totalCount}`)

          try {
            const msg = await fetchMessage(token, pendingIds[i])
            const ts = parseInt(msg.internalDate)
            const timestamp = new Date(ts).toISOString()
            const subject = getHeader(msg, 'Subject') || '(无主题)'
            const from = parseAddress(getHeader(msg, 'From'))
            const to = parseAddress(getHeader(msg, 'To'))
            const cc = getHeader(msg, 'Cc')

            const isSent = (msg.labelIds || []).includes('SENT')
            const direction: 'sent' | 'received' = isSent ? 'sent' : 'received'
            const contact = isSent ? to : from

            if (contact.email === myEmail) { skipped++; continue }

            const body = decodeBody(msg)
            const preview = body ? body.slice(0, 200) : ''
            const content = preview
              ? `[邮件] 主题: ${subject}\n${preview}`
              : `[邮件] 主题: ${subject}`

            let threadId: number
            if (threadCache.has(msg.threadId)) {
              threadId = threadCache.get(msg.threadId)!
            } else {
              const thread = await getOrCreateThread(userId, channelId, msg.threadId, subject, 'email_thread')
              threadId = thread.id
              threadCache.set(msg.threadId, threadId)
            }

            const contactRecord = await getOrCreateContact(userId, contact.name)
            await getOrCreateContactIdentity(contactRecord.id, channelId, contact.email, contact.name, contact.email)

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
              await updateContactStats(userId, contact.name, timestamp)
            } else {
              skipped++
            }

            if (ts > maxTs) maxTs = ts
          } catch (e: any) {
            skipped++
          }

          if (i > 0 && i % 20 === 0) await new Promise(r => setTimeout(r, 100))
        }

        // 保存同步进度
        const newSyncState: any = { ...syncState }
        if (maxTs > lastSyncTs) newSyncState.last_sync_ts = maxTs.toString()

        if (timedOut) {
          // 保存未处理完的 ID 列表，下次续传
          newSyncState.pending_ids = pendingIds
        } else {
          // 全部处理完，清除 pending
          delete newSyncState.pending_ids
          pendingIds = []
        }

        await exec('UPDATE channels SET sync_state = ?::jsonb WHERE id = ?', [JSON.stringify(newSyncState), channelId])

        const done = !timedOut
        lastResult = { imported, skipped, total: totalCount, done, remaining: timedOut ? pendingIds.length : 0 }
        log(`\n${channel.name} 同步${done ? '完成' : '暂停'}: 导入 ${imported} 封，跳过 ${skipped} 封${timedOut ? `，剩余 ${pendingIds.length} 封` : ''}`)
      } // end for gmailChannels
    } catch (e: any) {
      log(`同步失败: ${e.message}`)
      lastResult = { error: e.message }
    } finally {
      syncRunning = false
    }
  })()

  return NextResponse.json({ started: true })
}
