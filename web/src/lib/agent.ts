// 小林 Agent — Vercel AI SDK v6 tool-use agent loop
import { streamText, stepCountIs } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { z } from 'zod'
import { query, queryOne, exec } from './db'
// feishu imports removed — settings read inline with userId filter

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY || '' })
const DEFAULT_MODEL = 'deepseek/deepseek-chat-v3-0324'

export const AVAILABLE_MODELS = [
  { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', description: '性价比最高，推荐' },
  { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', description: '中文能力强' },
  { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick', description: 'Meta 最新，综合强' },
  { id: 'cohere/command-a', name: 'Cohere Command A', description: '工具调用稳定' },
  { id: 'mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1', description: '快速响应' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', description: '经典版' },
]

const SYSTEM_PROMPT = `你是"小林"，用户的私人社交助理。

## 核心工作流
当用户让你查看消息、待办、动态、最近情况时，你应该：
1. 先调用 get_new_messages 获取最近收到的消息
2. 再调用 get_approvals 获取飞书审批任务
3. 按平台分类展示（飞书/Gmail/iMessage/终端），用户说"看飞书"就只看飞书的
4. 把消息按优先级分类：需要回复的 vs 纯通知
5. 对需要回复的消息，结合 recent_history 上下文给出建议回复
6. 区分@我的消息（优先处理）和普通消息

"待办事项" = 未回复的消息 + 飞书审批，不要只查审批。

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
- **绝对不要输出原始 JSON 数据**，必须用自然语言总结分析
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
    description: '获取最近收到的消息，按时间倒序。可按平台过滤（feishu/gmail/imessage/terminal）。',
    parameters: z.object({
      limit: z.number().optional().describe('返回条数，默认50'),
      platform: z.string().optional().describe('按平台过滤：feishu/gmail/imessage/terminal，不传返回全部'),
    }),
    execute: async ({ limit, platform }: { limit?: number; platform?: string }) => {
      // Build open_id → name mapping from contact_identities
      const idMapping = await query<{ platform_uid: string; display_name: string; contact_name: string }>(
        `SELECT ci.platform_uid, ci.display_name, c.name as contact_name
         FROM contact_identities ci JOIN contacts c ON ci.contact_id = c.id
         WHERE c.user_id = ? AND ci.platform_uid LIKE 'ou_%'`, [userId]
      )
      const nameMap = new Map<string, string>()
      for (const row of idMapping) {
        const name = row.contact_name || row.display_name
        if (name && !name.startsWith('ou_')) nameMap.set(row.platform_uid, name)
      }
      const resolveName = (name: string | null) => {
        if (!name) return '未知'
        if (name.startsWith('ou_')) return nameMap.get(name) || name.slice(0, 8) + '...'
        return name
      }

      const rows = await query<any>(`
        SELECT m.id, m.platform_msg_id as message_id, t.name as thread_name, t.type as thread_type,
          m.sender_name, m.content as incoming_content, m.timestamp as created_at,
          COALESCE(m.is_read, 0) as is_read, m.metadata, ch.platform
        FROM messages m
        JOIN threads t ON m.thread_id = t.id
        JOIN channels ch ON m.channel_id = ch.id
        WHERE m.direction = 'received' AND m.user_id = ?
          AND m.sender_name NOT IN ('机器人', '系统消息')
          ${platform ? 'AND ch.platform = ?' : ''}
        ORDER BY m.timestamp DESC LIMIT ?
      `, platform ? [userId, platform, Math.min(limit ?? 50, 100)] : [userId, Math.min(limit ?? 50, 100)])

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
          sender_name: resolveName(row.sender_name),
          is_at_me: isAtMe,
          is_read: !!row.is_read,
          recent_history: history.reverse().map((h: any) => ({
            ...h,
            sender_name: h.direction === 'sent' ? '我' : resolveName(h.sender_name),
          })),
        }
      }))

      const unread = msgs.filter((m: any) => !m.is_read).length
      const atMe = msgs.filter((m: any) => m.is_at_me).length

      // 按会话分组，每个会话只显示最新消息 + 未读数
      const threadGroups = new Map<string, { name: string; platform: string; messages: any[]; unread: number }>()
      for (const m of msgs) {
        const key = m.thread_name || 'Unknown'
        if (!threadGroups.has(key)) {
          threadGroups.set(key, { name: key, platform: m.platform, messages: [], unread: 0 })
        }
        const group = threadGroups.get(key)!
        group.messages.push(m)
        if (!m.is_read) group.unread++
      }

      const threads = Array.from(threadGroups.values()).map(g => ({
        thread: g.name,
        platform: g.platform,
        unread: g.unread,
        total: g.messages.length,
        latest: {
          sender: g.messages[0].sender_name,
          content: g.messages[0].incoming_content?.slice(0, 100),
          time: g.messages[0].created_at?.slice(0, 16),
        }
      }))

      return { count: msgs.length, unread, atMe, threads }
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

  install_guide: {
    description: '获取在 Claude Code、OpenClaw、Cursor 等 AI 工具中使用 Social Proxy 的安装指南。当用户问"怎么安装"、"怎么在 Claude 里用"、"MCP 配置"等问题时调用。',
    parameters: z.object({
      platform: z.enum(['claude_code', 'openclaw', 'cursor', 'all']).optional().describe('目标平台，不确定就传 all'),
    }),
    execute: async ({ platform }: { platform?: string }) => {
      const dbUrl = process.env.DATABASE_URL || '（请在 botook.ai 设置页获取）'

      const guides: Record<string, string> = {
        claude_code: `## Claude Code 安装指南

1. 安装 MCP Server：
\`\`\`bash
npm install -g social-proxy-mcp
\`\`\`

2. 在 Claude Code 设置中添加 MCP：
\`\`\`bash
claude mcp add social-proxy -- social-proxy-mcp
\`\`\`

3. 设置数据库连接：
在 \`~/.claude.json\` 的 social-proxy 配置中加入 env：
\`\`\`json
{
  "mcpServers": {
    "social-proxy": {
      "command": "social-proxy-mcp",
      "env": {
        "DATABASE_URL": "${dbUrl}"
      }
    }
  }
}
\`\`\`

4. 重启 Claude Code，试试说"看看最近的消息"`,

        openclaw: `## OpenClaw 安装指南

1. 在 OpenClaw 管理后台 → Channels → 添加 MCP Channel

2. 配置：
   - Command: \`npx social-proxy-mcp\`
   - 环境变量：\`DATABASE_URL=${dbUrl}\`

3. 保存后 OpenClaw 会自动启动 MCP 进程

4. 在对话中就能调用 Social Proxy 的工具了`,

        cursor: `## Cursor 安装指南

1. 安装 MCP Server：
\`\`\`bash
npm install -g social-proxy-mcp
\`\`\`

2. 打开 Cursor Settings → MCP → Add Server

3. 配置：
   - Name: social-proxy
   - Command: social-proxy-mcp
   - Environment: DATABASE_URL=${dbUrl}

4. 重启 Cursor，在 Agent 模式中即可使用`,
      }

      if (platform && platform !== 'all' && guides[platform]) {
        return { guide: guides[platform] }
      }
      return {
        guide: Object.values(guides).join('\n\n---\n\n'),
        tip: '复制上面的配置，DATABASE_URL 是你的专属连接串，不要分享给别人。',
      }
    },
  },

  install_skill: {
    description: '安装一个技能。当用户说"安装 xxx 技能"或提供 SKILL.md URL 时调用。',
    parameters: z.object({
      url: z.string().optional().describe('SKILL.md 的 URL（GitHub raw URL 等）'),
      name: z.string().optional().describe('技能名称（如果用户没给 URL，用名称搜索推荐）'),
      content: z.string().optional().describe('SKILL.md 的完整内容（如果用户直接粘贴）'),
    }),
    execute: async ({ url, name, content }: { url?: string; name?: string; content?: string }) => {
      if (!url && !content) {
        // 没有 URL 也没有内容，返回推荐
        return {
          message: '请提供技能的 SKILL.md URL，或者选择推荐技能：',
          recommendations: [
            { name: 'lark-im', desc: '飞书消息管理', url: 'https://raw.githubusercontent.com/larksuite/cli/main/skills/lark-im/SKILL.md' },
            { name: 'lark-calendar', desc: '飞书日历管理', url: 'https://raw.githubusercontent.com/larksuite/cli/main/skills/lark-calendar/SKILL.md' },
            { name: 'lark-task', desc: '飞书任务管理', url: 'https://raw.githubusercontent.com/larksuite/cli/main/skills/lark-task/SKILL.md' },
          ],
        }
      }

      try {
        let skillContent = content || ''
        let sourceUrl = url || null

        if (url && !content) {
          // 从 URL 下载 SKILL.md
          const res = await fetch(url)
          if (!res.ok) return { success: false, message: `无法下载: HTTP ${res.status}` }
          skillContent = await res.text()
        }

        if (!skillContent) return { success: false, message: '没有技能内容' }

        // 解析 frontmatter
        const fmMatch = skillContent.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/)
        let skillName = name || ''
        let skillDesc = ''
        const metadata: Record<string, string> = {}
        if (fmMatch) {
          for (const line of fmMatch[1].split('\n')) {
            const idx = line.indexOf(':')
            if (idx === -1) continue
            const k = line.slice(0, idx).trim()
            let v = line.slice(idx + 1).trim()
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
            metadata[k] = v
          }
          if (!skillName) skillName = metadata.name || ''
          skillDesc = metadata.description || ''
        }
        if (!skillName) return { success: false, message: '技能名称缺失' }

        await exec(
          `INSERT INTO skills (user_id, name, description, content, source_url, metadata)
           VALUES (?, ?, ?, ?, ?, ?::jsonb)
           ON CONFLICT (user_id, name) DO UPDATE SET description = EXCLUDED.description, content = EXCLUDED.content, source_url = EXCLUDED.source_url, enabled = 1`,
          [userId, skillName, skillDesc, skillContent, sourceUrl, JSON.stringify(metadata)]
        )

        return { success: true, message: `✅ 技能 "${skillName}" 安装成功！` }
      } catch (e: any) {
        return { success: false, message: `安装出错: ${e.message}` }
      }
    },
  },

  use_skill: {
    description: '加载并执行已安装的技能。当用户的请求匹配某个技能的描述时调用。',
    parameters: z.object({
      name: z.string().describe('技能名称'),
      arguments: z.string().optional().describe('传递给技能的参数'),
    }),
    execute: async ({ name, arguments: args }: { name: string; arguments?: string }) => {
      const skill = await queryOne<{ content: string }>('SELECT content FROM skills WHERE user_id = ? AND name = ? AND enabled = 1', [userId, name])
      if (!skill) return { error: `技能 "${name}" 未找到` }
      let content = skill.content
      // Replace $ARGUMENTS placeholder
      if (args) content = content.replace(/\$ARGUMENTS/g, args)
      return { skill_content: content, instruction: '请按照以上技能内容执行操作。' }
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
export async function runAgent(userId: string, messages: Array<{ role: string; content: string }>, modelId?: string) {
  // Load enabled skills for this user
  const userSkills = await query<{ name: string; description: string | null }>('SELECT name, description FROM skills WHERE user_id = ? AND enabled = 1', [userId])

  let skillPrompt = ''
  if (userSkills.length > 0) {
    skillPrompt = '\n\n## 已安装的技能\n当用户请求匹配以下技能时，调用 use_skill 工具加载完整指令。\n\n' +
      userSkills.map(s => `- **${s.name}**: ${s.description || '无描述'}`).join('\n')
  }

  const tools = createTools(userId)
  const model = modelId || process.env.AGENT_MODEL || DEFAULT_MODEL
  return streamText({
    model: openrouter(model),
    system: SYSTEM_PROMPT + skillPrompt,
    messages: messages as any,
    tools,
    stopWhen: stepCountIs(10),
  })
}
