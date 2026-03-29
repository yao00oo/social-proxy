// POST /api/gmail-sync — Gmail 邮件同步（支持续传，全量拉取）
// GET  /api/gmail-sync — 查询同步状态
import { after } from 'next/server'
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
let syncStartedAt = 0
let syncLog: string[] = []
let lastResult: any = null

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  // 从数据库读状态（serverless 实例间不共享内存）
  const statusRow = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'gmail_sync_status' AND user_id = ?", [userId]
  )
  const dbStatus = statusRow?.value ? JSON.parse(statusRow.value) : null

  // 超时自动解锁
  if (dbStatus?.running && dbStatus?.updatedAt && (Date.now() - dbStatus.updatedAt > 90000)) {
    dbStatus.running = false
    await exec(
      "UPDATE settings SET value = ? WHERE key = 'gmail_sync_status' AND user_id = ?",
      [JSON.stringify(dbStatus), userId]
    )
  }

  return NextResponse.json({
    running: dbStatus?.running || syncRunning,
    log: dbStatus?.log || syncLog.slice(-50),
    lastResult: dbStatus?.lastResult || lastResult,
  })
}

function log(msg: string) { console.log(msg); syncLog.push(msg) }

// 将同步状态持久化到数据库（serverless 实例间共享）
async function persistStatus(userId: string, running: boolean) {
  try {
    await exec(
      `INSERT INTO settings(user_id, key, value) VALUES(?, 'gmail_sync_status', ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      [userId, JSON.stringify({ running, log: syncLog.slice(-50), lastResult, updatedAt: Date.now() })]
    )
  } catch {}
}

// 确保 token 有效，过期则刷新
async function ensureToken(channelId: number): Promise<string> {
  const row = await queryOne<{ credentials: any }>('SELECT credentials FROM channels WHERE id = ?', [channelId])
  const creds = row?.credentials || {}

  let token = creds.access_token || ''
  const tokenTime = parseInt(creds.token_time || '0')
  const expiresIn = parseInt(creds.expires_in || '3600')
  const refreshToken = creds.refresh_token || ''

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

// 解析邮件地址，支持 "Name <email>" 和纯 email，多收件人取第一个
function parseAddress(raw: string): { name: string; email: string } {
  if (!raw) return { name: 'unknown', email: '' }
  // 多个地址取第一个
  const first = raw.split(',')[0].trim()
  const match = first.match(/^"?(.+?)"?\s*<(.+?)>$/)
  if (match) return { name: match[1].trim(), email: match[2].trim().toLowerCase() }
  const emailOnly = first.trim().toLowerCase()
  return { name: emailOnly.split('@')[0], email: emailOnly }
}

function decodeBody(msg: GmailMessage): string {
  // 递归查找 text/plain
  function findTextPart(parts: any[]): string {
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8').trim()
      }
      if (part.parts) {
        const found = findTextPart(part.parts)
        if (found) return found
      }
    }
    return ''
  }

  if (msg.payload.parts) {
    const found = findTextPart(msg.payload.parts)
    if (found) return found
  }
  if (msg.payload.body?.data) {
    return Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8').trim()
  }
  return ''
}

// 拉取全部邮件 ID（分页，不限数量）
async function fetchAllMessageIds(token: string, q: string): Promise<string[]> {
  const ids: string[] = []
  let pageToken = ''
  let page = 0

  while (true) {
    page++
    const params = new URLSearchParams({ maxResults: '500' })
    if (q) params.set('q', q)
    if (pageToken) params.set('pageToken', pageToken)

    const res = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    if (data.error) throw new Error(`Gmail API: ${data.error.message}`)

    const msgs = data.messages || []
    for (const m of msgs) ids.push(m.id)
    log(`  第 ${page} 页: ${msgs.length} 封 (累计 ${ids.length})`)

    if (!data.nextPageToken) break
    pageToken = data.nextPageToken
  }

  return ids
}

// 并发获取邮件详情（10 个一组并发，比逐条快 10 倍，比 batch API 更可靠）
async function fetchMessagesConcurrent(token: string, ids: string[]): Promise<{ messages: GmailMessage[]; errors: number }> {
  const messages: GmailMessage[] = []
  let errors = 0
  const CONCURRENCY = 10

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      chunk.map(id =>
        fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then(r => r.json())
      )
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.id && r.value.payload) {
        messages.push(r.value)
      } else {
        errors++
      }
    }
  }

  return { messages, errors }
}

const TIMEOUT_MS = 50_000

export const maxDuration = 60

export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  // 内存锁（同实例）
  if (syncRunning && (Date.now() - syncStartedAt < 65000)) {
    return NextResponse.json({ error: '同步中' }, { status: 409 })
  }
  // DB 锁（跨实例）
  const dbStatusCheck = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'gmail_sync_status' AND user_id = ?", [userId]
  )
  const dbCheck = dbStatusCheck?.value ? JSON.parse(dbStatusCheck.value) : {}
  if (dbCheck.running && dbCheck.updatedAt && (Date.now() - dbCheck.updatedAt < 90000)) {
    return NextResponse.json({ error: '同步中' }, { status: 409 })
  }

  syncRunning = true
  syncStartedAt = Date.now()
  syncLog = []
  lastResult = null

  // 用 after() 在后台执行同步，POST 立刻返回
  after(async () => {
    await persistStatus(userId, true)
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
        const myEmail = (creds.email || '').toLowerCase()

        // 读取同步进度
        const syncStateRow = await queryOne<{ sync_state: any }>('SELECT sync_state FROM channels WHERE id = ?', [channelId])
        const syncState = syncStateRow?.sync_state || {}
        const lastSyncTs = parseInt(syncState.last_sync_ts || '0')
        let pendingIds: string[] = syncState.pending_ids || []

        // 如果没有待处理的 ID，拉取邮件列表
        if (pendingIds.length === 0) {
          // 不限制 in:inbox OR in:sent，拉取所有邮件
          let gmailQuery = ''
          if (lastSyncTs > 0) {
            const afterDate = new Date(lastSyncTs).toISOString().slice(0, 10).replace(/-/g, '/')
            gmailQuery = `after:${afterDate}`
          }

          log(gmailQuery ? `搜索新邮件: ${gmailQuery}` : '搜索全部邮件...')
          pendingIds = await fetchAllMessageIds(token, gmailQuery)
          log(`共找到 ${pendingIds.length} 封邮件`)

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
        let imported = 0, skipped = 0, errors = 0, selfSkipped = 0
        let maxTs = lastSyncTs
        let timedOut = false
        let processed = 0

        // 分批处理，每批 50 封（用 batch API）
        const BATCH_SIZE = 50

        while (pendingIds.length > 0) {
          if (Date.now() - startTime > TIMEOUT_MS) {
            timedOut = true
            log(`⏱ 接近超时，已处理 ${processed}/${totalCount}，剩余 ${pendingIds.length} 封待续传`)
            break
          }

          const batchIds = pendingIds.slice(0, BATCH_SIZE)

          let messages: GmailMessage[]
          try {
            const result = await fetchMessagesConcurrent(token, batchIds)
            messages = result.messages
            errors += result.errors
            // 成功获取后才从 pendingIds 移除
            pendingIds = pendingIds.slice(BATCH_SIZE)
          } catch (e: any) {
            // 获取失败，保留 batchIds 在 pendingIds 中，下轮重试
            log(`  获取失败: ${e.message}，${batchIds.length} 封将在下轮重试`)
            timedOut = true // 触发保存 pendingIds
            break
          }

          processed += batchIds.length

          for (const msg of messages) {
            try {
              const ts = parseInt(msg.internalDate)
              const timestamp = new Date(ts).toISOString()
              const subject = getHeader(msg, 'Subject') || '(无主题)'
              const from = parseAddress(getHeader(msg, 'From'))
              const to = parseAddress(getHeader(msg, 'To'))
              const cc = getHeader(msg, 'Cc')

              const isSent = (msg.labelIds || []).includes('SENT')
              const direction: 'sent' | 'received' = isSent ? 'sent' : 'received'
              const contact = isSent ? to : from

              if (contact.email === myEmail) { selfSkipped++; continue }
              if (!contact.email) { skipped++; continue }

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
                // #3 修复：只在成功插入时更新 maxTs，避免跳过未处理的消息
                if (ts > maxTs) maxTs = ts
              } else {
                skipped++
                // 已存在的消息也要更新 maxTs（它们已经在 DB 里了）
                if (ts > maxTs) maxTs = ts
              }
            } catch (e: any) {
              errors++
            }
          }

          log(`  处理 ${processed}/${totalCount}: 导入 ${imported}, 已存在 ${skipped}, 自发自 ${selfSkipped}, 错误 ${errors}`)
          await persistStatus(userId, true)
        }

        // 保存同步进度
        const newSyncState: any = { ...syncState }
        if (maxTs > lastSyncTs) newSyncState.last_sync_ts = maxTs.toString()

        if (timedOut) {
          newSyncState.pending_ids = pendingIds
        } else {
          delete newSyncState.pending_ids
        }

        await exec('UPDATE channels SET sync_state = ?::jsonb WHERE id = ?', [JSON.stringify(newSyncState), channelId])

        const done = !timedOut
        lastResult = { imported, skipped, selfSkipped, errors, total: totalCount, done, remaining: timedOut ? pendingIds.length : 0 }
        log(`\n${channel.name} 同步${done ? '完成' : '暂停'}: 导入 ${imported}, 已存在 ${skipped}, 自发自 ${selfSkipped}, 错误 ${errors}${timedOut ? `, 剩余 ${pendingIds.length}` : ''}`)
      }
    } catch (e: any) {
      log(`同步失败: ${e.message}`)
      lastResult = { error: e.message }
    } finally {
      syncRunning = false
      await persistStatus(userId, false)
    }
  })

  return NextResponse.json({ started: true })
}
