// 小林 Agent — Vercel AI SDK v6 tool-use agent loop
import { streamText, stepCountIs } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { z } from 'zod'
import { query, queryOne, exec } from './db'
// feishu imports removed — settings read inline with userId filter

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY || '' })
const MODEL = process.env.AGENT_MODEL || 'deepseek/deepseek-chat-v3-0324'

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

// Fuzzy contact name resolver
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
        SELECT name, email, phone, last_contact_at, message_count,
          CASE WHEN last_contact_at IS NULL THEN 9999
            ELSE CAST(EXTRACT(EPOCH FROM NOW() - last_contact_at::timestamp) / 86400 AS INTEGER)
          END AS days_since
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

      // 先精确匹配，再模糊匹配（优先私聊）
      let actualName = contact_name
      const exact = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE contact_name = ? AND user_id = ?', [contact_name, userId])
      if (exact?.n === 0) {
        // 模糊搜索，优先"xxx (私聊)"，其次短名的群聊
        const candidates = await query<{ name: string; message_count: number }>(
          `SELECT name, message_count FROM contacts WHERE name LIKE '%' || ? || '%' AND user_id = ? ORDER BY
            CASE WHEN name LIKE '% (私聊)' THEN 0 ELSE 1 END,
            length(name) ASC LIMIT 5`,
          [contact_name, userId]
        )
        if (candidates.length > 0) {
          actualName = candidates[0].name
        }
      }

      const totalRow = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE contact_name = ? AND user_id = ?', [actualName, userId])
      const total = totalRow?.n ?? 0
      const messages = await query(`
        SELECT direction, content, timestamp FROM (
          SELECT direction, content, timestamp FROM messages WHERE contact_name = ? AND user_id = ? ORDER BY timestamp DESC LIMIT ?
        ) sub ORDER BY timestamp ASC
      `, [actualName, userId, lim])
      const summaryRow = await queryOne<{ summary: string; start_time: string; end_time: string }>('SELECT summary, start_time, end_time FROM chat_summaries WHERE chat_name = ? AND user_id = ? AND summary IS NOT NULL', [actualName, userId])

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
        SELECT chat_name, start_time, end_time, message_count, summary FROM chat_summaries
        WHERE summary IS NOT NULL AND user_id = ? ${search ? 'AND (chat_name LIKE ? OR summary LIKE ?)' : ''}
        ORDER BY end_time DESC LIMIT 20
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
      const rows = contact_name
        ? await query('SELECT contact_name, direction, content, timestamp FROM messages WHERE contact_name = ? AND user_id = ? AND content LIKE ? ORDER BY timestamp DESC LIMIT ?', [contact_name, userId, `%${keyword}%`, lim])
        : await query('SELECT contact_name, direction, content, timestamp FROM messages WHERE user_id = ? AND content LIKE ? ORDER BY timestamp DESC LIMIT ?', [userId, `%${keyword}%`, lim])
      return { count: rows.length, results: rows }
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
      return { total, totalMsgs, buckets, overdue }
    },
  },

  get_new_messages: {
    description: '获取最近收到的新消息（含每条消息的聊天上下文、是否@我、AI 建议回复）。用于了解最近发生了什么、谁需要回复。',
    parameters: z.object({
      minutes: z.number().optional().describe('时间窗口（分钟），默认60'),
      limit: z.number().optional().describe('返回条数，默认50'),
    }),
    execute: async ({ minutes, limit }: { minutes?: number; limit?: number }) => {
      const rows = await query<any>(`
        SELECT m.id, m.source_id as message_id, m.contact_name, m.content as incoming_content, m.timestamp as created_at,
          COALESCE(r.is_at_me, 0) as is_at_me, COALESCE(r.is_read, 0) as is_read, r.suggestion
        FROM messages m LEFT JOIN reply_suggestions r ON m.source_id = r.message_id
        WHERE m.timestamp::timestamp > NOW() - (? || ' minutes')::interval AND m.direction = 'received' AND m.user_id = ?
        ORDER BY m.timestamp ASC LIMIT ?
      `, [minutes ?? 60, userId, Math.min(limit ?? 50, 100)])

      // Add recent_history context for each message (like MCP version)
      const msgs = await Promise.all(rows.map(async row => {
        const history = await query<any>(`
          SELECT direction, content, timestamp FROM messages
          WHERE contact_name = ? AND user_id = ? ORDER BY timestamp DESC LIMIT 10
        `, [row.contact_name, userId])
        return {
          ...row,
          is_at_me: !!row.is_at_me,
          is_read: !!row.is_read,
          suggestion: row.suggestion || null,
          recent_history: history.reverse(),
        }
      }))

      const unread = msgs.filter(m => !m.is_read).length
      const atMe = msgs.filter(m => m.is_at_me).length
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
      // Need feishu user token for approvals
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

  }
}

// Agent entry point
export function runAgent(userId: string, messages: Array<{ role: string; content: string }>) {
  const tools = createTools(userId)
  return streamText({
    model: openrouter(MODEL),
    system: SYSTEM_PROMPT,
    messages: messages as any,
    tools,
    stopWhen: stepCountIs(10),
  })
}
