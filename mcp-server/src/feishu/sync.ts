// 飞书消息同步主逻辑
// 全量拉取 + 增量同步（基于每个会话的 last_sync_ts）

import { getDb } from '../db'
import { listChats, listMessages, downloadImage } from './api'
import { getSetting, saveSetting, ensureValidToken } from './auth'
import { summarizeChatAndSave } from '../summarize'
import path from 'path'
import fs from 'fs'

const IMAGES_DIR = path.join(__dirname, '../../../images')
function ensureImagesDir() { if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true }) }

const SUMMARIZE_THRESHOLD = 5 // 新增消息数达到此值才触发摘要更新

export interface SyncResult {
  chats: number
  imported: number
  skipped: number
  errors: string[]
  summarized: number
}


// 确保 feishu_sync_state 表存在（记录每个会话的同步进度）
function initSyncState() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS feishu_sync_state (
      chat_id      TEXT PRIMARY KEY,
      chat_name    TEXT,
      chat_type    TEXT,
      last_sync_ts TEXT DEFAULT '0'
    )
  `)
}

export async function syncFeishu(onProgress?: (msg: string) => void): Promise<SyncResult> {
  const db = getDb()
  initSyncState()

  const log = (msg: string) => {
    console.log(msg)
    onProgress?.(msg)
  }

  const userToken = await ensureValidToken()
  const myName = getSetting('feishu_user_name')
  const myUserId = getSetting('feishu_user_id')

  const result: SyncResult = { chats: 0, imported: 0, skipped: 0, errors: [], summarized: 0 }
  const newMsgsPerChat = new Map<string, { chat_name: string; chat_type: string; count: number }>()

  // 1. 获取会话列表
  log('获取会话列表...')
  const chats = await listChats(userToken)
  result.chats = chats.length
  log(`共 ${chats.length} 个会话`)

  // 2. 确保 sync_state 有所有会话的记录
  const upsertState = db.prepare(`
    INSERT INTO feishu_sync_state(chat_id, chat_name, chat_type)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET chat_name = excluded.chat_name, chat_type = excluded.chat_type
  `)
  for (const chat of chats) {
    upsertState.run(chat.chat_id, chat.name, chat.chat_type)
  }

  // 3. 逐个会话同步
  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages(contact_name, direction, content, timestamp, source_id)
    VALUES (?, ?, ?, ?, ?)
  `)

  const upsertContact = db.prepare(`
    INSERT INTO contacts(name, email, feishu_open_id, last_contact_at, message_count)
    VALUES (?, NULL, ?, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      feishu_open_id  = COALESCE(excluded.feishu_open_id, feishu_open_id),
      message_count   = message_count + 1,
      last_contact_at = CASE
        WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at
        ELSE last_contact_at
      END
  `)

  const updateState = db.prepare(`
    UPDATE feishu_sync_state SET last_sync_ts = ? WHERE chat_id = ?
  `)

  const upsertFeishuUser = db.prepare(`
    INSERT INTO feishu_users(open_id, name) VALUES (?, ?)
    ON CONFLICT(open_id) DO UPDATE SET name = excluded.name
  `)

  for (const chat of chats) {
    // 跳过群聊
    if (chat.chat_type === 'group') {
      log(`  跳过群聊: ${chat.name}`)
      result.skipped++
      continue
    }

    // 跳过通知类机器人会话（名字含"通知"/"助手"/"bot"等）
    const skipKeywords = ['通知', '助手', 'bot', 'Bot', '机器人', 'webhook', 'Webhook']
    if (skipKeywords.some(kw => chat.name.includes(kw))) {
      log(`  跳过通知会话: ${chat.name}`)
      result.skipped++
      continue
    }

    const stateRow = db.prepare(
      `SELECT last_sync_ts FROM feishu_sync_state WHERE chat_id = ?`
    ).get(chat.chat_id) as any

    const lastTs = stateRow?.last_sync_ts || '0'
    // 飞书 API start_time 是 Unix 秒
    const startTime = lastTs !== '0' ? (Math.floor(parseInt(lastTs) / 1000)).toString() : undefined

    log(`  同步: ${chat.name} (从 ${lastTs === '0' ? '最早' : new Date(parseInt(lastTs)).toLocaleString()})`)

    try {
      const msgs = await listMessages(userToken, chat.chat_id, startTime)

      if (msgs.length === 0) {
        log(`    → 无新消息`)
        continue
      }

      let newTs = lastTs
      let chatImported = 0

      const run = db.transaction(() => {
        for (const msg of msgs) {
          const ts = new Date(parseInt(msg.create_time)).toISOString().replace('T', ' ').slice(0, 19)
          const isSelf = msg.sender_id === myUserId || msg.sender_name === myName
          const direction = isSelf ? 'sent' : 'received'

          // p2p 里自己发的消息不作为联系人
          if (chat.chat_type === 'p2p' && isSelf) {
            insertMessage.run(chat.name, direction, msg.content, ts, msg.message_id)
          } else {
            const contactName = chat.chat_type === 'p2p' ? msg.sender_name : chat.name
            insertMessage.run(contactName, direction, msg.content, ts, msg.message_id)
            if (!isSelf) {
            upsertContact.run(contactName, msg.sender_id || null, ts)
            // 记录发消息人的姓名 → open_id（用于精确查找个人）
            // sender_name 有时是 open_id 本身，过滤掉无效值
            if (msg.sender_id && msg.sender_name && !msg.sender_name.startsWith('ou_')) {
              upsertFeishuUser.run(msg.sender_id, msg.sender_name)
            }
          }
          }

          chatImported++
          if (msg.create_time > newTs) newTs = msg.create_time
        }
      })

      run()
      updateState.run(newTs, chat.chat_id)
      result.imported += chatImported
      log(`    → 导入 ${chatImported} 条`)
      if (chatImported > 0) {
        newMsgsPerChat.set(chat.chat_id, { chat_name: chat.name, chat_type: chat.chat_type, count: chatImported })
      }
    } catch (err: any) {
      const errMsg = `${chat.name}: ${err.message}`
      result.errors.push(errMsg)
      log(`    ⚠ ${errMsg}`)
    }
  }

  log(`\n✅ 同步完成: ${result.imported} 条消息，${result.errors.length} 个错误`)

  // 增量摘要：只对新增 >= SUMMARIZE_THRESHOLD 条消息的聊天重新生成摘要
  if (process.env.OPENROUTER_API_KEY) {
    const toSummarize = Array.from(newMsgsPerChat.entries()).filter(([, v]) => v.count >= SUMMARIZE_THRESHOLD)
    if (toSummarize.length > 0) {
      log(`\n📝 自动更新摘要（新增 ≥${SUMMARIZE_THRESHOLD} 条）：共 ${toSummarize.length} 个会话`)
      for (const [chatId, { chat_name, chat_type }] of toSummarize) {
        log(`  摘要: ${chat_name}...`)
        try {
          await summarizeChatAndSave(chatId, chat_name, chat_type)
          result.summarized++
          log(`    ✓`)
        } catch (e: any) {
          log(`    ✗ ${e.message?.slice(0, 60)}`)
        }
      }
      log(`摘要更新完成：${result.summarized} 个`)
    }
  } else {
    const needSummarize = Array.from(newMsgsPerChat.values()).filter(v => v.count >= SUMMARIZE_THRESHOLD).length
    if (needSummarize > 0) {
      log(`\n💡 ${needSummarize} 个会话有 ≥${SUMMARIZE_THRESHOLD} 条新消息，设置 OPENROUTER_API_KEY 可自动更新摘要`)
    }
  }

  return result
}

// 快速增量同步：只扫描近期活跃的聊天，不重新拉取会话列表
// 适合高频调用（15-30秒），速度快
export async function quickSync(): Promise<{ imported: number; errors: number }> {
  const db = getDb()

  const userToken = await ensureValidToken()
  const myName = getSetting('feishu_user_name')
  const myUserId = getSetting('feishu_user_id')

  // 扫描最近 30 天活跃的聊天，排除明显群聊
  const since = (Date.now() - 30 * 24 * 60 * 60 * 1000).toString()
  const skipKeywords = ['通知', '助手', 'bot', 'Bot', '机器人', 'webhook', 'Webhook', '群', 'Group', 'channel', 'Channel']
  const activeChats = (db.prepare(`
    SELECT chat_id, chat_name, chat_type, last_sync_ts
    FROM feishu_sync_state
    WHERE last_sync_ts > ?
    ORDER BY last_sync_ts DESC
    LIMIT 200
  `).all(since) as { chat_id: string; chat_name: string; chat_type: string; last_sync_ts: string }[])
    .filter(c => {
      if (c.chat_type === 'group') return false
      if (skipKeywords.some(kw => c.chat_name.includes(kw))) return false
      return true
    })
    .slice(0, 80)

  if (activeChats.length === 0) return { imported: 0, errors: 0 }

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages(contact_name, direction, content, timestamp, source_id)
    VALUES (?, ?, ?, ?, ?)
  `)
  const upsertContact = db.prepare(`
    INSERT INTO contacts(name, email, last_contact_at, message_count)
    VALUES (?, NULL, ?, 1)
    ON CONFLICT(name) DO UPDATE SET
      message_count   = message_count + 1,
      last_contact_at = CASE
        WHEN excluded.last_contact_at > last_contact_at THEN excluded.last_contact_at
        ELSE last_contact_at
      END
  `)
  const updateState = db.prepare(`UPDATE feishu_sync_state SET last_sync_ts = ? WHERE chat_id = ?`)

  const insertSuggestion = db.prepare(`
    INSERT OR IGNORE INTO reply_suggestions(message_id, contact_name, chat_id, incoming_content, created_at, is_at_me)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  // 检测消息是否 @ 了我（匹配 @姓名 或 @user_id）
  const atPatterns = [myName, myUserId].filter(Boolean).map(s => `@${s}`)
  function checkAtMe(content: string): boolean {
    return atPatterns.some(p => content.includes(p))
  }

  // 查询某条消息是否是我发的（用于判断 parent_id 回复关系）
  const checkMyMsg = db.prepare(
    `SELECT 1 FROM messages WHERE source_id = ? AND direction = 'sent' LIMIT 1`
  )

  let imported = 0
  let errors = 0

  for (const chat of activeChats) {
    try {
      const startTime = (Math.floor(parseInt(chat.last_sync_ts) / 1000)).toString()
      const msgs = await listMessages(userToken, chat.chat_id, startTime)
      if (msgs.length === 0) continue

      // 建立本批消息的 sender 索引，用于判断 parent_id 是否是我发的
      const batchSenderMap = new Map<string, boolean>()
      for (const m of msgs) {
        batchSenderMap.set(m.message_id, m.sender_id === myUserId || m.sender_name === myName)
      }

      let newTs = chat.last_sync_ts
      // 收集需要下载的图片（async 不能在 transaction 内）
      const toDownload: { messageId: string; imageKey: string; sourceId: string }[] = []

      const run = db.transaction(() => {
        for (const msg of msgs) {
          const ts = new Date(parseInt(msg.create_time)).toISOString().replace('T', ' ').slice(0, 19)
          const isSelf = msg.sender_id === myUserId || msg.sender_name === myName
          const direction = isSelf ? 'sent' : 'received'
          // p2p 聊天用 chat_name（即对方姓名），比 sender_name 更可靠
          const contactName = chat.chat_name
          const content = msg.image_key ? `[图片:${msg.image_key}]` : msg.content
          const result = insertMessage.run(contactName, direction, content, ts, msg.message_id)
          if (msg.image_key && result.changes > 0) {
            toDownload.push({ messageId: msg.message_id, imageKey: msg.image_key, sourceId: msg.message_id })
          }
          if (!isSelf) {
            if (result.changes > 0) upsertContact.run(contactName, ts)
            // 判断是否与我相关：@我 或 回复我的消息
            let isAtMe = checkAtMe(msg.content) ? 1 : 0
            if (!isAtMe && msg.parent_id) {
              // 先查本批，再查数据库
              const parentInBatch = batchSenderMap.get(msg.parent_id)
              if (parentInBatch === true) {
                isAtMe = 1
              } else if (parentInBatch === undefined && checkMyMsg.get(msg.parent_id)) {
                isAtMe = 1
              }
            }
            insertSuggestion.run(msg.message_id, contactName, chat.chat_id, content, ts, isAtMe)
          }
          if (result.changes > 0) imported++
          if (msg.create_time > newTs) newTs = msg.create_time
        }
      })
      run()

      // 下载图片到本地
      if (toDownload.length > 0) {
        ensureImagesDir()
        const updateContent = db.prepare(`UPDATE messages SET content = ? WHERE source_id = ?`)
        const updateSuggestion = db.prepare(`UPDATE reply_suggestions SET incoming_content = ? WHERE message_id = ?`)
        for (const dl of toDownload) {
          try {
            const buf = await downloadImage(userToken, dl.messageId, dl.imageKey)
            const ext = dl.imageKey.startsWith('img_') ? '.jpg' : '.png'
            const filename = `${dl.imageKey}${ext}`
            const filepath = path.join(IMAGES_DIR, filename)
            fs.writeFileSync(filepath, buf)
            const newContent = `[图片:${filepath}]`
            updateContent.run(newContent, dl.sourceId)
            updateSuggestion.run(newContent, dl.sourceId)
          } catch { /* 下载失败保留原文 */ }
        }
      }

      // start_time +1ms 避免下次重复拉取同一条消息
      const nextTs = (parseInt(newTs) + 1).toString()
      updateState.run(nextTs, chat.chat_id)
    } catch {
      errors++
    }
  }

  return { imported, errors }
}
