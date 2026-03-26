// Social Proxy MCP Server 入口
// 通过 stdio 与 Claude 通信，暴露三个工具: get_contacts / get_history / send_email

// 加载项目根目录的 .env 文件
import fs from 'fs'
import path from 'path'
const envPath = path.resolve(__dirname, '../../.env')
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
  }
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { getContacts } from './tools/get_contacts'
import { getStats } from './tools/get_stats'
import { getSummaries, formatSummaries } from './tools/get_summaries'
import { getDocSummaries } from './tools/get_doc_summaries'
import { getDb } from './db'
import { getHistory } from './tools/get_history'
import { sendEmail } from './tools/send_email'
import { sendFeishuMessage } from './tools/send_feishu_message'
import { searchMessages } from './tools/search_messages'
import { getNewMessages, markMessagesRead } from './tools/get_new_messages'
import { getApprovalTasks, getApprovalDetail } from './tools/get_approvals'

// MCP 模式下的用户 ID（本地单用户）
const USER_ID = process.env.DEFAULT_USER_ID || 'local'

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
    const contacts = getContacts(USER_ID, search, Math.min(limit ?? 50, 200))
    const total = getDb().prepare('SELECT COUNT(*) as n FROM contacts WHERE user_id = ?').get(USER_ID) as any
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
    const summaries = getSummaries(USER_ID, search)
    return {
      content: [{ type: 'text', text: formatSummaries(summaries) }],
    }
  }
)

// ── Tool: sync_doc ──────────────────────────────────
import { syncDocByUrl } from './feishu/docs'

server.tool(
  'sync_doc',
  '手动同步一个飞书文档/wiki到本地数据库。传入飞书文档URL，自动识别并同步内容。',
  { url: z.string().describe('飞书文档或wiki的URL') },
  async ({ url }) => {
    const result = await syncDocByUrl(url)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// ── Tool: get_doc_summaries ───────────────────────────
server.tool(
  'get_doc_summaries',
  '获取飞书文档摘要列表，可按关键词搜索标题或内容，用于快速定位相关文档。找到目标后用 get_doc_content 读取完整内容。',
  { search: z.string().optional().describe('按标题或内容关键词搜索') },
  async ({ search }) => {
    const docs = getDocSummaries(USER_ID, search)
    const text = docs.map(d =>
      `【${d.title}】(${d.doc_type}) ${d.modified_time?.slice(0, 10)} doc_id:${d.doc_id}\n${d.summary || '暂无摘要'}\n${d.url}`
    ).join('\n\n---\n\n')
    return {
      content: [{ type: 'text', text: `共 ${docs.length} 个文档：\n\n${text}` }],
    }
  }
)

// ── Tool: get_doc_content ───────────────────────────
server.tool(
  'get_doc_content',
  '获取飞书文档的完整内容。传入 doc_id（从 get_doc_summaries 的结果中获取）。',
  { doc_id: z.string().describe('文档ID，从 get_doc_summaries 结果的 doc_id 字段获取') },
  async ({ doc_id }) => {
    const { getDocContent } = await import('./tools/get_doc_summaries')
    const doc = await getDocContent(USER_ID, doc_id)
    if (!doc) {
      return { content: [{ type: 'text', text: '文档不存在' }] }
    }
    const header = `【${doc.title}】(${doc.doc_type})\n${doc.url}\n\n`
    if (!doc.content) {
      return { content: [{ type: 'text', text: header + `该文档类型 (${doc.doc_type}) 暂不支持内容提取。可在浏览器打开查看：${doc.url}` }] }
    }
    return { content: [{ type: 'text', text: header + doc.content }] }
  }
)

// ── Tool: get_stats ───────────────────────────────────
server.tool(
  'get_stats',
  '全量联系人统计分析：失联分布、最活跃、最久未联系、最近活跃等，用于整体了解社交关系现状',
  {},
  async () => {
    const stats = getStats(USER_ID)
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
    const result = getHistory(USER_ID, contact_name, limit ?? 50)
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

// ── Tool: get_all_messages ────────────────────────────
server.tool(
  'get_all_messages',
  '获取某联系人的全部聊天记录（不限条数），或获取最近N分钟所有聊天的完整消息。适合需要完整上下文的场景。',
  {
    contact_name: z.string().optional().describe('联系人姓名（不传则返回所有人的最近消息）'),
    minutes: z.number().optional().describe('时间窗口（分钟），仅在不指定联系人时生效，默认30'),
    offset: z.number().optional().describe('跳过前N条，用于分页'),
    limit: z.number().optional().describe('返回条数，默认500，最大2000'),
  },
  async ({ contact_name, minutes, offset, limit }) => {
    const db = getDb()
    const lim = Math.min(limit ?? 500, 2000)
    const off = offset ?? 0

    let rows: any[]
    let total: number

    if (contact_name) {
      total = (db.prepare(`SELECT COUNT(*) as n FROM messages WHERE contact_name = ? AND user_id = ?`).get(contact_name, USER_ID) as any).n
      rows = db.prepare(`
        SELECT contact_name, direction, content, timestamp FROM messages
        WHERE contact_name = ? AND user_id = ? ORDER BY timestamp ASC LIMIT ? OFFSET ?
      `).all(contact_name, USER_ID, lim, off)
    } else {
      const mins = minutes ?? 30
      total = (db.prepare(`SELECT COUNT(*) as n FROM messages WHERE timestamp > datetime('now', '-' || ? || ' minutes') AND user_id = ?`).get(mins, USER_ID) as any).n
      rows = db.prepare(`
        SELECT contact_name, direction, content, timestamp FROM messages
        WHERE timestamp > datetime('now', '-' || ? || ' minutes') AND user_id = ?
        ORDER BY timestamp ASC LIMIT ? OFFSET ?
      `).all(mins, USER_ID, lim, off)
    }

    if (rows.length === 0) {
      return { content: [{ type: 'text', text: '没有消息' }] }
    }

    const text = rows.map(m =>
      `[${m.timestamp.slice(0, 16)} ${m.contact_name} ${m.direction === 'sent' ? '←我' : '→'}] ${m.content}`
    ).join('\n')

    const header = `共 ${total} 条，返回 ${rows.length} 条（offset=${off}）${total > off + lim ? `\n还有 ${total - off - lim} 条未显示，传 offset=${off + lim} 获取下一页` : ''}\n\n`
    return { content: [{ type: 'text', text: header + text }] }
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
    const results = searchMessages(USER_ID, keyword, contact_name, limit ?? 30)
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
    subject: z.string().optional().describe('邮件主题,不传则自动从正文生成'),
    body: z.string().describe('邮件正文'),
  },
  async ({ contact_name, subject, body }) => {
    if (!subject) subject = body.slice(0, 30).replace(/\n/g, ' ') + (body.length > 30 ? '...' : '')
    const result = await sendEmail(USER_ID, { contact_name, subject, body })
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
    const result = await sendFeishuMessage(USER_ID, { contact_name, content })
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  }
)

// ── Tool: get_new_messages ────────────────────────────
server.tool(
  'get_new_messages',
  '获取最近N分钟的飞书消息（含聊天上下文）。\n\n⚠️ 严格要求：拿到消息后，你必须先完整输出每条消息的解读分析，然后才能调用 mark_messages_read。禁止跳过解读直接标记已读。\n\n解读要求：\n1）逐条展示消息内容并分析含义\n2）群聊消息归纳讨论主题和关键结论\n3）标注需要用户关注或回复的内容\n4）is_at_me=true 的消息优先处理并建议回复\n5）所有解读输出完毕后，最后再调用 mark_messages_read',
  {
    minutes: z.number().optional().describe('时间窗口（分钟），默认5'),
    limit: z.number().optional().describe('返回条数，默认50'),
  },
  async ({ minutes, limit }) => {
    const msgs = getNewMessages(USER_ID, minutes ?? 5, limit ?? 50)
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
      const suggestionText = m.suggestion ? `\n回复建议：\n${m.suggestion}` : ''
      return `━━━ ID:${m.id} | ${m.contact_name} | ${m.created_at.slice(0, 16)} ${tags} ━━━\n新消息：${m.incoming_content}\n最近记录：\n${history || '  （无）'}${suggestionText}`
    }).join('\n\n')
    return { content: [{ type: 'text', text: `共 ${msgs.length} 条消息（${unread}条未读，${atMe}条@我）：\n\n${text}` }] }
  }
)

// ── Tool: mark_messages_read ──────────────────────────
server.tool(
  'mark_messages_read',
  '将消息标记为已读。⚠️ 只能在你已经向用户输出了消息解读分析之后才能调用此工具。如果你还没有解读消息内容，禁止调用。',
  {
    ids: z.array(z.number()).describe('要标记已读的消息 ID 列表'),
  },
  async ({ ids }) => {
    markMessagesRead(USER_ID, ids)
    return { content: [{ type: 'text', text: `已标记 ${ids.length} 条消息为已读` }] }
  }
)

// ── Tool: get_approvals ──────────────────────────────
server.tool(
  'get_approvals',
  '查询飞书审批任务。topic=1 待审批，topic=2 已审批，topic=3 我发起的。返回任务列表，用 instance_code 可查看详情。',
  {
    topic: z.number().optional().describe('1=待审批（默认），2=已审批，3=我发起的'),
    limit: z.number().optional().describe('返回数量，默认20，最大200'),
  },
  async ({ topic, limit }) => {
    const tasks = await getApprovalTasks(USER_ID, topic ?? 1, limit ?? 20)
    if (tasks.length === 0) {
      return { content: [{ type: 'text', text: '没有审批任务' }] }
    }
    const text = tasks.map((t, i) =>
      `${i + 1}. 【${t.title}】发起人：${t.initiator_name} | ${t.create_time} | 状态：${t.status}\n   instance_code: ${t.instance_code}`
    ).join('\n\n')
    return { content: [{ type: 'text', text: `共 ${tasks.length} 条：\n\n${text}` }] }
  }
)

// ── Tool: get_approval_detail ───────────────────────
server.tool(
  'get_approval_detail',
  '获取审批实例详情：表单数据、附件文件、审批节点。附件会返回下载链接（12小时有效）。拿到详情后必须：1）解读所有表单字段；2）如有附件自动下载并解读内容，不要问用户是否需要；3）给出审批进度和需要关注的事项。',
  {
    instance_code: z.string().describe('审批实例 code，从 get_approvals 返回的列表中获取'),
  },
  async ({ instance_code }) => {
    const detail = await getApprovalDetail(USER_ID, instance_code)
    return {
      content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }],
    }
  }
)

// ── 启动 ──────────────────────────────────────────────
import { quickSync, auditSync } from './feishu/sync'
import { quickDocSync } from './feishu/docs'
import { generateReplySuggestions } from './sync/reply-suggest'

const SYNC_INTERVAL = 15000 // 15秒

function notifyNewMessages(count: number) {
  if (process.platform !== 'darwin' || count <= 0) return
  try {
    const { execSync } = require('child_process')
    execSync(`osascript -e 'display notification "收到 ${count} 条新飞书消息" with title "Social Proxy" sound name "Ping"'`)
  } catch {}
}

async function runSync() {
  try {
    const [msgResult, docResult] = await Promise.all([
      quickSync().catch(e => ({ imported: 0, errors: 1, _err: e.message })),
      quickDocSync().catch(e => ({ updated: 0, added: 0, _err: e.message })),
    ])
    const r = msgResult as any
    const d = docResult as any
    if (r.imported > 0) {
      console.error(`[同步] ${r.imported} 条新消息`)
      notifyNewMessages(r.imported)
    }
    if (d.updated > 0 || d.added > 0) console.error(`[同步] 文档: ${d.added} 新增, ${d.updated} 更新`)
    if (r._err) console.error(`[同步] 消息出错: ${r._err}`)
    if (d._err) console.error(`[同步] 文档出错: ${d._err}`)

    // 为未处理的消息生成 AI 回复建议
    generateReplySuggestions().catch(e =>
      console.error(`[回复建议] 生成失败: ${e.message}`)
    )
  } catch (e: any) {
    console.error(`[同步] 出错: ${e.message}`)
  }
}

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // 启动时立即同步一次
  runSync()
  // 之后每15秒同步
  setInterval(runSync, SYNC_INTERVAL)

  // 每10分钟审计一次消息完整性
  const AUDIT_INTERVAL = 10 * 60 * 1000
  setInterval(() => {
    auditSync().catch(e => console.error('[audit] error:', e.message))
  }, AUDIT_INTERVAL)

  console.error(`[social-proxy] MCP Server 已启动，每${SYNC_INTERVAL / 1000}s同步，每10min审计`)
}

main().catch((err) => {
  console.error('[social-proxy] 启动失败:', err)
  process.exit(1)
})
