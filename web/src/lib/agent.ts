// 小林 Agent — Vercel AI SDK v6 tool-use agent loop
import { streamText, stepCountIs } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { z } from 'zod'
import { query, queryOne, exec } from './db'
// feishu imports removed — settings read inline with userId filter

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY || '' })
const DEFAULT_MODEL = 'deepseek/deepseek-chat-v3-0324'

export const AVAILABLE_MODELS = [
  { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3 (推荐)', description: '性价比最高' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', description: '高质量对话' },
  { id: 'anthropic/claude-haiku-4', name: 'Claude Haiku 4', description: '快速响应' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', description: '快速便宜' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', description: '综合能力强' },
  { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash', description: '快速' },
  { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', description: '高质量' },
]

const SYSTEM_PROMPT = `你是"小林"，用户的私人社交助理。

## 核心工作流
当用户让你查看消息/联系人时，你应该：
1. 同时调用 get_new_messages 和 get_approvals 获取全面信息
2. 把消息按优先级分类：需要回复的 vs 纯通知
3. 对需要回复的消息，结合 recent_history 上下文给出建议回复
4. 区分@我的消息（优先处理）和普通消息

## 发送消息流程（强制要求）
当用户要求给某人发消息时：
1. 先用 get_history 了解背景
2. 用以下固定格式输出草稿（前端会自动解析成可交互的草稿卡片）：

<<DRAFT|联系人名|feishu|消息内容>>

例如给张三发消息：
<<DRAFT|张三|feishu|你好，最近怎么样？>>

给多个人分别发：
<<DRAFT|张三|feishu|你好张三>>
<<DRAFT|李四|feishu|你好李四>>

3. 禁止用其他格式写草稿！必须用 <<DRAFT|...|...|...>> 格式！
4. 邮件用 email 平台：<<DRAFT|王五|email|邮件内容>>

## 行为准则
- 回答简洁，用中文
- 消息分析要全面，不要遗漏
- 需要回复的消息按紧急程度排序
- 纯通知/系统消息单独列出说明不需要回复
- 涉及金额、重要决定要特别谨慎
- 多调用工具获取信息，不要凭空猜测

## 重要：工具调用规范
调用任何工具时，必须传递所有必要参数。例如：
- get_history 必须传 contact_name
- send_feishu_message 必须传 contact_name 和 content
- search_messages 必须传 keyword
不要传空参数！

当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`

// Fuzzy contact name resolver — searches contacts table, prefers "(私聊)" suffix
async function resolveContactName(name: string, userId: string): Promise<string> {
  const exact = await queryOne<{ name: string }>('SELECT name FROM contacts WHERE name = ? AND user_id = ?', [name, userId])
  if (exact) return exact.name
  // Prefer "(私聊)" suffix, then shortest name
  const candidates = await query<{ name: string }>(
    `SELECT name FROM contacts WHERE name LIKE '%' || ? || '%' AND user_id = ? ORDER BY
      CASE WHEN name LIKE '% (私聊)' THEN 0 ELSE 1 END,
      length(name) ASC LIMIT 1`,
    [name, userId]
  )
  return candidates[0]?.name || name
}

// Resolve contact_name to matching thread IDs
async function resolveThreadIds(contactName: string, userId: string): Promise<number[]> {
  const threads = await query<{ id: number }>(
    `SELECT id FROM threads WHERE name LIKE '%' || ? || '%' AND user_id = ? ORDER BY
      CASE WHEN name LIKE '% (私聊)' THEN 0 ELSE 1 END,
      length(name) ASC LIMIT 10`,
    [contactName, userId]
  )
  return threads.map(t => t.id)
}

// Tools factory — captures userId for multi-tenant DB queries
function createTools(userId: string): Record<string, any> {
  return {
  get_contacts: {
    description: '获取联系人列表，按最近联系时间排序。可搜索姓名。',
    parameters: z.object({
      search: z.string().optional().describe('按姓名搜索'),
      limit: z.number().optional().describe('返回数量，默认20'),
    }),
    execute: async ({ search, limit }: { search?: string; limit?: number }) => {
      const lim = Math.min(limit ?? 20, 100)
      const where = search
        ? `WHERE user_id = ? AND name LIKE '%' || ? || '%'`
        : `WHERE user_id = ?`
      const params: any[] = search ? [userId, search] : [userId]
      const rows = await query(`
        SELECT name, avatar, tags, notes, last_contact_at, message_count,
          CASE WHEN last_contact_at IS NULL THEN 9999
            ELSE CAST(EXTRACT(EPOCH FROM NOW() - last_contact_at::timestamp) / 86400 AS INTEGER)
          END AS days_since,
          (SELECT string_agg(DISTINCT ch.platform, ',') FROM contact_identities ci
           JOIN channels ch ON ci.channel_id = ch.id
           WHERE ci.contact_id = contacts.id) as platforms
        FROM contacts ${where} ORDER BY last_contact_at DESC LIMIT ?
      `, [...params, lim])
      const countRow = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM contacts WHERE user_id = ?', [userId])
      return { total: countRow?.n ?? 0, contacts: rows }
    },
  },

  get_history: {
    description: '获取与某人的聊天记录。支持模糊匹配联系人名。返回最近消息和历史摘要。',
    parameters: z.object({
      contact_name: z.string().describe('联系人姓名（支持模糊匹配，如"祝悦"会匹配"祝悦 (私聊)"）'),
      limit: z.number().optional().describe('返回消息条数，默认30'),
    }),
    execute: async (rawArgs: any) => {
      const contact_name = rawArgs.contact_name || rawArgs.contact || rawArgs.name || ''
      const limit = rawArgs.limit
      const lim = limit ?? 30
      if (!contact_name) return { error: '请提供联系人姓名', total: 0, messages: [] }

      // Find matching threads (conversation name matches contact name)
      const threads = await query<{ id: number; name: string }>(
        `SELECT id, name FROM threads WHERE name LIKE '%' || ? || '%' AND user_id = ? ORDER BY
          CASE WHEN name LIKE '% (私聊)' THEN 0 ELSE 1 END,
          length(name) ASC LIMIT 5`,
        [contact_name, userId]
      )
      const actualName = threads[0]?.name || contact_name
      const threadIds = threads.map(t => t.id)

      if (threadIds.length === 0) {
        return { matched_name: contact_name, searched_name: contact_name, total: 0, messages: [], summary: null }
      }

      // Build placeholders for IN clause
      const placeholders = threadIds.map(() => '?').join(',')

      const totalRow = await queryOne<{ n: number }>(
        `SELECT COUNT(*) as n FROM messages WHERE thread_id IN (${placeholders}) AND user_id = ?`,
        [...threadIds, userId]
      )
      const total = totalRow?.n ?? 0

      const messages = await query(`
        SELECT direction, sender_name, content, timestamp, platform FROM (
          SELECT m.direction, m.sender_name, m.content, m.timestamp, ch.platform
          FROM messages m
          JOIN channels ch ON m.channel_id = ch.id
          WHERE m.thread_id IN (${placeholders}) AND m.user_id = ?
          ORDER BY m.timestamp DESC LIMIT ?
        ) sub ORDER BY timestamp ASC
      `, [...threadIds, userId, lim])

      // Get summary from summaries table joined with threads
      const summaryRow = await queryOne<{ summary: string; start_time: string; end_time: string }>(
        `SELECT s.summary, s.start_time, s.end_time FROM summaries s
         JOIN threads t ON s.thread_id = t.id
         WHERE t.id IN (${placeholders}) AND s.user_id = ? AND s.summary IS NOT NULL
         ORDER BY s.end_time DESC LIMIT 1`,
        [...threadIds, userId]
      )

      return {
        matched_name: actualName,
        searched_name: contact_name,
        total,
        messages,
        summary: summaryRow?.summary || null,
      }
    },
  },

  get_summaries: {
    description: '获取会话的 AI 摘要，可按联系人名或关键词搜索。',
    parameters: z.object({
      search: z.string().optional().describe('搜索关键词'),
    }),
    execute: async ({ search }: { search?: string }) => {
      const params: any[] = search ? [userId, `%${search}%`, `%${search}%`] : [userId]
      const rows = await query(`
        SELECT t.name as thread_name, s.start_time, s.end_time, s.message_count, s.summary
        FROM summaries s JOIN threads t ON s.thread_id = t.id
        WHERE s.summary IS NOT NULL AND s.user_id = ? ${search ? 'AND (t.name LIKE ? OR s.summary LIKE ?)' : ''}
        ORDER BY s.end_time DESC LIMIT 20
      `, params)
      return { summaries: rows }
    },
  },

  search_messages: {
    description: '在聊天记录中按关键词搜索，找具体事件、日期、数字等细节。',
    parameters: z.object({
      keyword: z.string().describe('搜索关键词'),
      contact_name: z.string().optional().describe('限定在某个联系人的聊天中搜索'),
      limit: z.number().optional().describe('返回条数，默认20'),
    }),
    execute: async ({ keyword, contact_name, limit }: { keyword: string; contact_name?: string; limit?: number }) => {
      const lim = Math.min(limit ?? 20, 50)
      if (contact_name) {
        // Find threads matching the contact name, then search messages in those threads
        const threadIds = await resolveThreadIds(contact_name, userId)
        if (threadIds.length === 0) {
          return { count: 0, results: [] }
        }
        const placeholders = threadIds.map(() => '?').join(',')
        const rows = await query(
          `SELECT t.name as thread_name, m.direction, m.sender_name, m.content, m.timestamp, ch.platform
           FROM messages m JOIN threads t ON m.thread_id = t.id
           JOIN channels ch ON m.channel_id = ch.id
           WHERE m.thread_id IN (${placeholders}) AND m.user_id = ? AND m.content LIKE ?
           ORDER BY m.timestamp DESC LIMIT ?`,
          [...threadIds, userId, `%${keyword}%`, lim]
        )
        return { count: rows.length, results: rows }
      } else {
        const rows = await query(
          `SELECT t.name as thread_name, m.direction, m.sender_name, m.content, m.timestamp, ch.platform
           FROM messages m JOIN threads t ON m.thread_id = t.id
           JOIN channels ch ON m.channel_id = ch.id
           WHERE m.user_id = ? AND m.content LIKE ?
           ORDER BY m.timestamp DESC LIMIT ?`,
          [userId, `%${keyword}%`, lim]
        )
        return { count: rows.length, results: rows }
      }
    },
  },

  get_stats: {
    description: '获取社交关系全局统计：联系人总数、消息总量、失联分布、最久未联系的人。',
    parameters: z.object({}),
    execute: async () => {
      const totalRow = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM contacts WHERE user_id = ?', [userId])
      const total = totalRow?.n ?? 0
      const totalMsgsRow = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE user_id = ?', [userId])
      const totalMsgs = totalMsgsRow?.n ?? 0
      const buckets = await query(`
        SELECT CASE WHEN days >= 365 THEN '365天以上' WHEN days >= 90 THEN '90-365天'
          WHEN days >= 30 THEN '30-90天' WHEN days >= 7 THEN '7-30天' ELSE '7天内' END AS bucket, COUNT(*) as count
        FROM (SELECT CAST(EXTRACT(EPOCH FROM NOW() - last_contact_at::timestamp) / 86400 AS INTEGER) AS days FROM contacts WHERE last_contact_at IS NOT NULL AND user_id = ?) sub
        GROUP BY bucket ORDER BY MIN(days) DESC
      `, [userId])
      const overdue = await query(`
        SELECT name, message_count, CAST(EXTRACT(EPOCH FROM NOW() - last_contact_at::timestamp) / 86400 AS INTEGER) AS days_since
        FROM contacts WHERE last_contact_at IS NOT NULL AND user_id = ? ORDER BY days_since DESC LIMIT 10
      `, [userId])
      const platformCounts = await query(`
        SELECT ch.platform, COUNT(*) as count FROM messages m
        JOIN channels ch ON m.channel_id = ch.id
        WHERE m.user_id = ? GROUP BY ch.platform
      `, [userId])
      return { total, totalMsgs, buckets, overdue, platformCounts }
    },
  },

  get_new_messages: {
    description: '获取最近收到的消息，按时间倒序。默认返回最近50条，可调大 limit。',
    parameters: z.object({
      limit: z.number().optional().describe('返回条数，默认50'),
    }),
    execute: async ({ limit }: { limit?: number }) => {
      const rows = await query<any>(`
        SELECT m.id, m.platform_msg_id as message_id, t.name as thread_name, t.type as thread_type,
          m.sender_name, m.content as incoming_content, m.timestamp as created_at,
          COALESCE(m.is_read, 0) as is_read, m.metadata, ch.platform
        FROM messages m
        JOIN threads t ON m.thread_id = t.id
        JOIN channels ch ON m.channel_id = ch.id
        WHERE m.direction = 'received' AND m.user_id = ?
        ORDER BY m.timestamp DESC LIMIT ?
      `, [userId, Math.min(limit ?? 50, 100)])

      // Add recent_history context for each message
      const msgs = await Promise.all(rows.map(async (row: any) => {
        const history = await query<any>(`
          SELECT direction, sender_name, content, timestamp FROM messages
          WHERE thread_id = (SELECT thread_id FROM messages WHERE id = ?) AND user_id = ?
          ORDER BY timestamp DESC LIMIT 10
        `, [row.id, userId])

        // Check if user was mentioned (look in metadata for mentions)
        const metadata = row.metadata || {}
        const isAtMe = !!(metadata.mentions && metadata.mentions.length > 0)

        return {
          ...row,
          is_at_me: isAtMe,
          is_read: !!row.is_read,
          recent_history: history.reverse(),
        }
      }))

      const unread = msgs.filter((m: any) => !m.is_read).length
      const atMe = msgs.filter((m: any) => m.is_at_me).length
      return { count: msgs.length, unread, atMe, messages: msgs }
    },
  },

  get_approvals: {
    description: '查询飞书审批任务。topic=1 待审批，topic=2 已审批，topic=3 我发起的。',
    parameters: z.object({
      topic: z.number().optional().describe('1=待审批（默认），2=已审批，3=我发起的'),
      limit: z.number().optional().describe('返回数量，默认20'),
    }),
    execute: async ({ topic, limit }: { topic?: number; limit?: number }) => {
      // Get feishu user_id from contact_identities via a feishu channel
      const feishuUserRow = await queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'feishu_user_id' AND user_id = ?", [userId])
      const feishuUserId = feishuUserRow?.value
      if (!feishuUserId) return { tasks: [], message: '未设置飞书用户ID，无法查询审批' }

      const tokenRow = await queryOne<{ value: string }>("SELECT value FROM settings WHERE key = 'feishu_user_access_token' AND user_id = ?", [userId])
      const token = tokenRow?.value
      if (!token) return { tasks: [], message: '飞书未授权，无法查询审批' }

      try {
        const params = new URLSearchParams({
          user_id: feishuUserId,
          user_id_type: 'open_id',
          topic: (topic ?? 1).toString(),
          page_size: Math.min(limit ?? 20, 200).toString(),
        })
        const res = await fetch(`https://open.feishu.cn/open-apis/approval/v4/tasks/query?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        if (data.code !== 0) return { tasks: [], message: `查询失败: ${data.msg}` }

        const tasks = (data.data?.tasks || []).map((t: any) => ({
          title: t.title || t.definition_name || '无标题',
          instance_code: t.process_code || t.instance_code || '',
          status: t.status === 2 ? '已完成' : t.status === 1 ? '进行中' : String(t.status),
          initiator_name: t.initiator_names?.[0] || '',
          create_time: t.create_time ? new Date(parseInt(t.create_time) * 1000).toISOString().slice(0, 16) : '',
        }))
        return { count: tasks.length, tasks }
      } catch (e: any) {
        return { tasks: [], message: `查询审批出错: ${e.message}` }
      }
    },
  },

  send_message: {
    description: '给联系人发送消息。默认先返回草稿让用户确认，用户说"发吧/确认/发送"后再真正发送。自动推荐最佳渠道，但用户可以指定。',
    parameters: z.object({
      contact_name: z.string().describe('联系人姓名'),
      content: z.string().describe('消息内容'),
      confirm: z.boolean().optional().describe('是否确认发送。首次调用不传或传false，用户确认后传true'),
      channel: z.string().optional().describe('指定发送渠道：feishu/email。不传则自动选择'),
    }),
    execute: async ({ contact_name, content, confirm }: { contact_name: string; content: string; confirm?: boolean }) => {
      // Find contact and available channels
      const contact = await queryOne<{ id: number; name: string }>(
        `SELECT id, name FROM contacts WHERE name LIKE '%' || ? || '%' AND user_id = ? ORDER BY length(name) ASC LIMIT 1`,
        [contact_name, userId]
      )
      if (!contact) return { success: false, mode: 'error', message: `找不到联系人"${contact_name}"` }

      // Find available send channels for this contact
      const feishuIdentity = await queryOne<{ platform_uid: string; channel_id: number }>(
        `SELECT ci.platform_uid, ci.channel_id FROM contact_identities ci
         JOIN channels ch ON ci.channel_id = ch.id
         WHERE ci.contact_id = ? AND ch.platform = 'feishu' LIMIT 1`,
        [contact.id]
      )
      const emailIdentity = await queryOne<{ email: string }>(
        `SELECT email FROM contact_identities WHERE contact_id = ? AND email IS NOT NULL AND email != '' LIMIT 1`,
        [contact.id]
      )

      const channels: string[] = []
      if (feishuIdentity) channels.push('飞书')
      if (emailIdentity) channels.push('邮件')
      if (channels.length === 0) {
        // Check if there's a thread we can match
        const thread = await queryOne<{ id: number; name: string; channel_id: number }>(
          `SELECT t.id, t.name, t.channel_id FROM threads t
           JOIN channels ch ON t.channel_id = ch.id
           WHERE t.name LIKE '%' || ? || '%' AND t.user_id = ? AND ch.platform = 'feishu'
           ORDER BY length(t.name) ASC LIMIT 1`,
          [contact_name, userId]
        )
        if (thread) channels.push('飞书')
      }
      if (channels.length === 0) return { success: false, mode: 'error', message: `"${contact.name}"没有可用的发送渠道（飞书/邮箱）` }

      const channelStr = channels.join('/')

      // Draft mode (default): return draft for user confirmation
      if (!confirm) {
        return {
          success: true,
          mode: 'draft',
          message: `📨 草稿：\n发给：${contact.name}\n渠道：${channelStr}（推荐${channels[0]}）\n内容：${content}\n\n确认发送吗？你也可以指定渠道，如"用邮件发"`,
          draft: { to: contact.name, content, channels, recommended: channels[0] }
        }
      }

      // Confirmed: actually send
      // Try feishu first
      if (feishuIdentity || channels.includes('飞书')) {
        try {
          const tokenRow = await queryOne<{ value: string }>(
            `SELECT value FROM settings WHERE key = 'feishu_user_access_token' AND user_id = ?`, [userId]
          )
          const appId = process.env.FEISHU_APP_ID || (await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = 'feishu_app_id' AND user_id = ?`, [userId]))?.value
          const appSecret = process.env.FEISHU_APP_SECRET || (await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = 'feishu_app_secret' AND user_id = ?`, [userId]))?.value

          if (appId && appSecret) {
            // Get app token
            const https = require('https')
            const appTokenRes: any = await new Promise((resolve, reject) => {
              const body = JSON.stringify({ app_id: appId, app_secret: appSecret })
              const req = https.request('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
              }, (res: any) => { let d = ''; res.on('data', (c: any) => d += c); res.on('end', () => resolve(JSON.parse(d))) })
              req.on('error', reject); req.write(body); req.end()
            })

            if (appTokenRes.app_access_token) {
              // Find receive_id
              let receiveId = feishuIdentity?.platform_uid
              let receiveIdType = 'open_id'
              if (!receiveId) {
                const thread = await queryOne<{ platform_thread_id: string }>(
                  `SELECT t.platform_thread_id FROM threads t JOIN channels ch ON t.channel_id = ch.id
                   WHERE t.name LIKE '%' || ? || '%' AND t.user_id = ? AND ch.platform = 'feishu' LIMIT 1`,
                  [contact_name, userId]
                )
                if (thread) { receiveId = thread.platform_thread_id; receiveIdType = 'chat_id' }
              }

              if (receiveId) {
                const sendBody = JSON.stringify({ receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text: content }) })
                const sendRes: any = await new Promise((resolve, reject) => {
                  const req = https.request(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(sendBody), Authorization: `Bearer ${appTokenRes.app_access_token}` }
                  }, (res: any) => { let d = ''; res.on('data', (c: any) => d += c); res.on('end', () => resolve(JSON.parse(d))) })
                  req.on('error', reject); req.write(sendBody); req.end()
                })

                if (sendRes.code === 0) {
                  return { success: true, mode: 'sent', message: `✅ 飞书消息已发送给 ${contact.name}` }
                } else {
                  return { success: false, mode: 'error', message: `发送失败: ${sendRes.msg}` }
                }
              }
            }
          }
        } catch (e: any) {
          return { success: false, mode: 'error', message: `飞书发送失败: ${e.message}` }
        }
      }

      return { success: false, mode: 'error', message: '暂时无法发送，请稍后重试' }
    },
  },

  search_docs: {
    description: '搜索文档内容。在飞书文档、本地文件等中按关键词搜索。',
    parameters: z.object({
      keyword: z.string().describe('搜索关键词'),
      limit: z.number().optional().describe('返回条数，默认10'),
    }),
    execute: async ({ keyword, limit }: { keyword: string; limit?: number }) => {
      const lim = Math.min(limit ?? 10, 30)
      const rows = await query(
        `SELECT d.title, d.doc_type, d.url, substring(d.content, 1, 200) as preview
         FROM documents d
         WHERE d.user_id = ? AND (d.title LIKE ? OR d.content LIKE ?)
         ORDER BY d.title ASC LIMIT ?`,
        [userId, `%${keyword}%`, `%${keyword}%`, lim]
      )
      return { count: rows.length, documents: rows }
    },
  },

  }
}

// Agent entry point
export function runAgent(userId: string, messages: Array<{ role: string; content: string }>, modelId?: string) {
  const tools = createTools(userId)
  const model = modelId || process.env.AGENT_MODEL || DEFAULT_MODEL
  return streamText({
    model: openrouter(model),
    system: SYSTEM_PROMPT,
    messages: messages as any,
    tools,
    stopWhen: stepCountIs(10),
  })
}
