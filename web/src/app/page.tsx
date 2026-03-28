'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
// Custom hook instead of useChat — AI SDK v6 transport API too unstable

// ---------- Types ----------
interface Contact {
  name: string
  avatar: string | null
  tags: string[] | null
  platform: string | null // feishu | gmail | terminal | webhook | custom
  last_contact_at: string | null
  message_count: number
  days_since_last_contact: number
  thread_id?: number
}

interface Message {
  direction: 'sent' | 'received'
  content: string
  timestamp: string
  sender_name?: string
}

interface NewMessage {
  id: number
  thread_name: string
  incoming_content: string
  created_at: string
  is_at_me: boolean
  is_read: boolean
  suggestion: string | null
}

interface DraftData {
  targetName: string
  content: string
  status: 'pending' | 'sent' | 'cancelled'
  platform: 'feishu' | 'email'
}

interface AiBubble {
  id: string
  role: 'ai' | 'user'
  content: string
  time: string
  draft?: DraftData | null
}

interface StatsData {
  total: number
  totalMsgs: number
  buckets: { bucket: string; count: number }[]
}

// ---------- Helpers ----------
function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '从未'
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  if (days < 30) return `${Math.floor(days / 7)}周前`
  return `${Math.floor(days / 30)}月前`
}

function timeStr(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ts?.slice(11, 16) || ''
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
function getInitial(name: string): string { return name.charAt(0) }
function nowTime(): string { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }

function nameColor(name: string): string {
  const colors = ['bg-primary/10 text-primary', 'bg-accent-orange/10 text-accent-orange', 'bg-secondary/10 text-secondary', 'bg-primary-container/20 text-primary-container']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return colors[Math.abs(hash) % colors.length]
}

// Special AI assistant identifier
const AI_ASSISTANT = '__xiaolin__'

// ---------- Main Page ----------
export default function HomePage() {
  const { data: session, status } = useSession()
  const router = useRouter()

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/login')
  }, [status, router])

  const [contacts, setContacts] = useState<Contact[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(AI_ASSISTANT) // default to AI
  const [search, setSearch] = useState('')
  const [newMessages, setNewMessages] = useState<NewMessage[]>([])
  const [stats, setStats] = useState<StatsData | null>(null)
  const [syncStatus, setSyncStatus] = useState<any>(null)

  // Real contact chat state
  const [realMessages, setRealMessages] = useState<Message[]>([])
  const [summary, setSummary] = useState<string | null>(null)
  const [summaryRange, setSummaryRange] = useState<string | null>(null)
  const [totalMsgCount, setTotalMsgCount] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [directInput, setDirectInput] = useState('')

  // AI assistant — custom streaming chat with tool call tracking
  interface ToolCallInfo { name: string; args: any; result?: any }
  interface DraftInfo { to: string; content: string; platform: 'feishu' | 'email'; status: 'pending' | 'sent' | 'cancelled' }
  interface AiMsg { id: string; role: 'user' | 'assistant' | 'tool' | 'draft'; content: string; toolCall?: ToolCallInfo; draft?: DraftInfo }
  const [aiMessages, setAiMessages] = useState<AiMsg[]>([
    { id: 'welcome', role: 'assistant', content: '你好！我是小林，你的社交助理。告诉我你想给谁发什么消息，我来帮你起草。\n\n你可以试试：\n- "帮我看看最近谁没联系了"\n- "帮我给张三发消息催一下项目"\n- "搜索一下关于合同的聊天记录"' },
  ])
  const [aiInput, setAiInput] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const aiSendMessage = useCallback(async (text: string) => {
    if (!text.trim() || aiLoading) return
    const userMsg: AiMsg = { id: `u-${Date.now()}`, role: 'user', content: text.trim() }
    const allMsgs = [...aiMessages, userMsg]
    setAiMessages(allMsgs)
    setAiLoading(true)
    setAiError(null)

    const newMsgs: AiMsg[] = []
    const toolMap = new Map<string, AiMsg>()
    const assistantId = `a-${Date.now()}`
    let textContent = ''

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: allMsgs
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role, content: m.content })),
        }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body?.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const flush = () => {
        // Build display list: tool calls + text + extracted drafts
        const display = [...newMsgs]

        if (textContent.trim()) {
          // Extract <<DRAFT|contact|platform|content>> markers from text
          const draftRegex = /<<DRAFT\|([^|]+)\|([^|]+)\|([\s\S]*?)>>/g
          const cleanedText = textContent.replace(draftRegex, '').trim()
          let draftMatch
          const seenDraftIds = new Set(display.filter(m => m.role === 'draft').map(m => m.id))

          // Reset regex
          draftRegex.lastIndex = 0
          while ((draftMatch = draftRegex.exec(textContent)) !== null) {
            const [, to, platform, content] = draftMatch
            const draftId = `draft-${to}-${content.slice(0, 10)}`
            if (!seenDraftIds.has(draftId)) {
              seenDraftIds.add(draftId)
              display.push({
                id: draftId,
                role: 'draft',
                content: content.trim(),
                draft: {
                  to: to.trim(),
                  content: content.trim(),
                  platform: (platform.trim() as 'feishu' | 'email') || 'feishu',
                  status: 'pending',
                },
              })
            }
          }

          // Show the text part (without draft markers)
          if (cleanedText) {
            const existing = display.find(m => m.id === assistantId)
            if (existing) {
              existing.content = cleanedText
            } else {
              display.push({ id: assistantId, role: 'assistant', content: cleanedText })
            }
          }
        }
        setAiMessages([...allMsgs, ...display])
      }

      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          // Extract all complete markers from buffer
          let changed = true
          while (changed) {
            changed = false

            const toolMatch = buffer.match(/\n@@TOOL:(.*?)@@\n/)
            if (toolMatch) {
              // Text before this marker
              const before = buffer.slice(0, buffer.indexOf(toolMatch[0]))
              if (before) textContent += before
              buffer = buffer.slice(buffer.indexOf(toolMatch[0]) + toolMatch[0].length)

              const data = JSON.parse(toolMatch[1])
              const id = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              const msg: AiMsg = { id, role: 'tool', content: '', toolCall: { name: data.name, args: data.args } }
              newMsgs.push(msg)
              toolMap.set(data.name, msg)
              changed = true
              flush()
              continue
            }

            const resultMatch = buffer.match(/\n@@RESULT:(.*?)@@\n/)
            if (resultMatch) {
              const before = buffer.slice(0, buffer.indexOf(resultMatch[0]))
              if (before) textContent += before
              buffer = buffer.slice(buffer.indexOf(resultMatch[0]) + resultMatch[0].length)

              const data = JSON.parse(resultMatch[1])
              const toolMsg = toolMap.get(data.name)
              if (toolMsg?.toolCall) toolMsg.toolCall.result = data.result

              changed = true
              flush()
              continue
            }
          }

          // No more markers — remaining buffer could be partial marker or text
          // Only flush text up to last \n to avoid cutting a partial @@TOOL:...@@
          const lastNewline = buffer.lastIndexOf('\n')
          if (lastNewline > 0 && !buffer.includes('@@')) {
            textContent += buffer.slice(0, lastNewline + 1)
            buffer = buffer.slice(lastNewline + 1)
            flush()
          } else if (!buffer.includes('@@')) {
            textContent += buffer
            buffer = ''
            flush()
          }
        }

        // Flush remaining buffer
        if (buffer) textContent += buffer
        flush()
      }
    } catch (err) {
      setAiError(err instanceof Error ? err.message : '请求失败')
    } finally {
      setAiLoading(false)
    }
  }, [aiMessages, aiLoading])

  const [privacyToggles, setPrivacyToggles] = useState({ showName: true, autoIntent: false, emotionSync: false })

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const aiEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const isAiChat = selectedName === AI_ASSISTANT
  const selectedContact = contacts.find((c) => c.name === selectedName) || null

  // ---------- Load contacts ----------
  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/contacts?limit=100').then(r => r.json()).then(data => setContacts(data.contacts || [])).catch(console.error)
  }, [status])

  // ---------- Load new messages ----------
  useEffect(() => {
    if (status !== 'authenticated') return
    const load = () => fetch('/api/messages/new?minutes=1440&limit=50').then(r => r.json()).then(data => setNewMessages(data.messages || [])).catch(console.error)
    load()
    const iv = setInterval(load, 30000)
    return () => clearInterval(iv)
  }, [status])

  // ---------- Load stats ----------
  useEffect(() => {
    if (status !== 'authenticated') return
    fetch('/api/stats').then(r => r.json()).then(setStats).catch(console.error)
  }, [status])

  // ---------- Poll sync status ----------
  useEffect(() => {
    if (status !== 'authenticated') return
    const load = () => fetch('/api/sync-status').then(r => r.json()).then(setSyncStatus).catch(() => {})
    load()
    const iv = setInterval(load, 5000)
    return () => clearInterval(iv)
  }, [status])

  // ---------- Load real contact history ----------
  useEffect(() => {
    if (!selectedName || isAiChat) return
    setHistoryLoading(true)
    setSummary(null)
    setRealMessages([])

    fetch(`/api/contacts/${encodeURIComponent(selectedName)}`).then(r => r.json()).then(data => {
      setRealMessages(data.messages || [])
      setTotalMsgCount(data.total || 0)
      setSummary(data.summary || null)
      setSummaryRange(data.summaryRange || null)
    }).catch(console.error).finally(() => setHistoryLoading(false))

    // Load summary
    fetch(`/api/summaries?search=${encodeURIComponent(selectedName)}`).then(r => r.json()).then(data => {
      const match = (data.summaries || []).find((s: any) => s.chat_name === selectedName)
      if (match) {
        setSummary(match.summary)
        setSummaryRange(`${match.start_time?.slice(0, 10)} ~ ${match.end_time?.slice(0, 10)}`)
      }
    }).catch(console.error)

    // Mark as read
    const unreadIds = newMessages.filter(m => m.thread_name === selectedName && !m.is_read).map(m => m.id)
    if (unreadIds.length > 0) {
      fetch('/api/messages/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: unreadIds }) })
        .then(() => setNewMessages(prev => prev.map(m => unreadIds.includes(m.id) ? { ...m, is_read: true } : m)))
        .catch(console.error)
    }
  }, [selectedName])

  // Scroll
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [realMessages])
  useEffect(() => { aiEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [aiMessages])

  // ---------- Direct send (real contact chat) ----------
  const handleDirectSend = useCallback(async () => {
    if (!directInput.trim() || !selectedName || isAiChat || !selectedContact) return
    const text = directInput.trim()
    setDirectInput('')

    // 根据 platform 选择发送方式
    let endpoint: string
    let payload: any

    if (selectedContact.platform === 'terminal') {
      endpoint = '/api/terminal/send'
      payload = { thread_id: selectedContact.thread_id, content: text }
    } else if (selectedContact.platform === 'gmail') {
      endpoint = '/api/send/email'
      payload = { contact_name: selectedName, body: text }
    } else {
      endpoint = '/api/send/feishu'
      payload = { contact_name: selectedName, content: text }
    }

    // Optimistic: add to messages immediately
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    setRealMessages(prev => [...prev, { direction: 'sent', content: text, timestamp: now }])

    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json()
      if (!data.success) {
        setRealMessages(prev => [...prev, { direction: 'received', content: `[发送失败: ${data.message}]`, timestamp: now }])
      }
    } catch {
      setRealMessages(prev => [...prev, { direction: 'received', content: '[发送失败，请检查网络]', timestamp: now }])
    }
  }, [directInput, selectedName, selectedContact, isAiChat])

  // ---------- Contact filtering ----------
  const filteredContacts = search ? contacts.filter(c => c.name.includes(search)) : contacts
  const pendingNames = new Set(newMessages.filter(m => !m.is_read).map(m => m.thread_name))
  const pendingContacts = filteredContacts.filter(c => pendingNames.has(c.name))
  const recentContacts = filteredContacts.filter(c => !pendingNames.has(c.name))

  // Health
  const healthPct = selectedContact ? Math.max(0, Math.min(100, 100 - selectedContact.days_since_last_contact)) : 0
  const healthColor = healthPct >= 70 ? 'text-primary' : healthPct >= 40 ? 'text-accent-orange' : 'text-error'
  const healthBarColor = healthPct >= 70 ? 'bg-primary' : healthPct >= 40 ? 'bg-accent-orange' : 'bg-error'

  if (status === 'loading') {
    return <div className="flex h-screen items-center justify-center bg-surface"><span className="text-outline">加载中...</span></div>
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-surface">
      {/* ===== Column 1: Sidebar ===== */}
      <aside className="w-[260px] flex-shrink-0 bg-surface-container-low flex flex-col h-full">
        <div className="p-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary-container rounded-lg flex items-center justify-center text-white font-black text-xl font-[Manrope]">S</div>
            <span className="font-[Manrope] font-extrabold text-primary tracking-tight">Social Proxy</span>
          </div>
          <span className="text-outline text-xs">{stats?.total || 0} 人</span>
        </div>

        {/* AI Assistant - pinned at top */}
        <div className="px-2 mb-2">
          <div
            onClick={() => setSelectedName(AI_ASSISTANT)}
            className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors ${
              isAiChat ? 'bg-primary-container/10 border border-primary-container/20' : 'hover:bg-surface-container'
            }`}
          >
            <div className="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
              林
            </div>
            <div className="flex-grow">
              <div className="flex items-center gap-2">
                <span className={`font-bold text-sm ${isAiChat ? 'text-primary' : ''}`}>小林</span>
                <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-bold">AI</span>
              </div>
              <p className="text-xs text-outline truncate">你的社交助理</p>
            </div>
            <div className="w-2 h-2 rounded-full bg-green-500" />
          </div>
        </div>

        {/* Search */}
        <div className="px-4 mb-4">
          <div className="relative group">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-lg group-focus-within:text-primary transition-colors">search</span>
            <input value={search} onChange={e => setSearch(e.target.value)} className="w-full bg-surface-container border-none rounded-full pl-10 pr-4 py-2 text-sm focus:ring-2 focus:ring-primary-container/20 placeholder:text-outline/60 outline-none" placeholder="搜索联系人..." />
          </div>
        </div>

        {/* Contact List */}
        <div className="flex-grow overflow-y-auto no-scrollbar px-2 space-y-4">
          {pendingContacts.length > 0 && (
            <div>
              <h3 className="px-4 mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-outline">待处理 ({pendingContacts.length})</h3>
              <div className="space-y-0.5">
                {pendingContacts.map(c => (
                  <ContactRow key={c.name} contact={c} selected={c.name === selectedName} preview={newMessages.find(m => m.thread_name === c.name)?.incoming_content} hasPending onClick={() => setSelectedName(c.name)} />
                ))}
              </div>
            </div>
          )}
          <div>
            <h3 className="px-4 mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-outline">最近对话 ({recentContacts.length})</h3>
            <div className="space-y-0.5">
              {recentContacts.slice(0, 50).map(c => (
                <ContactRow key={c.name} contact={c} selected={c.name === selectedName} onClick={() => setSelectedName(c.name)} />
              ))}
            </div>
          </div>
        </div>

        <nav className="p-4 space-y-1 border-t border-outline-variant/10">
          <a className="flex items-center gap-3 px-3 py-2 text-sm text-outline hover:text-primary transition-colors" href="#"><span className="material-symbols-outlined text-xl">hub</span>关系图谱</a>
          <a className="flex items-center gap-3 px-3 py-2 text-sm text-outline hover:text-primary transition-colors" href="#"><span className="material-symbols-outlined text-xl">task_alt</span>任务看板</a>
          <a className="flex items-center gap-3 px-3 py-2 text-sm text-outline hover:text-primary transition-colors" href="/settings"><span className="material-symbols-outlined text-xl">settings</span>设置</a>
        </nav>
      </aside>

      {/* ===== Column 2: Chat Area ===== */}
      <main className="flex-grow flex flex-col h-full bg-surface-container">
        {syncStatus && (syncStatus.feishu.status !== 'not_connected' || syncStatus.totals.messages > 0) && (
          <div className="px-6 py-2 bg-surface-container-low/50 flex items-center gap-3 text-xs">
            {/* Syncing */}
            {syncStatus.feishu.status === 'syncing' && (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-teal-500 animate-pulse" />
                <span className="text-on-surface-variant font-medium">
                  飞书同步中 {syncStatus.feishu.totalChats > 0 ? `${Math.round((syncStatus.feishu.syncedChats / syncStatus.feishu.totalChats) * 100)}%` : ''}
                </span>
                <span className="text-outline">
                  {syncStatus.feishu.syncedChats}/{syncStatus.feishu.totalChats} 个会话
                  {syncStatus.feishu.lastResult?.imported ? ` · ${syncStatus.feishu.lastResult.imported} 条消息` : ''}
                </span>
              </>
            )}
            {/* Paused */}
            {syncStatus.feishu.status === 'paused' && (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                <span className="text-amber-700 font-medium">飞书同步暂停</span>
                <span className="text-outline">{syncStatus.feishu.syncedChats}/{syncStatus.feishu.totalChats} 个会话 · 等待继续...</span>
              </>
            )}
            {/* Error */}
            {syncStatus.feishu.status === 'error' && (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                <span className="text-red-700 font-medium">飞书同步失败</span>
                <span className="text-outline">请前往设置页重试</span>
              </>
            )}
            {/* Completed */}
            {(syncStatus.feishu.status === 'completed' || syncStatus.feishu.status === 'completed_with_errors') && syncStatus.totals.messages > 0 && (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-teal-500" />
                <span className="text-outline">{syncStatus.totals.messages} 条消息 · {syncStatus.totals.contacts} 个联系人</span>
                {syncStatus.feishu.syncedChats > 0 && <span className="text-outline">· 飞书 {syncStatus.feishu.syncedChats}/{syncStatus.feishu.totalChats}</span>}
                {syncStatus.feishu.status === 'completed_with_errors' && <span className="text-amber-600">· 部分错误</span>}
              </>
            )}
            {/* Idle with data */}
            {syncStatus.feishu.status === 'idle' && syncStatus.totals.messages > 0 && (
              <>
                <span className="text-outline">{syncStatus.totals.messages} 条消息 · {syncStatus.totals.contacts} 个联系人</span>
              </>
            )}
          </div>
        )}
        {isAiChat ? (
          /* --- AI Assistant Chat --- */
          <>
            <header className="h-14 flex-shrink-0 flex items-center px-6 bg-surface/80 backdrop-blur-md ghost-border">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="w-9 h-9 rounded-full bg-primary-container flex items-center justify-center text-white font-bold text-sm">林</div>
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-green-500 border-2 border-white rounded-full" />
                </div>
                <div>
                  <h1 className="font-[Manrope] font-bold text-sm text-primary">小林 <span className="text-xs font-normal text-outline/80">（AI 社交助理）</span></h1>
                  <span className="text-[10px] text-outline">帮你代写消息、分析社交关系</span>
                </div>
              </div>
            </header>

            <div className="flex-grow overflow-y-auto p-6 space-y-4 flex flex-col no-scrollbar">
              {aiMessages.map(msg => (
                <div key={msg.id}>
                  {msg.role === 'tool' && msg.toolCall ? (
                    <ToolCallBubble toolCall={msg.toolCall} />
                  ) : msg.role === 'draft' && msg.draft ? (
                    <AgentDraftCard draft={msg.draft} msgId={msg.id} onUpdate={(id, d) => setAiMessages(prev => prev.map(m => m.id === id ? { ...m, draft: d } : m))} />
                  ) : msg.role === 'assistant' && msg.content ? (
                    <AiMessage content={msg.content} time="" />
                  ) : msg.role === 'user' && msg.content ? (
                    <UserMessage content={msg.content} time="" />
                  ) : null}
                </div>
              ))}
              {aiLoading && (
                <div className="flex flex-col items-start max-w-[85%]">
                  <div className="bg-primary-container text-white px-4 py-3 rounded-[18px] rounded-bl-sm">
                    <div className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-white/60 animate-pulse" /><span className="text-sm opacity-80">小林正在思考...</span></div>
                  </div>
                </div>
              )}
              {aiError && (
                <div className="bg-error/10 text-error rounded-xl p-3 text-xs">
                  出错了：{aiError}
                </div>
              )}
              <div ref={aiEndRef} />
            </div>

            <div className="p-4 pt-0">
              <div className="bg-white rounded-[24px] ambient-shadow ghost-border p-2 flex items-center gap-2">
                <input
                  ref={inputRef}
                  value={aiInput}
                  onChange={e => setAiInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && aiInput.trim() && !aiLoading) {
                      e.preventDefault()
                      aiSendMessage(aiInput.trim())
                      setAiInput('')
                    }
                  }}
                  className="flex-grow bg-transparent border-none focus:ring-0 text-sm px-4 placeholder:text-outline/40 outline-none"
                  placeholder="告诉小林你想做什么...（如：帮我给张三发消息催一下项目进度）"
                />
                <button
                  onClick={() => { if (aiInput.trim() && !aiLoading) { aiSendMessage(aiInput.trim()); setAiInput('') } }}
                  disabled={!aiInput.trim() || aiLoading}
                  className="w-10 h-10 bg-primary-container text-white rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform disabled:opacity-40"
                >
                  <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>send</span>
                </button>
              </div>
            </div>
          </>
        ) : selectedContact ? (
          /* --- Real Contact Chat --- */
          <>
            <header className="h-14 flex-shrink-0 flex items-center justify-between px-6 bg-surface/80 backdrop-blur-md ghost-border">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${nameColor(selectedContact.name)}`}>{getInitial(selectedContact.name)}</div>
                <div>
                  <h1 className="font-[Manrope] font-bold text-sm text-on-surface">{selectedContact.name}</h1>
                  <span className="text-[10px] text-outline">{selectedContact.message_count} 条消息</span>
                </div>
              </div>
              {selectedContact.tags && selectedContact.tags.length > 0 && (
                <div className="flex gap-1">
                  {selectedContact.tags.slice(0, 3).map((tag, i) => (
                    <span key={i} className="text-[10px] text-outline bg-surface-container px-2 py-1 rounded">{tag}</span>
                  ))}
                </div>
              )}
            </header>

            <div className="flex-grow overflow-y-auto p-6 space-y-3 flex flex-col no-scrollbar">
              {summary && (
                <div className="bg-primary-fixed/20 rounded-xl p-4 text-xs text-on-surface-variant leading-relaxed ghost-border mb-2">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="material-symbols-outlined text-primary text-base">summarize</span>
                    <span className="font-bold text-primary text-[11px] uppercase tracking-wider">AI 摘要 {summaryRange && `(${summaryRange})`}</span>
                  </div>
                  <p className="line-clamp-4">{summary}</p>
                </div>
              )}

              {historyLoading ? (
                <div className="flex items-center justify-center py-12 text-outline text-sm">加载中...</div>
              ) : realMessages.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-outline text-sm">暂无聊天记录</div>
              ) : (
                realMessages.map((m, i) => (
                  <HistoryBubble key={i} content={m.content} time={timeStr(m.timestamp)} direction={m.direction} contactName={selectedName!} senderName={m.sender_name} />
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-4 pt-0">
              <div className="bg-white rounded-[24px] ambient-shadow ghost-border p-2 flex items-center gap-2">
                <input
                  value={directInput}
                  onChange={e => setDirectInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleDirectSend()}
                  className="flex-grow bg-transparent border-none focus:ring-0 text-sm px-4 placeholder:text-outline/40 outline-none"
                  placeholder={`给${selectedName}发消息...`}
                />
                <button onClick={handleDirectSend} disabled={!directInput.trim()} className="w-10 h-10 bg-primary-container text-white rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform disabled:opacity-40">
                  <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>send</span>
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-grow flex items-center justify-center text-outline">
            <div className="text-center space-y-3">
              <span className="material-symbols-outlined text-6xl block opacity-20">chat</span>
              <p className="text-sm">选择一个联系人查看聊天记录</p>
            </div>
          </div>
        )}
      </main>

      {/* ===== Column 3: Right Panel ===== */}
      {isAiChat ? (
        /* AI assistant right panel: quick actions */
        <aside className="w-[300px] flex-shrink-0 bg-white flex flex-col h-full ghost-border overflow-y-auto no-scrollbar">
          <div className="p-6 border-b border-outline-variant/10">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-primary-container flex items-center justify-center text-white font-bold text-lg">林</div>
              <div>
                <h2 className="font-[Manrope] font-bold text-lg text-on-surface">小林</h2>
                <p className="text-xs text-outline">AI 社交助理</p>
              </div>
            </div>
          </div>
          <section className="p-6 space-y-3">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-outline">快捷指令</h3>
            {[
              '帮我查看最近谁没联系了',
              '看看最近有什么新消息',
              '帮我看看社交关系统计',
              '搜索一下关于项目的聊天',
            ].map((cmd, i) => (
              <button key={i} onClick={() => { if (!aiLoading) { aiSendMessage(cmd) } }} className="w-full text-left px-3 py-2.5 text-xs text-on-surface-variant bg-surface-container hover:bg-surface-container-high rounded-lg transition-colors">
                {cmd}
              </button>
            ))}
          </section>
          {stats && (
            <section className="p-6 space-y-3 border-t border-outline-variant/10">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-outline">社交概览</h3>
              <div className="space-y-2">
                <InfoRow label="联系人" value={`${stats.total} 人`} />
                <InfoRow label="消息总量" value={`${stats.totalMsgs.toLocaleString()} 条`} />
                {stats.buckets.map((b, i) => <InfoRow key={i} label={b.bucket} value={`${b.count} 人`} />)}
              </div>
            </section>
          )}
        </aside>
      ) : selectedContact ? (
        /* Real contact right panel */
        <aside className="w-[300px] flex-shrink-0 bg-white flex flex-col h-full ghost-border overflow-y-auto no-scrollbar">
          <div className="p-6 border-b border-outline-variant/10">
            <div className="flex items-center gap-4 mb-4">
              <div className={`w-12 h-12 rounded-full ring-2 ring-surface-container flex items-center justify-center font-bold text-lg ${nameColor(selectedContact.name)}`}>{getInitial(selectedContact.name)}</div>
              <div>
                <h2 className="font-[Manrope] font-bold text-lg text-on-surface leading-none mb-1.5">{selectedContact.name}</h2>
                {selectedContact.tags && selectedContact.tags.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap">
                    {selectedContact.tags.map((tag, i) => (
                      <span key={i} className="px-2 py-0.5 bg-surface-container text-outline text-[10px] font-bold rounded">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between items-end">
                <span className="text-[10px] font-bold text-outline uppercase tracking-wider">联系频率</span>
                <span className={`text-xs font-bold ${healthColor}`}>{selectedContact.days_since_last_contact === 9999 ? '从未' : `${selectedContact.days_since_last_contact}天前`}</span>
              </div>
              <div className="w-full h-1.5 bg-surface-container rounded-full overflow-hidden">
                <div className={`h-full ${healthBarColor} rounded-full transition-all duration-500`} style={{ width: `${healthPct}%` }} />
              </div>
            </div>
          </div>

          {summary && (
            <section className="p-6 space-y-3 border-b border-outline-variant/10">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-outline">AI 摘要</h3>
              <p className="text-xs text-on-surface-variant leading-relaxed">{summary}</p>
            </section>
          )}

          <section className="p-6 space-y-4 border-b border-outline-variant/10">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-outline">详细信息</h3>
            <div className="space-y-3">
              <InfoRow label="消息数" value={`${selectedContact.message_count} 条（共 ${totalMsgCount}）`} />
              <InfoRow label="最后联系" value={selectedContact.last_contact_at?.slice(0, 10) || '从未'} />
            </div>
          </section>

          {newMessages.filter(m => m.thread_name === selectedName).length > 0 && (
            <section className="p-6 space-y-3 border-b border-outline-variant/10">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-outline">最近收到</h3>
              {newMessages.filter(m => m.thread_name === selectedName).slice(0, 5).map(m => (
                <div key={m.id} className="space-y-1">
                  <p className="text-xs text-on-surface">{m.incoming_content}</p>
                  <span className="text-[10px] text-outline">{timeStr(m.created_at)} {m.is_at_me && <span className="text-accent-orange font-bold">@我</span>}</span>
                  {m.suggestion && <div className="bg-primary-fixed/20 rounded-lg p-2"><p className="text-[10px] text-primary font-bold mb-0.5">建议回复</p><p className="text-xs text-on-surface-variant">{m.suggestion}</p></div>}
                </div>
              ))}
            </section>
          )}

          <section className="p-6 space-y-4">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-outline mb-1">隐私控制</h3>
            <ToggleRow label="显示真实姓名" on={privacyToggles.showName} onToggle={() => setPrivacyToggles(p => ({ ...p, showName: !p.showName }))} />
            <ToggleRow label="自动识别意图" on={privacyToggles.autoIntent} onToggle={() => setPrivacyToggles(p => ({ ...p, autoIntent: !p.autoIntent }))} />
          </section>
        </aside>
      ) : null}
    </div>
  )
}

// ---------- Components ----------

function ContactRow({ contact, selected, preview, hasPending, onClick }: { contact: Contact; selected: boolean; preview?: string | null; hasPending?: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} className={`flex items-center gap-3 p-3 rounded-r-xl cursor-pointer transition-colors duration-200 ${selected ? 'bg-primary-container/5 border-l-[3px] border-primary-container' : 'hover:bg-surface-container border-l-[3px] border-transparent'}`}>
      <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${nameColor(contact.name)}`}>{getInitial(contact.name)}</div>
      <div className="flex-grow overflow-hidden">
        <div className="flex justify-between items-center">
          <span className={`font-semibold text-sm ${selected ? 'text-primary' : ''}`}>{contact.name}</span>
          {hasPending ? <div className="w-2 h-2 rounded-full bg-accent-orange" /> : <span className="text-[10px] text-outline">{formatRelativeTime(contact.last_contact_at)}</span>}
        </div>
        <p className="text-xs text-outline truncate">{preview || `${contact.message_count} 条消息`}</p>
      </div>
    </div>
  )
}

function HistoryBubble({ content, time, direction, contactName, senderName }: { content: string; time: string; direction: 'sent' | 'received'; contactName: string; senderName?: string }) {
  const isSent = direction === 'sent'
  const displayName = isSent ? '我' : (senderName || contactName)
  return (
    <div className={`flex flex-col ${isSent ? 'items-end self-end' : 'items-start'} max-w-[85%]`}>
      <div className={`px-4 py-2.5 rounded-[16px] draft-shadow ${isSent ? 'bg-secondary text-white rounded-br-sm' : 'bg-surface-container-highest text-on-surface rounded-bl-sm'}`}>
        <p className="text-sm leading-relaxed">{content}</p>
      </div>
      <span className="text-[10px] text-outline mt-1 mx-2">{displayName} · {time}</span>
    </div>
  )
}

function AgentDraftCard({ draft, msgId, onUpdate }: {
  draft: { to: string; content: string; platform: 'feishu' | 'email'; status: 'pending' | 'sent' | 'cancelled' }
  msgId: string
  onUpdate: (id: string, draft: any) => void
}) {
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    setSending(true)
    try {
      const endpoint = draft.platform === 'feishu' ? '/api/send/feishu' : '/api/send/email'
      const payload = draft.platform === 'feishu'
        ? { contact_name: draft.to, content: draft.content }
        : { contact_name: draft.to, body: draft.content }
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json()
      onUpdate(msgId, { ...draft, status: data.success ? 'sent' : 'cancelled' })
    } catch {
      onUpdate(msgId, { ...draft, status: 'cancelled' })
    } finally {
      setSending(false)
    }
  }

  const isDone = draft.status !== 'pending'
  return (
    <div className="max-w-[90%] bg-white rounded-[10px] border-l-[3px] border-primary-container draft-shadow p-4 space-y-3">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-lg">edit_note</span>
          <span className="text-xs font-bold text-on-surface">
            准备发给{draft.to}
            <span className="text-outline font-normal ml-1">({draft.platform === 'feishu' ? '飞书' : '邮件'})</span>
          </span>
        </div>
        <span className={`text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-wider ${
          draft.status === 'sent' ? 'bg-primary/10 text-primary'
            : draft.status === 'cancelled' ? 'bg-outline/10 text-outline'
            : 'bg-accent-orange/10 text-accent-orange'
        }`}>
          {draft.status === 'sent' ? '已发送' : draft.status === 'cancelled' ? '已取消' : '待发送'}
        </span>
      </div>
      <div className="bg-surface p-3 rounded-lg ghost-border">
        <p className="text-sm italic text-on-surface-variant leading-relaxed">&ldquo;{draft.content}&rdquo;</p>
      </div>
      {!isDone && (
        <div className="flex gap-2">
          <button onClick={handleSend} disabled={sending} className="flex-grow py-2 bg-primary-container text-white rounded-lg text-xs font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5 disabled:opacity-50">
            <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>{sending ? 'hourglass_empty' : 'check_circle'}</span>
            {sending ? '发送中...' : '发出去'}
          </button>
          <button onClick={() => onUpdate(msgId, { ...draft, status: 'cancelled' })} className="flex-grow py-2 border border-outline-variant text-outline rounded-lg text-xs font-bold hover:bg-surface-container transition-colors">
            先不发
          </button>
        </div>
      )}
    </div>
  )
}

function ToolCallBubble({ toolCall }: { toolCall: { name: string; args: any; result?: any } }) {
  const [open, setOpen] = useState(false)
  const hasResult = toolCall.result !== undefined

  const TOOL_LABELS: Record<string, string> = {
    get_contacts: '查询联系人',
    get_history: '查看聊天记录',
    get_summaries: '查看 AI 摘要',
    search_messages: '搜索消息',
    get_stats: '统计分析',
    get_new_messages: '获取新消息',
    get_approvals: '查询审批',
  }

  const label = TOOL_LABELS[toolCall.name] || toolCall.name
  const argsStr = Object.entries(toolCall.args || {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')

  // Summarize result
  let resultSummary = ''
  if (hasResult) {
    const r = toolCall.result
    if (r?.count !== undefined) resultSummary = `${r.count} 条结果`
    else if (r?.total !== undefined) resultSummary = `共 ${r.total} 条`
    else if (r?.contacts) resultSummary = `${r.contacts.length} 个联系人`
    else if (r?.messages) resultSummary = `${Array.isArray(r.messages) ? r.messages.length : 0} 条消息`
    else if (r?.summaries) resultSummary = `${r.summaries.length} 个摘要`
    else if (r?.tasks) resultSummary = `${r.tasks.length} 个任务`
    else if (r?.success !== undefined) resultSummary = r.success ? '成功' : `失败: ${r.message}`
    else resultSummary = '完成'
  }

  return (
    <div className="mx-2 my-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-container-high/50 hover:bg-surface-container-high transition-colors text-xs w-auto"
      >
        <span className="material-symbols-outlined text-sm text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>
          {hasResult ? 'check_circle' : 'pending'}
        </span>
        <span className="font-mono text-on-surface-variant font-medium">{label}</span>
        {argsStr && <span className="text-outline truncate max-w-[200px]">({argsStr})</span>}
        {hasResult && <span className="text-primary font-medium">→ {resultSummary}</span>}
        <span className="material-symbols-outlined text-sm text-outline ml-auto">{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && (
        <div className="mt-1 ml-6 p-3 bg-surface-container rounded-lg text-[11px] font-mono text-on-surface-variant overflow-x-auto max-h-[300px] overflow-y-auto">
          {toolCall.args && Object.keys(toolCall.args).length > 0 && (
            <div className="mb-2">
              <span className="text-outline font-bold">参数：</span>
              <pre className="whitespace-pre-wrap mt-1">{JSON.stringify(toolCall.args, null, 2)}</pre>
            </div>
          )}
          {hasResult && (
            <div>
              <span className="text-outline font-bold">返回：</span>
              <pre className="whitespace-pre-wrap mt-1">{JSON.stringify(toolCall.result, null, 2).slice(0, 3000)}{JSON.stringify(toolCall.result).length > 3000 ? '\n...(已截断)' : ''}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AiMessage({ content, time }: { content: string; time: string }) {
  return (
    <div className="flex flex-col items-start max-w-[85%]">
      <div className="bg-primary-container text-white px-4 py-3 rounded-[18px] rounded-bl-sm draft-shadow">
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
      </div>
      <span className="text-[10px] text-outline mt-1.5 ml-2">小林 · {time}</span>
    </div>
  )
}

function UserMessage({ content, time }: { content: string; time: string }) {
  return (
    <div className="flex flex-col items-end max-w-[85%] self-end">
      <div className="bg-secondary text-white px-4 py-3 rounded-[18px] rounded-br-sm draft-shadow">
        <p className="text-sm leading-relaxed">{content}</p>
      </div>
      <span className="text-[10px] text-outline mt-1.5 mr-2">{time}</span>
    </div>
  )
}

function DraftCard({ msgId, draft, onAction }: { msgId: string; draft: DraftData; onAction: (id: string, action: 'send' | 'edit' | 'cancel') => void }) {
  const isDone = draft.status !== 'pending'
  return (
    <div className="max-w-[90%] bg-white rounded-[10px] border-l-[3px] border-primary-container draft-shadow p-4 space-y-3">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary text-lg">edit_note</span>
          <span className="text-xs font-bold text-on-surface">准备发给{draft.targetName} <span className="text-outline font-normal">({draft.platform === 'feishu' ? '飞书' : '邮件'})</span></span>
        </div>
        <span className={`text-[10px] font-black px-2 py-0.5 rounded uppercase tracking-wider ${draft.status === 'sent' ? 'bg-primary/10 text-primary' : draft.status === 'cancelled' ? 'bg-outline/10 text-outline' : 'bg-accent-orange/10 text-accent-orange'}`}>
          {draft.status === 'sent' ? '已发送' : draft.status === 'cancelled' ? '已取消' : '待发送'}
        </span>
      </div>
      <div className="bg-surface p-3 rounded-lg ghost-border">
        <p className="text-sm italic text-on-surface-variant leading-relaxed">&ldquo;{draft.content}&rdquo;</p>
      </div>
      {!isDone && (
        <div className="flex gap-2">
          <button onClick={() => onAction(msgId, 'send')} className="flex-grow py-2 bg-primary-container text-white rounded-lg text-xs font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5">
            <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>发出去
          </button>
          <button onClick={() => onAction(msgId, 'edit')} className="flex-grow py-2 border border-primary-container/20 text-primary-container rounded-lg text-xs font-bold hover:bg-primary-container/5 transition-colors">改一改</button>
          <button onClick={() => onAction(msgId, 'cancel')} className="flex-grow py-2 border border-outline-variant text-outline rounded-lg text-xs font-bold hover:bg-surface-container transition-colors">先不发</button>
        </div>
      )}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (<div className="flex justify-between text-xs"><span className="text-outline">{label}</span><span className="font-semibold text-on-surface text-right max-w-[60%] truncate">{value}</span></div>)
}

function ToggleRow({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-on-surface-variant">{label}</span>
      <div onClick={onToggle} className={`w-8 h-4 rounded-full relative cursor-pointer transition-colors ${on ? 'bg-primary-container' : 'bg-outline-variant'}`}>
        <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${on ? 'right-0.5' : 'left-0.5'}`} />
      </div>
    </div>
  )
}
