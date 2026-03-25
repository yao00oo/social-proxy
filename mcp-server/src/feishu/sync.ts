// 飞书消息同步主逻辑
// 全量拉取 + 增量同步（基于每个会话的 last_sync_ts）

import { getDb } from '../db'
import { listChats, listMessages } from './api'
import { getSetting, saveSetting, ensureValidToken } from './auth'
import { summarizeChatAndSave } from '../summarize'

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
            if (!isSelf) upsertContact.run(contactName, msg.sender_id || null, ts)
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
    const toSummarize = [...newMsgsPerChat.entries()].filter(([, v]) => v.count >= SUMMARIZE_THRESHOLD)
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
    const needSummarize = [...newMsgsPerChat.values()].filter(v => v.count >= SUMMARIZE_THRESHOLD).length
    if (needSummarize > 0) {
      log(`\n💡 ${needSummarize} 个会话有 ≥${SUMMARIZE_THRESHOLD} 条新消息，设置 OPENROUTER_API_KEY 可自动更新摘要`)
    }
  }

  return result
}
