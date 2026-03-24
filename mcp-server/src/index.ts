// Social Proxy MCP Server 入口
// 通过 stdio 与 Claude 通信，暴露三个工具: get_contacts / get_history / send_email

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getContacts } from './tools/get_contacts'
import { getStats } from './tools/get_stats'
import { getSummaries } from './tools/get_summaries'
import { getDocSummaries } from './tools/get_doc_summaries'
import { getDb } from './db'
import { getHistory } from './tools/get_history'
import { sendEmail } from './tools/send_email'

const server = new McpServer({
  name: 'social-proxy',
  version: '1.0.0',
})

// ── Tool: get_contacts ────────────────────────────────
server.tool(
  'get_contacts',
  '获取联系人列表（默认返回最久未联系的50人）。可用 search 参数按姓名搜索，limit 参数控制返回数量（最大200）',
  {
    search: z.string().optional().describe('按姓名关键词搜索'),
    limit: z.number().optional().describe('返回数量，默认50，最大200'),
  },
  async ({ search, limit }) => {
    const contacts = getContacts(search, Math.min(limit ?? 50, 200))
    const total = getDb().prepare('SELECT COUNT(*) as n FROM contacts').get() as any
    return {
      content: [
        {
          type: 'text',
          text: `共 ${total.n} 个联系人，返回 ${contacts.length} 条：\n` + JSON.stringify(contacts, null, 2),
        },
      ],
    }
  }
)

// ── Tool: get_summaries ───────────────────────────────
server.tool(
  'get_summaries',
  '获取所有会话的 AI 摘要（时间线、话题、关系），用于快速了解全局或搜索特定话题，再决定是否深入查原文',
  {
    search: z.string().optional().describe('按会话名或摘要内容关键词搜索'),
  },
  async ({ search }) => {
    const summaries = getSummaries(search)
    const text = summaries.map(s =>
      `【${s.chat_name}】${s.start_time?.slice(0,10)} ~ ${s.end_time?.slice(0,10)} (${s.message_count}条)\n${s.summary}`
    ).join('\n\n---\n\n')
    return {
      content: [{ type: 'text', text: `共 ${summaries.length} 个会话摘要：\n\n${text}` }],
    }
  }
)

// ── Tool: get_doc_summaries ───────────────────────────
server.tool(
  'get_doc_summaries',
  '获取飞书文档摘要列表，可按关键词搜索标题或内容，用于快速定位相关文档',
  { search: z.string().optional().describe('按标题或内容关键词搜索') },
  async ({ search }) => {
    const docs = getDocSummaries(search)
    const text = docs.map(d =>
      `【${d.title}】(${d.doc_type}) ${d.modified_time?.slice(0, 10)}\n${d.summary || '暂无摘要'}\n${d.url}`
    ).join('\n\n---\n\n')
    return {
      content: [{ type: 'text', text: `共 ${docs.length} 个文档：\n\n${text}` }],
    }
  }
)

// ── Tool: get_stats ───────────────────────────────────
server.tool(
  'get_stats',
  '全量联系人统计分析：失联分布、最活跃、最久未联系、最近活跃等，用于整体了解社交关系现状',
  {},
  async () => {
    const stats = getStats()
    return {
      content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
    }
  }
)

// ── Tool: get_history ─────────────────────────────────
server.tool(
  'get_history',
  '获取某联系人的聊天记录，用于理解关系上下文和起草消息内容',
  {
    contact_name: z.string().describe('联系人姓名，需与导入时的名字一致'),
    limit: z.number().optional().describe('返回条数，默认30条'),
  },
  async ({ contact_name, limit }) => {
    const messages = getHistory(contact_name, limit ?? 30)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(messages, null, 2),
        },
      ],
    }
  }
)

// ── Tool: send_email ──────────────────────────────────
server.tool(
  'send_email',
  '以用户身份给联系人发邮件。suggest 模式下返回草稿需用户确认，auto 模式直接发送。',
  {
    contact_name: z.string().describe('联系人姓名'),
    subject: z.string().describe('邮件主题'),
    body: z.string().describe('邮件正文'),
  },
  async ({ contact_name, subject, body }) => {
    const result = await sendEmail({ contact_name, subject, body })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    }
  }
)

// ── 启动 ──────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // MCP server 通过 stderr 打日志，不影响 stdio 通信
  console.error('[social-proxy] MCP Server 已启动')
}

main().catch((err) => {
  console.error('[social-proxy] 启动失败:', err)
  process.exit(1)
})
