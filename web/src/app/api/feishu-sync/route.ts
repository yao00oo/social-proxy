// API: POST /api/feishu-sync — 触发飞书消息同步
// GET  /api/feishu-sync — 查询同步状态

// Vercel serverless: extend timeout to 60s (Hobby) or 300s (Pro)
export const maxDuration = 60

import { NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { getSetting } from '@/lib/feishu'
import { query, queryOne, exec } from '@/lib/db'
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

async function feishuGetWithRetry(path: string, token: string, params: Record<string, string>, maxRetries = 3): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await feishuGet(path, token, params)
    if (res.code === 0 || res.code === 230002 || res.code === 102004) return res
    if (res.code === 99991403) throw new TokenExpiredError(res.msg)
    if (res.code === 99991400) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)))
        continue
      }
      return res
    }
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)))
      continue
    }
    return res
  }
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
  sender_name: string
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
): Promise<FeishuMessage[]> {
  const messages: FeishuMessage[] = []
  let pageToken = ''
  let pages = 0
  const MAX_PAGES = 1000

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
        sender_name: item.sender?.name || item.sender?.id || '未知',
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

  try {
    let userToken = await ensureValidToken(userId)
    const myName = await getSetting('feishu_user_name', userId)
    const myUserId = await getSetting('feishu_user_id', userId)

    // 0. Build sender name cache from feishu_users
    const senderNameCache = new Map<string, string>()
    const cachedUsers = await query<{ open_id: string; name: string }>(
      'SELECT open_id, name FROM feishu_users WHERE user_id = ?', [userId]
    )
    for (const u of cachedUsers) senderNameCache.set(u.open_id, u.name)

    function resolveSenderName(senderId: string, isSelf: boolean): string {
      if (isSelf) return myName || '我'
      return senderNameCache.get(senderId) || senderId || '未知'
    }

    // 1. List all chats
    log('获取会话列表...')
    const chats = await listChats(userToken)
    result.chats = chats.length
    log(`共 ${chats.length} 个会话`)

    // 2. Upsert sync state for all chats
    for (const chat of chats) {
      await exec(
        `INSERT INTO feishu_sync_state (user_id, chat_id, chat_name, chat_type)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, chat_id) DO UPDATE SET chat_name = EXCLUDED.chat_name, chat_type = EXCLUDED.chat_type`,
        [userId, chat.chat_id, chat.name, chat.chat_type],
      )
    }

    // 3. Sync chats in API order (ByActiveTimeDesc — most recently active first)
    const syncStates = await query<{ chat_id: string; last_sync_ts: string }>(
      `SELECT chat_id, last_sync_ts FROM feishu_sync_state WHERE user_id = ?`,
      [userId],
    )
    const stateMap = new Map(syncStates.map(s => [s.chat_id, s.last_sync_ts]))

    let chatIndex = 0
    for (const chat of chats) {
      // Check timeout — stop early if approaching Vercel limit
      if (Date.now() - startTime > TIMEOUT_MS) {
        result.remaining = chats.length - chatIndex
        log(`⏱ 接近超时，已处理 ${chatIndex} 个会话，剩余 ${result.remaining} 个`)
        break
      }
      chatIndex++

      const lastTs = stateMap.get(chat.chat_id) || '0'
      const msgStartTime = lastTs !== '0'
        ? String(Math.floor((parseInt(lastTs) - 1000) / 1000))
        : undefined

      const pct = Math.round((chatIndex / chats.length) * 100)
      await log(`  [${pct}%] 同步 ${chatIndex}/${chats.length}: ${chat.name}`)

      try {
        // Rate limit: wait 500ms between chats to avoid feishu API throttling (99991400)
        if (chatIndex > 1) await new Promise(r => setTimeout(r, 500))
        const msgs = await listMessages(userToken, chat.chat_id, msgStartTime)
        if (msgs.length === 0) {
          await log(`    -> 无新消息`)
          continue
        }

        let newTs = lastTs
        let chatImported = 0

        for (const msg of msgs) {
          const ts = toLocalTime(parseInt(msg.create_time))
          const isSelf = msg.sender_id === myUserId || msg.sender_name === myName
          const direction = isSelf ? 'sent' : 'received'
          const contactName = chat.chat_type === 'p2p' ? chat.name : chat.name
          const senderDisplay = resolveSenderName(msg.sender_id, isSelf)

          // Insert message (ON CONFLICT DO NOTHING for dedup by source_id)
          await exec(
            `INSERT INTO messages (user_id, contact_name, direction, content, timestamp, source_id, sender_name)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, source_id) DO NOTHING`,
            [userId, contactName, direction, msg.content, ts, msg.message_id, senderDisplay],
          )

          // Upsert contact for received messages
          if (!isSelf) {
            await exec(
              `INSERT INTO contacts (user_id, name, feishu_open_id, last_contact_at, message_count)
               VALUES (?, ?, ?, ?, 1)
               ON CONFLICT (user_id, name) DO UPDATE SET
                 feishu_open_id  = COALESCE(EXCLUDED.feishu_open_id, contacts.feishu_open_id),
                 message_count   = contacts.message_count + 1,
                 last_contact_at = CASE
                   WHEN EXCLUDED.last_contact_at > contacts.last_contact_at THEN EXCLUDED.last_contact_at
                   ELSE contacts.last_contact_at
                 END`,
              [userId, contactName, msg.sender_id || null, ts],
            )

            // Upsert feishu_users
            const resolvedName = senderNameCache.get(msg.sender_id)
            if (msg.sender_id && resolvedName && !resolvedName.startsWith('ou_')) {
              await exec(
                `INSERT INTO feishu_users (user_id, open_id, name)
                 VALUES (?, ?, ?)
                 ON CONFLICT (user_id, open_id) DO UPDATE SET name = EXCLUDED.name`,
                [userId, msg.sender_id, resolvedName],
              )
            }
          }

          chatImported++
          if (msg.create_time > newTs) newTs = msg.create_time
        }

        // Update sync state
        await exec(
          `UPDATE feishu_sync_state SET last_sync_ts = ? WHERE user_id = ? AND chat_id = ?`,
          [newTs, userId, chat.chat_id],
        )

        result.imported += chatImported
        lastResult = { ...result } // update incrementally for realtime progress
        log(`    -> 导入 ${chatImported} 条`)
      } catch (err: any) {
        if (err instanceof TokenExpiredError) {
          log(`    token 过期，刷新后重试...`)
          try {
            userToken = await ensureValidToken(userId)
            // Retry this chat
            const retryMsgs = await listMessages(userToken, chat.chat_id, msgStartTime)
            let retryTs = lastTs
            let retryImported = 0
            for (const msg of retryMsgs) {
              const ts = toLocalTime(parseInt(msg.create_time))
              const isSelf = msg.sender_id === myUserId || msg.sender_name === myName
              const direction = isSelf ? 'sent' : 'received'
              const contactName = chat.name
              const senderDisplay = resolveSenderName(msg.sender_id, isSelf)

              await exec(
                `INSERT INTO messages (user_id, contact_name, direction, content, timestamp, source_id, sender_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (user_id, source_id) DO NOTHING`,
                [userId, contactName, direction, msg.content, ts, msg.message_id, senderDisplay],
              )
              if (!isSelf) {
                await exec(
                  `INSERT INTO contacts (user_id, name, feishu_open_id, last_contact_at, message_count)
                   VALUES (?, ?, ?, ?, 1)
                   ON CONFLICT (user_id, name) DO UPDATE SET
                     feishu_open_id  = COALESCE(EXCLUDED.feishu_open_id, contacts.feishu_open_id),
                     message_count   = contacts.message_count + 1,
                     last_contact_at = CASE
                       WHEN EXCLUDED.last_contact_at > contacts.last_contact_at THEN EXCLUDED.last_contact_at
                       ELSE contacts.last_contact_at
                     END`,
                  [userId, contactName, msg.sender_id || null, ts],
                )
                const resolvedName = senderNameCache.get(msg.sender_id)
            if (msg.sender_id && resolvedName && !resolvedName.startsWith('ou_')) {
                  await exec(
                    `INSERT INTO feishu_users (user_id, open_id, name)
                     VALUES (?, ?, ?)
                     ON CONFLICT (user_id, open_id) DO UPDATE SET name = EXCLUDED.name`,
                    [userId, msg.sender_id, resolvedName],
                  )
                }
              }
              retryImported++
              if (msg.create_time > retryTs) retryTs = msg.create_time
            }
            await exec(
              `UPDATE feishu_sync_state SET last_sync_ts = ? WHERE user_id = ? AND chat_id = ?`,
              [retryTs, userId, chat.chat_id],
            )
            result.imported += retryImported
            lastResult = { ...result } // update incrementally for realtime progress
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

    // Build sender name cache
    const senderNameCache = new Map<string, string>()
    const cachedUsers = await query<{ open_id: string; name: string }>(
      'SELECT open_id, name FROM feishu_users WHERE user_id = ?', [userId]
    )
    for (const u of cachedUsers) senderNameCache.set(u.open_id, u.name)

    function resolveSenderName(senderId: string, isSelf: boolean): string {
      if (isSelf) return myName || '我'
      return senderNameCache.get(senderId) || senderId || '未知'
    }

    // Only check chats active in last 90 days
    const since = String(Date.now() - 90 * 24 * 60 * 60 * 1000)
    const activeChats = await query<{ chat_id: string; chat_name: string; chat_type: string; last_sync_ts: string }>(
      `SELECT chat_id, chat_name, chat_type, last_sync_ts
       FROM feishu_sync_state
       WHERE user_id = ? AND (last_sync_ts > ? OR last_sync_ts = '0')
       ORDER BY last_sync_ts DESC
       LIMIT 500`,
      [userId, since],
    )

    if (activeChats.length === 0) {
      log('快速同步: 无活跃会话')
      return
    }

    let imported = 0
    let errors = 0

    for (const chat of activeChats) {
      try {
        const startTime = String(Math.floor((parseInt(chat.last_sync_ts) - 1000) / 1000))
        const msgs = await listMessages(userToken, chat.chat_id, startTime)
        if (msgs.length === 0) continue

        let newTs = chat.last_sync_ts

        for (const msg of msgs) {
          const ts = toLocalTime(parseInt(msg.create_time))
          const isSelf = msg.sender_id === myUserId || msg.sender_name === myName
          const direction = isSelf ? 'sent' : 'received'
          const contactName = chat.chat_name
          const senderDisplay = resolveSenderName(msg.sender_id, isSelf)

          await exec(
            `INSERT INTO messages (user_id, contact_name, direction, content, timestamp, source_id, sender_name)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (user_id, source_id) DO NOTHING`,
            [userId, contactName, direction, msg.content, ts, msg.message_id, senderDisplay],
          )

          if (!isSelf) {
            await exec(
              `INSERT INTO contacts (user_id, name, feishu_open_id, last_contact_at, message_count)
               VALUES (?, ?, ?, ?, 1)
               ON CONFLICT (user_id, name) DO UPDATE SET
                 feishu_open_id  = COALESCE(EXCLUDED.feishu_open_id, contacts.feishu_open_id),
                 message_count   = contacts.message_count + 1,
                 last_contact_at = CASE
                   WHEN EXCLUDED.last_contact_at > contacts.last_contact_at THEN EXCLUDED.last_contact_at
                   ELSE contacts.last_contact_at
                 END`,
              [userId, contactName, msg.sender_id || null, ts],
            )
          }

          imported++
          if (msg.create_time > newTs) newTs = msg.create_time
        }

        await exec(
          `UPDATE feishu_sync_state SET last_sync_ts = ? WHERE user_id = ? AND chat_id = ?`,
          [newTs, userId, chat.chat_id],
        )
      } catch (err: any) {
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
      await exec('DELETE FROM messages WHERE user_id = ?', [userId])
      await exec('DELETE FROM contacts WHERE user_id = ?', [userId])
      await exec("UPDATE feishu_sync_state SET last_sync_ts = '0' WHERE user_id = ?", [userId])
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
