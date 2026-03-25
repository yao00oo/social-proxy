// 通用同步后处理 — 所有数据源共用
// 1. 统计每个联系人新增消息数
// 2. 达到阈值自动触发摘要更新

import { getDb } from '../db'
import { summarizeChatAndSave } from '../summarize'

const SUMMARIZE_THRESHOLD = 5

export interface NewMessages {
  [contactName: string]: number  // contact_name → 新增消息数
}

// 同步后调用：传入每个联系人的新增消息数，自动触发摘要
export async function postSync(
  newMessages: NewMessages,
  onProgress?: (msg: string) => void,
): Promise<number> {
  const log = (msg: string) => { console.log(msg); onProgress?.(msg) }
  const db = getDb()
  let summarized = 0

  // 找出需要摘要的联系人
  const toSummarize = Object.entries(newMessages).filter(([, count]) => count >= SUMMARIZE_THRESHOLD)

  if (toSummarize.length === 0) return 0

  if (!process.env.OPENROUTER_API_KEY) {
    log(`\n💡 ${toSummarize.length} 个联系人有 ≥${SUMMARIZE_THRESHOLD} 条新消息，设置 OPENROUTER_API_KEY 可自动更新摘要`)
    return 0
  }

  log(`\n📝 自动更新摘要（新增 ≥${SUMMARIZE_THRESHOLD} 条）：共 ${toSummarize.length} 个联系人`)

  // 确保 chat_summaries 表存在，并查找对应的 chat_id
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_summaries (
      chat_id       TEXT PRIMARY KEY,
      chat_name     TEXT,
      start_time    TEXT,
      end_time      TEXT,
      message_count INTEGER,
      summary       TEXT,
      updated_at    TEXT
    )
  `)

  for (const [contactName, count] of toSummarize) {
    log(`  摘要: ${contactName} (${count}条新消息)...`)
    try {
      // 尝试从 feishu_sync_state 查 chat_id，没有就用 contact_name 作为 chat_id
      const chatRow = db.prepare(
        `SELECT chat_id, chat_type FROM feishu_sync_state WHERE chat_name = ?`
      ).get(contactName) as { chat_id: string; chat_type: string } | undefined

      const chatId = chatRow?.chat_id || `contact:${contactName}`
      const chatType = chatRow?.chat_type || 'p2p'

      await summarizeChatAndSave(chatId, contactName, chatType)
      summarized++
      log(`    ✓`)
    } catch (e: any) {
      log(`    ✗ ${e.message?.slice(0, 60)}`)
    }
  }

  log(`摘要更新完成：${summarized} 个`)
  return summarized
}
