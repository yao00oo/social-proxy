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
let syncStartedAt = 0
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
  sender_type: string // 'user' | 'app' | 'anonymous' | 'unknown' | ''
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
  maxMessages: number = 200, // 每次最多 200 条（4 页），控制单群耗时
): Promise<{ messages: FeishuMessage[]; apiCalls: number }> {
  const messages: FeishuMessage[] = []
  let pageToken = ''
  let pages = 0
  const MAX_PAGES = Math.ceil(maxMessages / 50)

  // 有 startTime = 增量同步（从旧到新追赶）；无 startTime = 首次同步（先拉最新）
  const sortType = startTime ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc'

  while (pages++ < MAX_PAGES) {
    const params: Record<string, string> = {
      container_id: chatId,
      container_id_type: 'chat',
      sort_type: sortType,
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
        sender_type: item.sender?.sender_type || '',
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

  return { messages, apiCalls: pages }
}

// ── 通过飞书通讯录 API 查用户真名 ──
let _appAccessToken: string | null = null
let _appTokenTime = 0

async function getAppToken(userId: string): Promise<string | null> {
  // 缓存 2 小时
  if (_appAccessToken && Date.now() - _appTokenTime < 7000 * 1000) return _appAccessToken
  try {
    const appId = process.env.FEISHU_APP_ID || await getSetting('feishu_app_id', userId)
    const appSecret = process.env.FEISHU_APP_SECRET || await getSetting('feishu_app_secret', userId)
    if (!appId || !appSecret) return null
    const appRes = await feishuPost('/auth/v3/app_access_token/internal', { app_id: appId, app_secret: appSecret })
    if (appRes.code !== 0) return null
    _appAccessToken = appRes.app_access_token
    _appTokenTime = Date.now()
    return _appAccessToken
  } catch { return null }
}

async function fetchUserName(openId: string, userId: string): Promise<string | null> {
  try {
    const appToken = await getAppToken(userId)
    if (!appToken) return null
    const res = await feishuGet(`/contact/v3/users/${openId}`, appToken, { user_id_type: 'open_id' })
    if (res.code !== 0) return null
    return res.data?.user?.name || res.data?.user?.en_name || null
  } catch { return null }
}

// ── Discover p2p chats via search API ──
// 两种策略：1) 关键词搜索覆盖大部分 2) from_ids 按同事搜覆盖纯图片/表情对话
async function discoverP2pChats(
  userToken: string,
  channelId: number,
  userId: string,
  knownChatIds: Set<string>,
  senderNameCache: Map<string, string>,
  timeLimit: number, // 剩余可用时间（ms）
): Promise<Array<{ chat_id: string; name: string }>> {
  const discovered: Array<{ chat_id: string; name: string }> = []
  const foundChatIds = new Set<string>()
  const startTime = Date.now()

  // 搜索 API POST helper
  async function searchP2p(body: any): Promise<string[]> {
    try {
      const bodyStr = JSON.stringify(body)
      const res = await new Promise<any>((resolve, reject) => {
        const https = require('https')
        const req = https.request('https://open.feishu.cn/open-apis/search/v2/message?page_size=50&user_id_type=open_id', {
          method: 'POST',
          headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
        }, (res: any) => {
          let d = ''
          res.on('data', (c: any) => d += c)
          res.on('end', () => { try { resolve(JSON.parse(d)) } catch { reject(new Error('parse error')) } })
        })
        req.on('error', reject)
        req.write(bodyStr)
        req.end()
      })
      return res.code === 0 ? (res.data?.items || []) : []
    } catch { return [] }
  }

  // 从 message_id 提取 chat_id 并确认是 p2p
  async function extractP2pChatId(msgId: string): Promise<{ chat_id: string; name: string } | null> {
    try {
      const msgRes = await feishuGet(`/im/v1/messages/${msgId}`, userToken, {})
      if (msgRes.code !== 0 || !msgRes.data?.items?.[0]) return null
      const chatId = msgRes.data.items[0].chat_id
      if (!chatId || knownChatIds.has(chatId) || foundChatIds.has(chatId)) return null
      foundChatIds.add(chatId)
      // 确认是 p2p
      const chatRes = await feishuGet(`/im/v1/chats/${chatId}`, userToken, {})
      if (chatRes.code !== 0 || chatRes.data?.chat_mode !== 'p2p') return null
      return { chat_id: chatId, name: chatRes.data?.name || chatId }
    } catch { return null }
  }

  // 策略 1：关键词搜索（快速覆盖大部分）
  const keywords = ['好', '的', '了', '嗯', 'ok', '是', '谢', '收到']
  for (const kw of keywords) {
    if (Date.now() - startTime > timeLimit) break
    const msgIds = await searchP2p({ query: kw, chat_type: 'p2p_chat' })
    for (const msgId of msgIds.slice(0, 3)) {
      if (Date.now() - startTime > timeLimit) break
      const result = await extractP2pChatId(msgId)
      if (result) discovered.push(result)
      await new Promise(r => setTimeout(r, 200))
    }
    await new Promise(r => setTimeout(r, 300))
  }

  // 策略 2：按同事 from_ids 搜索（覆盖纯图片/表情的对话）
  const colleagueIds = [...senderNameCache.keys()].filter(id => id.startsWith('ou_'))
  for (const openId of colleagueIds) {
    if (Date.now() - startTime > timeLimit) break
    const msgIds = await searchP2p({ query: '好', chat_type: 'p2p_chat', from_ids: [openId] })
    if (msgIds.length > 0) {
      const result = await extractP2pChatId(msgIds[0])
      if (result) {
        // 用真名替换
        result.name = senderNameCache.get(openId) || result.name
        discovered.push(result)
      }
    }
    await new Promise(r => setTimeout(r, 300))
  }

  return discovered
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

  // 1. 预处理：收集所有需要创建的联系人（去重）
  const userSenders = new Set<string>()
  for (const msg of msgs) {
    if (msg.sender_id && msg.sender_type === 'user' && msg.sender_id !== myUserId) {
      userSenders.add(msg.sender_id)
    }
  }

  // 2. 对 cache 没命中的 sender，通过飞书通讯录 API 查真名
  for (const senderId of userSenders) {
    if (!senderNameCache.has(senderId) && senderId.startsWith('ou_')) {
      const realName = await fetchUserName(senderId, userId)
      if (realName) {
        senderNameCache.set(senderId, realName)
      }
    }
  }

  // 3. 批量创建联系人和身份（每个 sender 只查一次 DB）
  const identityCache = new Map<string, number>()
  for (const senderId of userSenders) {
    const contactName = senderNameCache.get(senderId) || senderId
    const contact = await getOrCreateContact(userId, contactName)
    const identity = await getOrCreateContactIdentity(contact.id, channelId, senderId, contactName)
    identityCache.set(senderId, identity.id)
  }

  // 3. 批量构建 INSERT VALUES（一次写入所有消息）
  const values: string[] = []
  const params: any[] = []
  let paramIdx = 1

  for (const msg of msgs) {
    const ts = toLocalTime(parseInt(msg.create_time))
    const isSelf = msg.sender_id === myUserId
    const direction = isSelf ? 'sent' : 'received'

    let senderDisplay: string
    if (isSelf) {
      senderDisplay = myName || '我'
    } else if (msg.sender_type === 'app' || msg.sender_id.startsWith('cli_')) {
      senderDisplay = '机器人'
    } else if (!msg.sender_id || msg.sender_type === 'unknown' || msg.sender_type === 'anonymous') {
      senderDisplay = '系统消息'
    } else {
      senderDisplay = senderNameCache.get(msg.sender_id) || msg.sender_id
    }

    const senderIdentityId = identityCache.get(msg.sender_id) || null
    const metadata = msg.parent_id ? JSON.stringify({ parent_id: msg.parent_id }) : '{}'

    values.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7}, $${paramIdx+8}, $${paramIdx+9}::jsonb)`)
    params.push(userId, threadId, channelId, direction, senderIdentityId, senderDisplay, msg.content, ts, msg.message_id, metadata)
    paramIdx += 10

    if (msg.create_time > newTs) newTs = msg.create_time
  }

  if (values.length === 0) return { imported: 0, newTs }

  // 4. 分批 INSERT（每批 50 条，避免 SQL 过长）
  const BATCH_SIZE = 50
  for (let i = 0; i < values.length; i += BATCH_SIZE) {
    const batchValues = values.slice(i, i + BATCH_SIZE)
    const batchParams = params.slice(i * 10, (i + BATCH_SIZE) * 10)
    // 重新编号参数（$1, $2, ...）
    let idx = 1
    const renumbered = batchValues.map(v => {
      return v.replace(/\$\d+/g, () => `$${idx++}`)
    })
    await exec(
      `INSERT INTO messages (user_id, thread_id, channel_id, direction, sender_identity_id, sender_name, content, timestamp, platform_msg_id, metadata)
       VALUES ${renumbered.join(', ')}
       ON CONFLICT (channel_id, platform_msg_id) DO NOTHING`,
      batchParams,
    )
  }

  // 5. 批量更新联系人统计（按 sender 聚合）
  const lastMsgTs = toLocalTime(parseInt(msgs[msgs.length - 1].create_time))
  for (const senderId of userSenders) {
    const contactName = senderNameCache.get(senderId) || senderId
    await updateContactStats(userId, contactName, lastMsgTs)
  }

  // 6. 修正该 thread 中之前写入的 ou_ sender_name（cache 命中的才修）
  for (const senderId of userSenders) {
    const realName = senderNameCache.get(senderId)
    if (realName && realName !== senderId) {
      await exec(
        'UPDATE messages SET sender_name = ? WHERE thread_id = ? AND sender_name = ?',
        [realName, threadId, senderId],
      )
    }
  }

  return { imported: values.length, newTs }
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

  const result = { chats: 0, imported: 0, skipped: 0, errors: [] as string[], done: false, remaining: 0, hasMoreHistory: false }
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

    // 2. Load existing threads from DB
    const existingThreads = await query<{ id: number; platform_thread_id: string; last_sync_ts: string }>(
      'SELECT id, platform_thread_id, last_sync_ts FROM threads WHERE user_id = ? AND channel_id = ?',
      [userId, channelId],
    )

    // 3. List all chats (group only — listChats doesn't return p2p)
    log('获取会话列表...')
    const chats = await listChats(userToken)

    // 4. Discover p2p chats via search API (listChats 不返回私聊)
    const timeLeft = TIMEOUT_MS - (Date.now() - startTime)
    if (timeLeft > 15000) {
      log('搜索私聊...')
      const knownIds = new Set(chats.map(c => c.chat_id))
      for (const t of existingThreads) knownIds.add(t.platform_thread_id)
      const p2pChats = await discoverP2pChats(userToken, channelId, userId, knownIds, senderNameCache, Math.min(timeLeft - 15000, 20000))
      if (p2pChats.length > 0) {
        for (const p of p2pChats) {
          chats.push({ chat_id: p.chat_id, name: p.name, chat_type: 'p2p' })
        }
        log(`发现 ${p2pChats.length} 个新私聊`)
      }
    }

    result.chats = chats.length
    log(`共 ${chats.length} 个会话`)
    const threadMap = new Map<string, { id: number; last_sync_ts: string }>()
    for (const t of existingThreads) {
      threadMap.set(t.platform_thread_id, { id: t.id, last_sync_ts: t.last_sync_ts })
    }
    // Only create threads for NEW chats (not in DB yet)
    for (const chat of chats) {
      if (!threadMap.has(chat.chat_id)) {
        const chatType = chat.chat_type === 'p2p' ? 'dm' : 'group'
        const thread = await getOrCreateThread(userId, channelId, chat.chat_id, chat.name, chatType)
        threadMap.set(chat.chat_id, thread)
      }
    }

    // 5. Sort chats: keep original order from listChats (ByActiveTimeDesc)
    //    Most recently active chats sync first, so users see recent messages sooner
    const sortedChats = [...chats]

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

        const { messages: msgs, apiCalls } = await listMessages(userToken, chat.chat_id, msgStartTime)
        apiCallCount += apiCalls
        consecutiveRateLimits = 0

        if (msgs.length === 0) {
          // 没有新消息，标记为已同步（避免下次重复拉）
          if (lastTs === '0') await updateThreadSyncTs(thread.id, String(Date.now()))
          continue
        }

        // 200 条 = 达到 maxMessages 上限，说明这个群还有更多历史消息
        if (msgs.length >= 200) result.hasMoreHistory = true

        const { imported: chatImported, newTs } = await processChatMessages(
          userId, channelId, thread.id, msgs, lastTs, myUserId, senderNameCache, myName,
        )
        await updateThreadSyncTs(thread.id, newTs)

        result.imported += chatImported
        lastResult = { ...result }
        log(`    -> 导入 ${chatImported} 条${msgs.length >= 200 ? '（还有更多）' : ''}`)
      } catch (err: any) {
        if (err instanceof RateLimitError) {
          consecutiveRateLimits++
          result.errors.push(`${chat.name}: 限流`)
          log(`    ⚠ 限流 (${consecutiveRateLimits}/${MAX_CONSECUTIVE_RATE_LIMITS})`)
        } else if (err instanceof TokenExpiredError) {
          log(`    token 过期，刷新后重试...`)
          try {
            userToken = await ensureValidToken(userId)
            const { messages: retryMsgs } = await listMessages(userToken, chat.chat_id, msgStartTime)
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
        const { messages: msgs, apiCalls: callsUsed } = await listMessages(userToken, thread.platform_thread_id, startTime)
        apiCalls += callsUsed
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

  // Mode 2: Quick incremental sync (only already-synced threads, lightweight)
  if (body.quick) {
    if (syncRunning) return NextResponse.json({ ok: true, message: '同步中，跳过' })
    try {
      await quickSync(userId)
      return NextResponse.json({ ok: true })
    } catch {
      return NextResponse.json({ ok: false })
    }
  }

  // Mode 3: Reset and re-sync (delete old data, re-sync from scratch)
  if (body.reset) {
    if (syncRunning) {
      return NextResponse.json({ ok: false, message: '同步正在进行中' }, { status: 409 })
    }
    syncRunning = true; syncStartedAt = Date.now()
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

  // Mode 4: Trigger full sync (runs synchronously within the request)
  // syncRunning 可能因 Vercel 超时卡住（进程被杀但变量未重置），60 秒后自动解锁
  if (syncRunning && (Date.now() - syncStartedAt < 65000)) {
    return NextResponse.json({ ok: false, message: '同步正在进行中' }, { status: 409 })
  }

  syncRunning = true; syncStartedAt = Date.now()
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
