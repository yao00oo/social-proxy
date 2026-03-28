// API: POST /api/feishu-sync — 触发飞书消息同步
// GET  /api/feishu-sync — 查询同步状态

// Vercel serverless: extend timeout to 60s (Hobby) or 300s (Pro)
export const maxDuration = 60

import { NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { getSetting } from '@/lib/feishu'
import { query, queryOne, exec } from '@/lib/db'
import {
  getOrCreateChannel,
  getOrCreateThread,
  updateThreadSyncTs,
  getOrCreateContact,
  updateContactStats,
  getOrCreateContactIdentity,
  insertUnifiedMessage,
  buildSenderNameCache,
} from '@/lib/sync-helpers'
import { generateSummaries } from '@/lib/summarize'
import https from 'https'

// ── Module-level state ──
let syncRunning = false
let syncLog: string[] = []
let lastResult: any = null
let autoSyncTimer: ReturnType<typeof setInterval> | null = null
let autoSyncSeconds = 0

// ── Feishu API helpers ──
const BASE = 'https://open.feishu.cn/open-apis'

function request(url: string, options: https.RequestOptions, body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)) }
      })
    })
    req.setTimeout(15000, () => { req.destroy(new Error('request timeout')) })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function feishuPost(path: string, body: object, headers: Record<string, string> = {}): Promise<any> {
  const bodyStr = JSON.stringify(body)
  return request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
      ...headers,
    },
  }, bodyStr)
}

function feishuGet(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`
  return request(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

async function feishuGetWithRetry(path: string, token: string, params: Record<string, string>, maxRetries = 2): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await feishuGet(path, token, params)
    if (res.code === 0 || res.code === 230002 || res.code === 102004) return res
    if (res.code === 99991403) throw new TokenExpiredError(res.msg)
    // 限流：短暂退避 2s, 4s，2次后直接跳过（Vercel 60s 超时，不能等太久）
    if (res.code === 99991400) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      throw new RateLimitError(res.msg)
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 1000))
      continue
    }
    return res
  }
}

class RateLimitError extends Error {
  constructor(msg: string) { super(msg); this.name = 'RateLimitError' }
}

class TokenExpiredError extends Error {
  constructor(msg: string) { super(msg); this.name = 'TokenExpiredError' }
}

// ── Token management ──
async function ensureValidToken(userId: string): Promise<string> {
  const token = await getSetting('feishu_user_access_token', userId)
  const tokenTime = parseInt(await getSetting('feishu_token_time', userId) || '0', 10)
  const refreshTk = await getSetting('feishu_refresh_token', userId)
  const appId = process.env.FEISHU_APP_ID || await getSetting('feishu_app_id', userId)
  const appSecret = process.env.FEISHU_APP_SECRET || await getSetting('feishu_app_secret', userId)

  if (!token) throw new Error('未授权，请先在配置页面完成飞书 OAuth 授权')

  // user_access_token 有效期 2 小时，提前 5 分钟刷新
  const age = Date.now() - tokenTime
  if (age > (2 * 60 - 5) * 60 * 1000 && refreshTk) {
    // Get app access token first
    if (!appId || !appSecret) throw new Error('未配置飞书 App ID / App Secret，请先在设置页面填写')
    const appRes = await feishuPost('/auth/v3/app_access_token/internal', { app_id: appId, app_secret: appSecret })
    if (appRes.code !== 0) throw new Error(`getAppAccessToken: ${appRes.msg}`)
    const appToken = appRes.app_access_token

    // Refresh user token
    const refreshRes = await feishuPost(
      '/authen/v1/oidc/refresh_access_token',
      { grant_type: 'refresh_token', refresh_token: refreshTk },
      { Authorization: `Bearer ${appToken}` },
    )
    if (refreshRes.code !== 0) throw new Error(`refreshToken: ${refreshRes.msg}`)

    const newToken = refreshRes.data.access_token
    const newRefresh = refreshRes.data.refresh_token

    // Save new tokens to settings (per-user)
    const upsertSql = `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`
    await exec(upsertSql, [userId, 'feishu_user_access_token', newToken])
    await exec(upsertSql, [userId, 'feishu_refresh_token', newRefresh])
    await exec(upsertSql, [userId, 'feishu_token_time', Date.now().toString()])

    return newToken
  }

  return token
}

// ── Time helpers ──
function toLocalTime(ms: number): string {
  // 存 ISO 8601 格式，保留时区信息，前端可按用户本地时区显示
  return new Date(ms).toISOString()
}

// ── Message content parsing ──
function parseContent(msgType: string, rawContent: string | undefined, mentions?: any[]): string {
  if (!rawContent) return '[空消息]'
  try {
    const body = JSON.parse(rawContent)
    // 替换 @_user_N 占位符为真实姓名
    function replaceMentions(text: string): string {
      if (!mentions?.length || !text) return text
      for (const m of mentions) {
        if (m.key && m.name) {
          text = text.replaceAll(m.key, `@${m.name}`)
        }
      }
      return text
    }
    switch (msgType) {
      case 'text':
        return replaceMentions(body.text || '[空文本]')
      case 'post': {
        const lines: string[] = []
        const content = body.content || body.zh_cn?.content || []
        for (const line of content) {
          const parts = Array.isArray(line) ? line : [line]
          const text = parts
            .map((p: any) => {
              if (p.tag === 'text') return p.text
              if (p.tag === 'a') return `${p.text}(${p.href})`
              if (p.tag === 'at') return `@${p.user_name || p.user_id}`
              return ''
            })
            .join('')
          if (text) lines.push(text)
        }
        return replaceMentions(lines.join('\n') || '[富文本]')
      }
      case 'image':
        return '[图片]'
      case 'file':
        return `[文件: ${body.file_name || ''}]`
      case 'audio':
        return '[语音]'
      case 'video':
        return '[视频]'
      case 'sticker':
        return '[表情包]'
      case 'interactive':
        return '[卡片消息]'
      default:
        return `[${msgType}]`
    }
  } catch {
    return rawContent?.slice(0, 200) || '[空消息]'
  }
}

// ── Feishu chat / message listing ──
async function listChats(userToken: string): Promise<Array<{ chat_id: string; name: string; chat_type: string }>> {
  const chats: any[] = []
  let pageToken = ''

  while (true) {
    const params: Record<string, string> = { page_size: '100', sort_type: 'ByActiveTimeDesc' }
    if (pageToken) params.page_token = pageToken

    const res = await feishuGet('/im/v1/chats', userToken, params)
    if (res.code !== 0) throw new Error(`listChats failed: ${res.msg}`)

    chats.push(...(res.data.items || []))
    if (!res.data.has_more) break
    pageToken = res.data.page_token
  }

  return chats.map((c: any) => ({
    chat_id: c.chat_id,
    name: c.name || c.chat_id,
    chat_type: c.chat_type || '',
  }))
}

interface FeishuMessage {
  message_id: string
  sender_id: string
  chat_id: string
  create_time: string
  msg_type: string
  content: string
  parent_id?: string
}

async function listMessages(
  userToken: string,
  chatId: string,
  startTime?: string,
  maxMessages: number = 500, // 每次请求最多拉 500 条，大群分多次同步
): Promise<FeishuMessage[]> {
  const messages: FeishuMessage[] = []
  let pageToken = ''
  let pages = 0
  const MAX_PAGES = Math.ceil(maxMessages / 50)

  while (pages++ < MAX_PAGES) {
    const params: Record<string, string> = {
      container_id: chatId,
      container_id_type: 'chat',
      sort_type: 'ByCreateTimeAsc',
      page_size: '50',
    }
    if (startTime) params.start_time = startTime
    if (pageToken) params.page_token = pageToken

    const res = await feishuGetWithRetry('/im/v1/messages', userToken, params)
    if (res.code !== 0) {
      if (res.code === 230002 || res.code === 102004) break
      throw new Error(`listMessages(${chatId}) failed: ${res.msg} (code=${res.code})`)
    }

    for (const item of res.data?.items || []) {
      messages.push({
        message_id: item.message_id,
        sender_id: item.sender?.id || '',
        chat_id: chatId,
        create_time: item.create_time,
        msg_type: item.msg_type,
        content: parseContent(item.msg_type, item.body?.content, item.mentions),
        parent_id: item.parent_id || undefined,
      })
    }

    if (!res.data?.has_more) break
    pageToken = res.data.page_token
  }

  return messages
}

// ── Process messages for a single chat (shared by fullSync and retry) ──
async function processChatMessages(
  userId: string,
  channelId: number,
  threadId: number,
  msgs: FeishuMessage[],
  lastTs: string,
  myUserId: string | undefined,
  senderNameCache: Map<string, string>,
  myName: string | undefined,
): Promise<{ imported: number; newTs: string }> {
  let newTs = lastTs
  let imported = 0

  for (const msg of msgs) {
    const ts = toLocalTime(parseInt(msg.create_time))
    const isSelf = msg.sender_id === myUserId
    const direction = isSelf ? 'sent' : 'received'
    const senderDisplay = isSelf ? (myName || '我') : (senderNameCache.get(msg.sender_id) || msg.sender_id || '未知')

    // Resolve sender contact + identity for non-self messages
    let senderIdentityId: number | undefined
    if (!isSelf && msg.sender_id) {
      const contactName = senderNameCache.get(msg.sender_id) || msg.sender_id
      const contact = await getOrCreateContact(userId, contactName)
      const identity = await getOrCreateContactIdentity(
        contact.id, channelId, msg.sender_id, senderDisplay,
      )
      senderIdentityId = identity.id
      await updateContactStats(userId, contactName, ts)
    }

    // Insert unified message
    await insertUnifiedMessage(userId, threadId, channelId, {
      direction,
      senderName: senderDisplay,
      senderIdentityId,
      content: msg.content,
      msgType: msg.msg_type,
      timestamp: ts,
      platformMsgId: msg.message_id,
      metadata: msg.parent_id ? { parent_id: msg.parent_id } : {},
    })

    imported++
    if (msg.create_time > newTs) newTs = msg.create_time
  }

  return { imported, newTs }
}

// ── Full sync ──
async function fullSync(userId: string) {
  const log = async (msg: string) => {
    console.log(`[feishu-sync] ${msg}`)
    syncLog.push(msg)
    if (syncLog.length > 200) syncLog = syncLog.slice(-100)
    // Persist status to DB so GET can read it from any serverless instance
    try {
      await exec(
        `INSERT INTO settings(user_id, key, value) VALUES(?, 'feishu_sync_status', ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
        [userId, JSON.stringify({ status: 'syncing', running: true, log: syncLog.slice(-50), lastResult: lastResult })]
      )
    } catch {}
  }

  const result = { chats: 0, imported: 0, skipped: 0, errors: [] as string[], done: false, remaining: 0 }
  const startTime = Date.now()
  const TIMEOUT_MS = 50000 // stop 10s before Vercel 60s limit
  const MAX_API_CALLS_PER_REQUEST = 15 // 飞书 listMessages ~50次/分钟，保守控制
  let apiCallCount = 0

  try {
    let userToken = await ensureValidToken(userId)
    const myName = await getSetting('feishu_user_name', userId)
    const myUserId = await getSetting('feishu_user_id', userId)

    // 0. Get or create the feishu channel（用飞书用户名区分多账户）
    const channelName = myName ? `飞书·${myName}` : 'Feishu'
    const channel = await getOrCreateChannel(userId, 'feishu', channelName)
    const channelId = channel.id

    // 1. Build sender name cache from contact_identities
    const senderNameCache = await buildSenderNameCache(userId, channelId)

    // 2. List all chats
    log('获取会话列表...')
    const chats = await listChats(userToken)
    result.chats = chats.length
    log(`共 ${chats.length} 个会话`)

    // 3. Upsert threads for all chats
    const threadMap = new Map<string, { id: number; last_sync_ts: string }>()
    for (const chat of chats) {
      const chatType = chat.chat_type === 'p2p' ? 'dm' : 'group'
      const thread = await getOrCreateThread(userId, channelId, chat.chat_id, chat.name, chatType)
      threadMap.set(chat.chat_id, thread)
    }

    // 4. Sort chats: already synced (has messages, needs incremental) first, then new ones
    //    This way incremental syncs (fast) go first, full history (slow) goes last
    const sortedChats = [...chats].sort((a, b) => {
      const ta = threadMap.get(a.chat_id)!
      const tb = threadMap.get(b.chat_id)!
      const aHas = ta.last_sync_ts !== '0' ? 1 : 0
      const bHas = tb.last_sync_ts !== '0' ? 1 : 0
      return bHas - aHas // synced ones first
    })

    let chatIndex = 0
    let consecutiveRateLimits = 0
    const MAX_CONSECUTIVE_RATE_LIMITS = 3 // 连续 3 次限流就暂停本轮

    for (const chat of sortedChats) {
      // Check timeout
      if (Date.now() - startTime > TIMEOUT_MS) {
        result.remaining = sortedChats.length - chatIndex
        log(`⏱ 接近超时，已处理 ${chatIndex} 个会话，剩余 ${result.remaining} 个`)
        break
      }

      // API 调用量控制（避免触发飞书限流）
      if (apiCallCount >= MAX_API_CALLS_PER_REQUEST) {
        result.remaining = sortedChats.length - chatIndex
        log(`📊 已调用 ${apiCallCount} 次 API，暂停本轮避免限流，剩余 ${result.remaining} 个`)
        break
      }

      // 连续限流太多次，提前退出等下一轮
      if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
        result.remaining = sortedChats.length - chatIndex
        log(`⚠ 连续 ${MAX_CONSECUTIVE_RATE_LIMITS} 次限流，暂停本轮，剩余 ${result.remaining} 个`)
        break
      }

      chatIndex++

      const thread = threadMap.get(chat.chat_id)!
      const lastTs = thread.last_sync_ts || '0'
      const msgStartTime = lastTs !== '0'
        ? String(Math.floor((parseInt(lastTs) - 1000) / 1000))
        : undefined

      const pct = Math.round((chatIndex / sortedChats.length) * 100)
      await log(`  [${pct}%] 同步 ${chatIndex}/${sortedChats.length}: ${chat.name}`)

      try {
        // 动态间隔：刚限流过等5s，正常1.5s（~40次/分钟，留安全余量）
        const waitMs = consecutiveRateLimits > 0 ? 5000 : 1500
        if (chatIndex > 1) await new Promise(r => setTimeout(r, waitMs))

        const msgs = await listMessages(userToken, chat.chat_id, msgStartTime)
        apiCallCount++
        consecutiveRateLimits = 0 // 成功了，重置计数

        if (msgs.length === 0) {
          // 没有新消息，标记为已同步（避免下次重复拉）
          if (lastTs === '0') await updateThreadSyncTs(thread.id, String(Date.now()))
          continue
        }

        const { imported: chatImported, newTs } = await processChatMessages(
          userId, channelId, thread.id, msgs, lastTs, myUserId, senderNameCache, myName,
        )
        await updateThreadSyncTs(thread.id, newTs)

        result.imported += chatImported
        lastResult = { ...result }
        log(`    -> 导入 ${chatImported} 条`)
      } catch (err: any) {
        if (err instanceof RateLimitError) {
          consecutiveRateLimits++
          result.errors.push(`${chat.name}: 限流`)
          log(`    ⚠ 限流 (${consecutiveRateLimits}/${MAX_CONSECUTIVE_RATE_LIMITS})`)
        } else if (err instanceof TokenExpiredError) {
          log(`    token 过期，刷新后重试...`)
          try {
            userToken = await ensureValidToken(userId)
            const retryMsgs = await listMessages(userToken, chat.chat_id, msgStartTime)
            consecutiveRateLimits = 0
            const { imported: retryImported, newTs: retryTs } = await processChatMessages(
              userId, channelId, thread.id, retryMsgs, lastTs, myUserId, senderNameCache, myName,
            )
            await updateThreadSyncTs(thread.id, retryTs)
            result.imported += retryImported
            lastResult = { ...result }
            log(`    -> 重试成功，导入 ${retryImported} 条`)
          } catch (retryErr: any) {
            result.errors.push(`${chat.name}: 重试失败 ${retryErr.message}`)
            log(`    重试失败: ${retryErr.message}`)
          }
        } else {
          const errMsg = `${chat.name}: ${err.message}`
          result.errors.push(errMsg)
          log(`    ${errMsg}`)
        }
      }
    }

    log(`同步完成: ${result.imported} 条消息，${result.errors.length} 个错误`)
  } catch (err: any) {
    log(`同步失败: ${err.message}`)
    result.errors.push(err.message)
  }

  if (!result.remaining) result.done = true
  lastResult = result
  syncRunning = false

  // After sync complete, trigger AI summarization
  if (result.imported > 0) {
    await generateSummaries(userId).catch((err) =>
      console.error('[feishu-sync] summarize error:', err.message)
    )
  }

  // Determine final status
  let finalStatus = 'completed'
  if (result.remaining > 0) finalStatus = 'paused'
  else if (result.errors.length > 0 && result.imported === 0) finalStatus = 'error'
  else if (result.errors.length > 0) finalStatus = 'completed_with_errors'

  // Persist final status
  try {
    await exec(
      `INSERT INTO settings(user_id, key, value) VALUES(?, 'feishu_sync_status', ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      [userId, JSON.stringify({ status: finalStatus, running: false, log: syncLog.slice(-50), lastResult, updatedAt: Date.now() })]
    )
  } catch {}
}

// ── Quick sync (for auto-sync, only recent chats) ──
async function quickSync(userId: string) {
  const log = (msg: string) => {
    console.log(`[feishu-quick-sync] ${msg}`)
    syncLog.push(msg)
    if (syncLog.length > 200) syncLog = syncLog.slice(-100)
  }

  try {
    let userToken = await ensureValidToken(userId)
    const myName = await getSetting('feishu_user_name', userId)
    const myUserId = await getSetting('feishu_user_id', userId)

    // Get or create the feishu channel
    const channelName = myName ? `飞书·${myName}` : 'Feishu'
    const channel = await getOrCreateChannel(userId, 'feishu', channelName)
    const channelId = channel.id

    // Build sender name cache from contact_identities
    const senderNameCache = await buildSenderNameCache(userId, channelId)

    // Only check threads active in last 90 days
    const since = String(Date.now() - 90 * 24 * 60 * 60 * 1000)
    const activeThreads = await query<{ id: number; platform_thread_id: string; name: string; type: string; last_sync_ts: string }>(
      `SELECT id, platform_thread_id, name, type, last_sync_ts
       FROM threads
       WHERE user_id = ? AND channel_id = ? AND last_sync_ts > ?
       ORDER BY last_sync_ts DESC
       LIMIT 100`,
      [userId, channelId, since],
    )

    if (activeThreads.length === 0) {
      log('快速同步: 无活跃会话')
      return
    }

    let imported = 0
    let errors = 0
    let apiCalls = 0
    const MAX_QUICK_API_CALLS = 20 // quickSync 更保守，给 fullSync 留配额

    for (const thread of activeThreads) {
      if (apiCalls >= MAX_QUICK_API_CALLS) break
      try {
        const startTime = String(Math.floor((parseInt(thread.last_sync_ts) - 1000) / 1000))
        const msgs = await listMessages(userToken, thread.platform_thread_id, startTime)
        apiCalls++
        if (msgs.length === 0) continue

        const { imported: chatImported, newTs } = await processChatMessages(
          userId, channelId, thread.id, msgs, thread.last_sync_ts, myUserId, senderNameCache, myName,
        )

        await updateThreadSyncTs(thread.id, newTs)
        imported += chatImported
      } catch (err: any) {
        if (err instanceof RateLimitError) break // 限流就停
        if (err instanceof TokenExpiredError) {
          try { userToken = await ensureValidToken(userId) } catch { /* ignore */ }
        }
        errors++
      }
    }

    log(`快速同步完成: 导入 ${imported} 条, ${errors} 个错误`)
    lastResult = { imported, errors, type: 'quick' }
  } catch (err: any) {
    log(`快速同步失败: ${err.message}`)
  }
}

// ── Route handlers ──

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  // Read sync status from DB (Vercel serverless instances don't share memory)
  const statusRow = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = 'feishu_sync_status' AND user_id = ?`, [userId])
  const dbStatus = statusRow?.value ? JSON.parse(statusRow.value) : null

  return NextResponse.json({
    running: dbStatus?.running || syncRunning,
    log: dbStatus?.log || syncLog.slice(-50),
    lastResult: dbStatus?.lastResult || lastResult,
    autoSync: autoSyncSeconds > 0,
    autoSyncSeconds,
  })
}

export async function POST(req: Request) {
  const userId = await getUserId()
  if (!userId) return unauthorized()
  const body = await req.json().catch(() => ({})) as any

  // Mode 1: Configure auto-sync
  if (body.autoSyncSeconds !== undefined) {
    const newInterval = Number(body.autoSyncSeconds) || 0

    // Clear existing timer
    if (autoSyncTimer) {
      clearInterval(autoSyncTimer)
      autoSyncTimer = null
    }

    autoSyncSeconds = newInterval

    if (newInterval > 0) {
      // Run quickSync immediately, then on interval
      quickSync(userId).catch(console.error)
      autoSyncTimer = setInterval(() => {
        if (!syncRunning) {
          quickSync(userId).catch(console.error)
        }
      }, newInterval * 1000)
    }

    return NextResponse.json({ ok: true, autoSync: newInterval > 0, autoSyncSeconds: newInterval })
  }

  // Mode 2: Reset and re-sync (delete old data, re-sync from scratch)
  if (body.reset) {
    if (syncRunning) {
      return NextResponse.json({ ok: false, message: '同步正在进行中' }, { status: 409 })
    }
    syncRunning = true
    syncLog = ['重置数据，准备重新全量同步...']
    try {
      // Delete messages, contacts, threads for this user
      await exec('DELETE FROM messages WHERE user_id = ?', [userId])
      await exec('DELETE FROM contacts WHERE user_id = ?', [userId])
      await exec('DELETE FROM threads WHERE user_id = ?', [userId])
      syncLog.push('已清空旧数据，开始全量同步...')
      await fullSync(userId)
      return NextResponse.json({ ok: true, message: '重置同步完成', result: lastResult })
    } catch (err: any) {
      syncLog.push(`重置同步异常: ${err.message}`)
      return NextResponse.json({ ok: false, message: err.message, result: lastResult })
    } finally {
      syncRunning = false
    }
  }

  // Mode 3: Trigger full sync (runs synchronously within the request)
  if (syncRunning) {
    return NextResponse.json({ ok: false, message: '同步正在进行中' }, { status: 409 })
  }

  syncRunning = true
  syncLog = ['开始全量同步...']

  try {
    await fullSync(userId)
    return NextResponse.json({ ok: true, message: '同步完成', result: lastResult })
  } catch (err: any) {
    syncLog.push(`同步异常: ${err.message}`)
    return NextResponse.json({ ok: false, message: err.message, result: lastResult })
  } finally {
    syncRunning = false
  }
}
