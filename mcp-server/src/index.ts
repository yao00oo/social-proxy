// Social Proxy MCP Server — Neon PostgreSQL 版
// 纯 MCP 工具服务器，无同步/daemon，连接云数据库查询数据

// ── 1. 加载 .env ────────────────────────────────────────
import fs from 'fs'
import path from 'path'
const envPath = path.resolve(__dirname, '../../.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

// ── 2. 依赖 ─────────────────────────────────────────────
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { neon } from '@neondatabase/serverless'

// ── 3. Neon SQL helper ──────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[social-proxy] DATABASE_URL 未设置。请运行 npx social-proxy-mcp setup')
  process.exit(1)
}

const sql = neon(DATABASE_URL)

/** 执行查询，自动把 ? 转为 $1,$2,... */
async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  let i = 0
  const pgText = text.replace(/\?/g, () => `$${++i}`)
  return await sql.query(pgText, params) as T[]
}

async function queryOne<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] || null
}

async function exec(text: string, params: any[] = []): Promise<void> {
  await query(text, params)
}

// ── 4. 获取 userId ──────────────────────────────────────
async function getUserId(): Promise<string> {
  if (process.env.BOTOOK_USER_ID) return process.env.BOTOOK_USER_ID
  const row = await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1')
  if (!row) {
    console.error('[social-proxy] 数据库中没有用户，请先在 botook.ai 登录创建账号')
    process.exit(1)
  }
  return row.id
}

// ── 5. MCP Server ───────────────────────────────────────
const server = new McpServer({
  name: 'social-proxy',
  version: '2.0.0',
})

// ── Tool: get_contacts ──────────────────────────────────
server.tool(
  'get_contacts',
  '获取联系人列表，按最近联系时间排序。可搜索姓名。',
  {
    search: z.string().optional().describe('按姓名搜索'),
    limit: z.number().optional().describe('返回数量，默认20，最大200'),
  },
  async ({ search, limit }) => {
    const userId = await getUserId()
    const lim = Math.min(limit ?? 20, 200)

    const where = search
      ? `WHERE t.user_id = $1 AND t.name LIKE '%' || $2 || '%'`
      : `WHERE t.user_id = $1`
    const params: any[] = search ? [userId, search] : [userId]

    const rows = await query(`
      SELECT t.name, t.type, t.last_message_at,
        COUNT(m.id) as message_count
      FROM threads t
      LEFT JOIN messages m ON m.thread_id = t.id
      ${where}
      GROUP BY t.id, t.name, t.type, t.last_message_at
      ORDER BY t.last_message_at DESC NULLS LAST
      LIMIT $${params.length + 1}
    `, [...params, lim])

    const countRow = await queryOne<{ n: number }>(
      'SELECT COUNT(*) as n FROM threads WHERE user_id = $1', [userId]
    )

    return {
      content: [{
        type: 'text',
        text: `共 ${countRow?.n ?? 0} 个会话，返回 ${rows.length} 条：\n` + JSON.stringify(rows, null, 2),
      }],
    }
  }
)

// ── Tool: get_history ───────────────────────────────────
server.tool(
  'get_history',
  '获取与某人的聊天记录。支持模糊匹配联系人名。返回最近消息和历史摘要。',
  {
    contact_name: z.string().describe('联系人姓名（支持模糊匹配）'),
    limit: z.number().optional().describe('返回消息条数，默认50'),
  },
  async ({ contact_name, limit }) => {
    const userId = await getUserId()
    const lim = limit ?? 50

    // 查找匹配的 thread
    const threads = await query<{ id: number; name: string }>(
      `SELECT id, name FROM threads
       WHERE name LIKE '%' || $1 || '%' AND user_id = $2
       ORDER BY CASE WHEN name LIKE '% (私聊)' THEN 0 ELSE 1 END, length(name) ASC
       LIMIT 5`,
      [contact_name, userId]
    )

    if (threads.length === 0) {
      return { content: [{ type: 'text', text: `未找到匹配"${contact_name}"的会话` }] }
    }

    const actualName = threads[0].name
    const threadIds = threads.map(t => t.id)
    const placeholders = threadIds.map((_, i) => `$${i + 1}`).join(',')
    const userIdIdx = threadIds.length + 1

    const totalRow = await queryOne<{ n: number }>(
      `SELECT COUNT(*) as n FROM messages WHERE thread_id IN (${placeholders}) AND user_id = $${userIdIdx}`,
      [...threadIds, userId]
    )
    const total = totalRow?.n ?? 0

    const messages = await query(`
      SELECT direction, sender_name, content, timestamp FROM (
        SELECT m.direction, m.sender_name, m.content, m.timestamp
        FROM messages m
        WHERE m.thread_id IN (${placeholders}) AND m.user_id = $${userIdIdx}
        ORDER BY m.timestamp DESC LIMIT $${userIdIdx + 1}
      ) sub ORDER BY timestamp ASC
    `, [...threadIds, userId, lim])

    // 获取摘要
    const summaryRow = await queryOne<{ summary: string; start_time: string; end_time: string }>(
      `SELECT s.summary, s.start_time, s.end_time FROM summaries s
       WHERE s.thread_id IN (${placeholders}) AND s.user_id = $${userIdIdx} AND s.summary IS NOT NULL
       ORDER BY s.end_time DESC LIMIT 1`,
      [...threadIds, userId]
    )

    let text = `会话：${actualName}\n消息总数：${total} 条\n`
    if (summaryRow?.summary) {
      text += `\n【历史背景摘要（${summaryRow.start_time} ~ ${summaryRow.end_time}）】\n${summaryRow.summary}\n`
    }
    text += `\n【最近 ${messages.length} 条原文】\n`
    text += messages.map((m: any) =>
      `[${m.timestamp?.slice(0, 16)} ${m.direction === 'sent' ? '我' : (m.sender_name || actualName)}] ${m.content}`
    ).join('\n')

    return { content: [{ type: 'text', text }] }
  }
)

// ── Tool: get_summaries ─────────────────────────────────
server.tool(
  'get_summaries',
  '获取会话的 AI 摘要，可按联系人名或关键词搜索。用于快速了解全局。',
  {
    search: z.string().optional().describe('按会话名或摘要内容关键词搜索'),
  },
  async ({ search }) => {
    const userId = await getUserId()

    const params: any[] = search
      ? [userId, `%${search}%`, `%${search}%`]
      : [userId]
    const rows = await query(`
      SELECT t.name, s.summary, s.start_time, s.end_time, s.message_count
      FROM summaries s JOIN threads t ON s.thread_id = t.id
      WHERE s.summary IS NOT NULL AND s.user_id = $1
        ${search ? 'AND (t.name LIKE $2 OR s.summary LIKE $3)' : ''}
      ORDER BY s.end_time DESC LIMIT 30
    `, params)

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: search ? `未找到匹配"${search}"的摘要` : '暂无摘要' }] }
    }

    const text = rows.map((r: any) =>
      `【${r.name}】${r.start_time?.slice(0, 10)} ~ ${r.end_time?.slice(0, 10)}（${r.message_count} 条）\n${r.summary}`
    ).join('\n\n---\n\n')

    return { content: [{ type: 'text', text: `共 ${rows.length} 条摘要：\n\n${text}` }] }
  }
)

// ── Tool: search_messages ───────────────────────────────
server.tool(
  'search_messages',
  '在聊天记录中按关键词搜索，用于找具体事件、日期、数字等细节。',
  {
    keyword: z.string().describe('搜索关键词'),
    contact_name: z.string().optional().describe('限定在某个联系人的聊天中搜索（可选）'),
    limit: z.number().optional().describe('返回条数，默认30'),
  },
  async ({ keyword, contact_name, limit }) => {
    const userId = await getUserId()
    const lim = Math.min(limit ?? 30, 100)

    let rows: any[]
    if (contact_name) {
      const threadIds = (await query<{ id: number }>(
        `SELECT id FROM threads WHERE name LIKE '%' || $1 || '%' AND user_id = $2 LIMIT 10`,
        [contact_name, userId]
      )).map(t => t.id)

      if (threadIds.length === 0) {
        return { content: [{ type: 'text', text: `未找到匹配"${contact_name}"的会话` }] }
      }

      const placeholders = threadIds.map((_, i) => `$${i + 1}`).join(',')
      const p = threadIds.length
      rows = await query(
        `SELECT t.name, m.direction, m.sender_name, m.content, m.timestamp
         FROM messages m JOIN threads t ON m.thread_id = t.id
         WHERE m.thread_id IN (${placeholders}) AND m.user_id = $${p + 1} AND m.content LIKE '%' || $${p + 2} || '%'
         ORDER BY m.timestamp DESC LIMIT $${p + 3}`,
        [...threadIds, userId, keyword, lim]
      )
    } else {
      rows = await query(
        `SELECT t.name, m.direction, m.sender_name, m.content, m.timestamp
         FROM messages m JOIN threads t ON m.thread_id = t.id
         WHERE m.user_id = $1 AND m.content LIKE '%' || $2 || '%'
         ORDER BY m.timestamp DESC LIMIT $3`,
        [userId, keyword, lim]
      )
    }

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `未找到包含"${keyword}"的消息` }] }
    }

    const text = rows.map((r: any) =>
      `[${r.timestamp?.slice(0, 16)} ${r.name} ${r.direction === 'sent' ? '←我' : '→'} ${r.sender_name || ''}] ${r.content}`
    ).join('\n')

    return { content: [{ type: 'text', text: `找到 ${rows.length} 条：\n\n${text}` }] }
  }
)

// ── Tool: get_new_messages ──────────────────────────────
server.tool(
  'get_new_messages',
  '获取最近收到的消息（按时间倒序）。\n\n⚠️ 拿到消息后，先完整输出每条消息的解读分析，然后才能调用 mark_messages_read。',
  {
    limit: z.number().optional().describe('返回条数，默认50'),
  },
  async ({ limit }) => {
    const userId = await getUserId()
    const lim = Math.min(limit ?? 50, 100)

    const rows = await query<any>(`
      SELECT m.id, t.name as thread_name, t.type as thread_type,
        m.sender_name, m.content, m.timestamp, m.is_read, m.metadata
      FROM messages m
      JOIN threads t ON m.thread_id = t.id
      WHERE m.direction = 'received' AND m.user_id = $1
      ORDER BY m.timestamp DESC LIMIT $2
    `, [userId, lim])

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: '没有新消息' }] }
    }

    const unread = rows.filter((m: any) => !m.is_read).length

    const text = rows.map((m: any) => {
      const metadata = m.metadata || {}
      const isAtMe = !!(metadata.mentions && metadata.mentions.length > 0)
      const tags = [isAtMe ? '⚡@我' : '', m.is_read ? '✓已读' : '🆕'].filter(Boolean).join(' ')
      return `━━━ ID:${m.id} | ${m.thread_name} | ${m.timestamp?.slice(0, 16)} ${tags} ━━━\n[${m.sender_name || ''}] ${m.content}`
    }).join('\n\n')

    return { content: [{ type: 'text', text: `共 ${rows.length} 条消息（${unread}条未读）：\n\n${text}` }] }
  }
)

// ── Tool: get_stats ─────────────────────────────────────
server.tool(
  'get_stats',
  '全局统计：会话数、消息数、联系人数。',
  {},
  async () => {
    const userId = await getUserId()

    const [threadsRow, messagesRow, contactsRow] = await Promise.all([
      queryOne<{ n: number }>('SELECT COUNT(*) as n FROM threads WHERE user_id = $1', [userId]),
      queryOne<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE user_id = $1', [userId]),
      queryOne<{ n: number }>('SELECT COUNT(*) as n FROM contacts WHERE user_id = $1', [userId]),
    ])

    const stats = {
      threads: threadsRow?.n ?? 0,
      messages: messagesRow?.n ?? 0,
      contacts: contactsRow?.n ?? 0,
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
    }
  }
)

// ── Tool: mark_messages_read ────────────────────────────
server.tool(
  'mark_messages_read',
  '将消息标记为已读。⚠️ 只能在你已经向用户输出了消息解读分析之后才能调用。',
  {
    ids: z.array(z.number()).describe('要标记已读的消息 ID 列表'),
  },
  async ({ ids }) => {
    if (ids.length === 0) {
      return { content: [{ type: 'text', text: '没有需要标记的消息' }] }
    }

    const userId = await getUserId()
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',')
    await exec(
      `UPDATE messages SET is_read = 1 WHERE id IN (${placeholders}) AND user_id = $${ids.length + 1}`,
      [...ids, userId]
    )

    return { content: [{ type: 'text', text: `已标记 ${ids.length} 条消息为已读` }] }
  }
)

// ── 6. 启动 ─────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[social-proxy] MCP Server v2.0 已启动（Neon PostgreSQL，无本地同步）')
}

main().catch((err) => {
  console.error('[social-proxy] 启动失败:', err)
  process.exit(1)
})
