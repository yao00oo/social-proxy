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
import { sendFeishuMessage } from './tools/send_feishu_message'
import { searchMessages } from './tools/search_messages'
import { getNewMessages, markMessagesRead } from './tools/get_new_messages'

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
  '获取某联系人的聊天记录。当消息总数超过 limit 时，自动附带历史摘要作为背景，再加上最近 limit 条原文，确保上下文完整。',
  {
    contact_name: z.string().describe('联系人姓名，需与导入时的名字一致'),
    limit: z.number().optional().describe('返回最近原文条数，默认50条'),
  },
  async ({ contact_name, limit }) => {
    const result = getHistory(contact_name, limit ?? 50)
    let text = `消息总数：${result.total} 条\n`
    if (result.summary) {
      text += `\n【历史背景摘要（${result.summaryRange}）】\n${result.summary}\n`
    }
    text += `\n【最近 ${result.messages.length} 条原文】\n`
    text += result.messages.map(m =>
      `[${m.timestamp.slice(0, 16)} ${m.direction === 'sent' ? '我' : contact_name}] ${m.content}`
    ).join('\n')
    return {
      content: [{ type: 'text', text }],
    }
  }
)

// ── Tool: search_messages ─────────────────────────────
server.tool(
  'search_messages',
  '在原始聊天记录中按关键词搜索，用于找到摘要中未体现的具体事件、日期、数字等细节',
  {
    keyword: z.string().describe('搜索关键词'),
    contact_name: z.string().optional().describe('限定在某个联系人的聊天中搜索（可选）'),
    limit: z.number().optional().describe('返回条数，默认30条'),
  },
  async ({ keyword, contact_name, limit }) => {
    const results = searchMessages(keyword, contact_name, limit ?? 30)
    if (results.length === 0) {
      return { content: [{ type: 'text', text: `未找到包含"${keyword}"的消息` }] }
    }
    const text = results.map(r =>
      `[${r.timestamp.slice(0, 16)} ${r.contact_name} ${r.direction === 'sent' ? '←我' : '→'}] ${r.content}`
    ).join('\n')
    return {
      content: [{ type: 'text', text: `找到 ${results.length} 条：\n\n${text}` }],
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

// ── Tool: send_feishu_message ─────────────────────────
server.tool(
  'send_feishu_message',
  '以用户身份给飞书联系人发消息。suggest 模式下返回草稿需用户确认，auto 模式直接发送。适用于没有邮箱但有飞书记录的联系人。',
  {
    contact_name: z.string().describe('联系人姓名，需与飞书同步时的名字一致'),
    content: z.string().describe('消息内容'),
  },
  async ({ contact_name, content }) => {
    const result = await sendFeishuMessage({ contact_name, content })
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  }
)

// ── Tool: get_new_messages ────────────────────────────
server.tool(
  'get_new_messages',
  '获取最近N分钟的飞书消息（含聊天上下文）。is_at_me=true 表示消息@了我或回复了我的消息，需要优先处理。处理完后可调用 mark_messages_read 标记已读。',
  {
    minutes: z.number().optional().describe('时间窗口（分钟），默认5'),
    limit: z.number().optional().describe('返回条数，默认50'),
  },
  async ({ minutes, limit }) => {
    const msgs = getNewMessages(minutes ?? 5, limit ?? 50)
    if (msgs.length === 0) {
      return { content: [{ type: 'text', text: '没有新消息' }] }
    }
    const unread = msgs.filter(m => !m.is_read).length
    const atMe = msgs.filter(m => m.is_at_me).length
    const text = msgs.map(m => {
      const history = m.recent_history.map(h =>
        `  ${h.timestamp.slice(0, 16)} [${h.direction === 'sent' ? '我' : m.contact_name}] ${h.content}`
      ).join('\n')
      const tags = [m.is_at_me ? '⚡@我' : '', m.is_read ? '✓已读' : '🆕'].filter(Boolean).join(' ')
      return `━━━ ID:${m.id} | ${m.contact_name} | ${m.created_at.slice(0, 16)} ${tags} ━━━\n新消息：${m.incoming_content}\n最近记录：\n${history || '  （无）'}`
    }).join('\n\n')
    return { content: [{ type: 'text', text: `共 ${msgs.length} 条消息（${unread}条未读，${atMe}条@我）：\n\n${text}` }] }
  }
)

// ── Tool: mark_messages_read ──────────────────────────
server.tool(
  'mark_messages_read',
  '将指定 ID 的消息标记为已读（处理完后调用，避免重复提示）',
  {
    ids: z.array(z.number()).describe('要标记已读的消息 ID 列表'),
  },
  async ({ ids }) => {
    markMessagesRead(ids)
    return { content: [{ type: 'text', text: `已标记 ${ids.length} 条消息为已读` }] }
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
