'use client'

// Social Proxy 配置页面
// 区块：微信导入 / 飞书同步 / 联系人邮箱 / 权限+SMTP / 安装命令

import { useEffect, useState, useRef, useCallback } from 'react'

interface Contact {
  id: number
  name: string
  email: string | null
  last_contact_at: string | null
  message_count: number
}

interface Settings {
  smtp_host: string
  smtp_port: string
  smtp_user: string
  smtp_pass: string
  smtp_from_name: string
  permission_mode: string
  feishu_app_id: string
  feishu_app_secret: string
}

const defaultSettings: Settings = {
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  smtp_from_name: '',
  permission_mode: 'suggest',
  feishu_app_id: '',
  feishu_app_secret: '',
}

function DocSyncSection() {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [result, setResult] = useState<any>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const handleSync = async () => {
    setRunning(true); setLog([]); setResult(null)
    await fetch('/api/feishu-docs', { method: 'POST' })
    const poll = setInterval(async () => {
      const s = await fetch('/api/feishu-docs').then(r => r.json())
      setLog(s.log || [])
      if (!s.running) { clearInterval(poll); setRunning(false); setResult(s.lastResult) }
    }, 1500)
  }

  return (
    <Section title="05 飞书文档同步">
      <p className="text-gray-500 text-sm mb-4">
        同步飞书云文档内容到本地，需开通 <code className="text-purple-400">drive:drive:readonly</code> 和 <code className="text-purple-400">docx:document:readonly</code> 用户身份权限。
      </p>
      <div className="flex items-center gap-3 mb-4">
        <button onClick={handleSync} disabled={running}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm transition-colors disabled:opacity-50">
          {running ? '同步中...' : '同步文档'}
        </button>
        {result && !result.error && (
          <span className="text-sm text-gray-400">共 <span className="text-green-400 font-mono">{result.synced}</span> 个文档</span>
        )}
      </div>
      {log.length > 0 && (
        <div ref={logRef} className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 h-36 overflow-y-auto font-mono text-xs text-gray-400 space-y-0.5">
          {log.map((l, i) => <div key={i}>{l}</div>)}
          {running && <div className="text-blue-400 animate-pulse">同步中...</div>}
        </div>
      )}
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#111111] border border-[#1f1f1f] rounded-xl p-6">
      <h2 className="text-white font-semibold text-base mb-5 font-mono">{title}</h2>
      {children}
    </div>
  )
}

function Input({
  label, value, onChange, type = 'text', placeholder = '',
}: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string
}) {
  return (
    <div>
      <label className="block text-gray-400 text-xs mb-1">{label}</label>
      <input
        type={type} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-purple-600/60"
      />
    </div>
  )
}

export default function ConfigPage() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [editingEmail, setEditingEmail] = useState<Record<number, string>>({})
  const [settings, setSettings] = useState<Settings>(defaultSettings)

  // ── 聊天记录 ──────────────────────────────────────
  const [msgContact, setMsgContact] = useState('')
  const [msgQuery, setMsgQuery] = useState('')
  const [msgPage, setMsgPage] = useState(1)
  const [messages, setMessages] = useState<any[]>([])
  const [msgTotal, setMsgTotal] = useState(0)
  const [msgLoading, setMsgLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // ── 实时消息 ──────────────────────────────────────
  const [realtimeSuggestions, setRealtimeSuggestions] = useState<any[]>([])
  const [realtimeUnread, setRealtimeUnread] = useState(0)
  const [realtimePolling, setRealtimePolling] = useState(false)

  // ── 飞书状态 ──────────────────────────────────────
  const [feishuAuthed, setFeishuAuthed] = useState(false)
  const [feishuUserName, setFeishuUserName] = useState('')
  const [feishuAuthing, setFeishuAuthing] = useState(false)
  const [feishuAuthUrl, setFeishuAuthUrl] = useState('')
  const [feishuSyncing, setFeishuSyncing] = useState(false)
  const [feishuLog, setFeishuLog] = useState<string[]>([])
  const [feishuResult, setFeishuResult] = useState<any>(null)
  const [autoSync, setAutoSync] = useState(true)
  const [autoSyncSeconds, setAutoSyncSeconds] = useState(15)
  const logRef = useRef<HTMLDivElement>(null)

  const fetchContacts = useCallback(async () => {
    const res = await fetch('/api/contacts')
    const data = await res.json()
    setContacts(data.contacts || [])
  }, [])

  const fetchSettings = useCallback(async () => {
    const res = await fetch('/api/settings')
    const data = await res.json()
    setSettings({ ...defaultSettings, ...data.settings })
  }, [])

  const checkFeishuAuth = useCallback(async () => {
    const res = await fetch('/api/feishu-auth')
    const data = await res.json()
    setFeishuAuthed(data.done)
    if (data.name) setFeishuUserName(data.name)
  }, [])

  const fetchRealtimeSuggestions = useCallback(async () => {
    const data = await fetch('/api/feishu-realtime').then(r => r.json())
    setRealtimeSuggestions(data.suggestions || [])
    setRealtimeUnread(data.unread || 0)
  }, [])

  const triggerRealtimePoll = async () => {
    setRealtimePolling(true)
    await fetch('/api/feishu-realtime', { method: 'POST' })
    await fetchRealtimeSuggestions()
    setRealtimePolling(false)
  }

  const markAllRead = async () => {
    await fetch('/api/feishu-realtime', { method: 'PATCH' })
    await fetchRealtimeSuggestions()
  }

  useEffect(() => {
    fetchContacts()
    fetchSettings()
    checkFeishuAuth()
    fetchRealtimeSuggestions()
    // 页面加载时自动开启 15 秒同步
    fetch('/api/feishu-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoSyncSeconds: 15 }),
    })
    // Auto-refresh realtime suggestions every 30s
    const timer = setInterval(fetchRealtimeSuggestions, 30000)
    return () => clearInterval(timer)
  }, [fetchContacts, fetchSettings, checkFeishuAuth, fetchRealtimeSuggestions])

  // 自动滚动 log 到底部
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [feishuLog])

  // ── 微信导入 ──────────────────────────────────────
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setImportResult(null)
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/import', { method: 'POST', body: form })
    const data = await res.json()
    setImporting(false)
    setImportResult(data)
    await fetchContacts()
    if (fileRef.current) fileRef.current.value = ''
  }

  // ── 飞书 OAuth ────────────────────────────────────
  const handleFeishuAuth = async () => {
    if (!settings.feishu_app_id || !settings.feishu_app_secret) {
      alert('请先填写飞书 App ID 和 App Secret 并保存')
      return
    }
    setFeishuAuthing(true)
    setFeishuAuthUrl('')

    // 先保存 app_id / app_secret
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feishu_app_id: settings.feishu_app_id,
        feishu_app_secret: settings.feishu_app_secret,
      }),
    })

    const res = await fetch('/api/feishu-auth', { method: 'POST' })
    const data = await res.json()
    if (data.error) { alert(data.error); setFeishuAuthing(false); return }

    // 显示授权链接
    setFeishuAuthed(false)
    setFeishuAuthUrl(data.authUrl)
    const state = data.state

    // 前端直接轮询 relay，拿到 code 后换 token
    let tries = 0
    const poll = setInterval(async () => {
      tries++
      try {
        const codeRes = await fetch(`https://relay.botook.ai/feishu/code?state=${state}`).then(r => r.json())
        if (codeRes.code) {
          clearInterval(poll)
          setFeishuAuthUrl('')
          // 换 token
          const completeRes = await fetch('/api/feishu-complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: codeRes.code }),
          }).then(r => r.json())

          if (completeRes.error) {
            alert(`授权失败: ${completeRes.error}`)
          } else {
            setFeishuAuthed(true)
            setFeishuUserName(completeRes.name)
          }
          setFeishuAuthing(false)
        } else if (codeRes.error === 'Code expired' || tries > 36) {
          clearInterval(poll)
          setFeishuAuthing(false)
          alert('授权超时，请重试')
        }
      } catch {}
    }, 5000)
  }

  // ── 飞书同步 ──────────────────────────────────────
  const handleFeishuSync = async () => {
    setFeishuSyncing(true)
    setFeishuLog([])
    setFeishuResult(null)
    await fetch('/api/feishu-sync', { method: 'POST' })

    // 轮询进度
    const poll = setInterval(async () => {
      const status = await fetch('/api/feishu-sync').then(r => r.json())
      setFeishuLog(status.log || [])
      if (!status.running) {
        clearInterval(poll)
        setFeishuSyncing(false)
        setFeishuResult(status.lastResult)
        await fetchContacts()
      }
    }, 1500)
  }

  const fetchMessages = useCallback(async (contact: string, q: string, page: number) => {
    setMsgLoading(true)
    const params = new URLSearchParams({ page: String(page) })
    if (contact) params.set('contact', contact)
    if (q) params.set('q', q)
    const data = await fetch(`/api/messages?${params}`).then(r => r.json())
    setMessages(data.messages || [])
    setMsgTotal(data.total || 0)
    setMsgLoading(false)
  }, [])

  useEffect(() => {
    fetchMessages(msgContact, msgQuery, msgPage)
  }, [msgContact, msgQuery, msgPage, fetchMessages])

  // ── 联系人邮箱 ────────────────────────────────────
  const saveEmail = async (id: number) => {
    await fetch('/api/contacts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, email: editingEmail[id] ?? '' }),
    })
    await fetchContacts()
    const next = { ...editingEmail }
    delete next[id]
    setEditingEmail(next)
  }

  // ── 配置保存 ──────────────────────────────────────
  const saveSettings = async () => {
    setSettingsSaving(true)
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
    setSettingsSaving(false)
    setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 2000)
  }

  const installCmd = `claude mcp add social-proxy node /Users/yaoyao/Project/social-proxy/mcp-server/dist/index.js`
  const [copied, setCopied] = useState(false)
  const copyCmd = () => {
    navigator.clipboard.writeText(installCmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-white">
      <header className="border-b border-[#1f1f1f] px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-white font-bold text-lg font-mono">Social Proxy</h1>
            <p className="text-gray-600 text-xs mt-0.5">MCP Server 配置中心</p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold font-mono">{contacts.length}</div>
            <div className="text-gray-600 text-xs">联系人</div>
          </div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">

        {/* ── 01 微信导入 ── */}
        <Section title="01 导入微信记录">
          {/* 导出教程 */}
          <div className="mb-5 space-y-3">
            <p className="text-gray-400 text-sm font-medium">如何导出微信聊天记录？</p>

            {/* 方法一：转发到文件传输助手 */}
            <details className="group" open>
              <summary className="cursor-pointer text-sm text-blue-400 hover:text-blue-300 transition-colors">
                方法一：多选转发（推荐，最简单）
              </summary>
              <ol className="mt-2 ml-4 text-xs text-gray-500 space-y-1.5 list-decimal list-outside">
                <li>打开微信聊天窗口，<strong className="text-gray-400">长按</strong>一条消息 → 点击「多选」</li>
                <li>勾选要导出的消息（可一次选多条）</li>
                <li>点击左下角「转发」→ 选择「<strong className="text-gray-400">文件传输助手</strong>」→ 选择「<strong className="text-gray-400">逐条转发</strong>」</li>
                <li>电脑端微信打开「文件传输助手」，全选消息 → <strong className="text-gray-400">复制</strong></li>
                <li>粘贴到文本编辑器，保存为 <code className="text-purple-400">.txt</code> 文件</li>
                <li>在下方上传该文件</li>
              </ol>
              <div className="mt-2 ml-4 p-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded text-xs text-gray-600">
                格式为每行 <code className="text-purple-400 mx-1">2024-01-01 12:00 张三: 消息内容</code>，
                「逐条转发」会保留每条消息的发送者和时间
              </div>
            </details>

            {/* 方法二：邮件发送 */}
            <details className="group">
              <summary className="cursor-pointer text-sm text-blue-400 hover:text-blue-300 transition-colors">
                方法二：邮件发送聊天记录
              </summary>
              <ol className="mt-2 ml-4 text-xs text-gray-500 space-y-1.5 list-decimal list-outside">
                <li>打开微信聊天窗口 → 点击右上角「...」→ 「查找聊天记录」</li>
                <li>选择「日期」筛选需要的时间范围</li>
                <li>长按消息 → 「多选」→ 全选该范围内的消息</li>
                <li>点击左下角「转发」→ 选择发送到自己的<strong className="text-gray-400">邮箱</strong></li>
                <li>在邮箱中收到聊天记录，复制正文保存为 <code className="text-purple-400">.txt</code> 文件</li>
              </ol>
            </details>

            {/* 方法三：电脑端直接复制 */}
            <details className="group">
              <summary className="cursor-pointer text-sm text-blue-400 hover:text-blue-300 transition-colors">
                方法三：电脑端直接复制（少量消息）
              </summary>
              <ol className="mt-2 ml-4 text-xs text-gray-500 space-y-1.5 list-decimal list-outside">
                <li>在电脑端微信打开聊天窗口</li>
                <li>向上滚动到需要的位置，按住 <kbd className="text-gray-400 bg-[#1f1f1f] px-1 rounded">Shift</kbd> 点击第一条和最后一条消息进行多选</li>
                <li>右键 →「复制」，粘贴到文本编辑器保存为 <code className="text-purple-400">.txt</code></li>
              </ol>
              <div className="mt-2 ml-4 p-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded text-xs text-gray-600">
                适合少量消息。电脑端复制的格式通常已经包含时间和发送者信息
              </div>
            </details>
          </div>

          {/* 支持的格式说明 */}
          <div className="mb-4 p-3 bg-[#0a0a0a] border border-[#1f1f1f] rounded-lg">
            <p className="text-xs text-gray-500 mb-1">支持的文件格式：</p>
            <div className="flex gap-4 text-xs">
              <span className="text-purple-400">.txt</span>
              <span className="text-gray-600">每行 <code>时间 发送者: 消息内容</code></span>
            </div>
            <div className="flex gap-4 text-xs">
              <span className="text-purple-400">.csv</span>
              <span className="text-gray-600">包含时间、发送者、内容的 CSV</span>
            </div>
          </div>

          {/* 上传按钮 */}
          <div className="flex items-center gap-4">
            <label className="cursor-pointer">
              <span className="inline-block px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm transition-colors">
                {importing ? '导入中...' : '选择文件上传'}
              </span>
              <input ref={fileRef} type="file" accept=".txt,.csv" className="hidden" onChange={handleImport} disabled={importing} />
            </label>
            {importResult && (
              <span className="text-sm text-gray-400">
                成功 <span className="text-green-400 font-mono">{importResult.imported}</span> 条，
                跳过 <span className="text-gray-500 font-mono">{importResult.skipped}</span> 条
              </span>
            )}
          </div>
        </Section>

        {/* ── 02 飞书同步 ── */}
        <Section title="02 飞书聊天同步">
          <p className="text-gray-500 text-sm mb-4">
            通过飞书 OAuth 授权，自动拉取私聊历史并写入本地数据库。
            需要先在 <a href="https://open.feishu.cn" target="_blank" className="text-blue-400 underline">open.feishu.cn</a> 创建自建应用，
            开启 <code className="text-purple-400">im:message:readonly</code> 权限，回调地址填 <code className="text-purple-400">http://localhost:19721/callback</code>。
          </p>

          {/* App ID / Secret */}
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Input
              label="App ID"
              value={settings.feishu_app_id}
              onChange={(v) => setSettings({ ...settings, feishu_app_id: v })}
              placeholder="cli_xxxxxxxxx"
            />
            <Input
              label="App Secret"
              type="password"
              value={settings.feishu_app_secret}
              onChange={(v) => setSettings({ ...settings, feishu_app_secret: v })}
              placeholder="••••••••"
            />
          </div>

          {/* 授权状态 + 按钮 */}
          <div className="flex items-center gap-3 mb-4">
            {feishuAuthed ? (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
                <span className="text-sm text-green-400">已授权：{feishuUserName}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-gray-600 inline-block" />
                <span className="text-sm text-gray-500">未授权</span>
              </div>
            )}
            <button
              onClick={handleFeishuAuth}
              disabled={feishuAuthing}
              className="px-4 py-2 rounded-lg bg-[#1f1f1f] hover:bg-[#2a2a2a] text-white text-sm border border-[#2a2a2a] transition-colors disabled:opacity-50"
            >
              {feishuAuthing ? '等待授权...' : feishuAuthed ? '重新授权' : '授权飞书账号'}
            </button>
            {feishuAuthed && (
              <button
                onClick={handleFeishuSync}
                disabled={feishuSyncing}
                className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm transition-colors disabled:opacity-50"
              >
                {feishuSyncing ? '同步中...' : '立即同步'}
              </button>
            )}
          </div>

          {/* 自动同步 */}
          {feishuAuthed && (
            <div className="flex items-center gap-3 mb-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={async (e) => {
                    const enabled = e.target.checked
                    setAutoSync(enabled)
                    await fetch('/api/feishu-sync', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ autoSyncSeconds: enabled ? autoSyncSeconds : 0 }),
                    })
                  }}
                  className="accent-purple-600 w-4 h-4"
                />
                <span className="text-sm text-white">自动同步</span>
              </label>
              <select
                value={autoSyncSeconds}
                onChange={async (e) => {
                  const secs = Number(e.target.value)
                  setAutoSyncSeconds(secs)
                  if (autoSync) {
                    await fetch('/api/feishu-sync', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ autoSyncSeconds: secs }),
                    })
                  }
                }}
                disabled={!autoSync}
                className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1 text-white text-sm focus:outline-none disabled:opacity-40"
              >
                <option value={15}>每 15 秒（快速）</option>
                <option value={30}>每 30 秒</option>
                <option value={60}>每 1 分钟</option>
                <option value={300}>每 5 分钟</option>
                <option value={600}>每 10 分钟</option>
              </select>
              {autoSync && <span className="text-xs text-green-400">● 自动同步运行中</span>}
            </div>
          )}

          {/* 授权链接（弹窗被拦截时手动点击）*/}
          {feishuAuthUrl && !feishuAuthed && (
            <div className="mb-4 p-3 bg-[#1a1a1a] border border-yellow-600/30 rounded-lg">
              <p className="text-yellow-400 text-xs mb-2">点击下方链接完成飞书授权：</p>
              <a
                href={feishuAuthUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-400 text-sm underline break-all"
                onClick={() => setFeishuAuthUrl('')}
              >
                点击授权飞书账号
              </a>
            </div>
          )}

          {/* 同步日志 */}
          {(feishuLog.length > 0 || feishuResult) && (
            <div>
              <div
                ref={logRef}
                className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg p-3 h-36 overflow-y-auto font-mono text-xs text-gray-400 space-y-0.5"
              >
                {feishuLog.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
                {feishuSyncing && <div className="text-blue-400 animate-pulse">同步中...</div>}
              </div>
              {feishuResult && !feishuResult.error && (
                <p className="text-sm text-gray-400 mt-2">
                  同步完成：导入 <span className="text-green-400 font-mono">{feishuResult.imported}</span> 条，
                  处理 <span className="font-mono">{feishuResult.chats}</span> 个会话
                  {feishuResult.errors?.length > 0 && (
                    <span className="text-orange-400">，{feishuResult.errors.length} 个错误</span>
                  )}
                </p>
              )}
            </div>
          )}
        </Section>

        {/* ── 03 实时消息 ── */}
        <Section title={`03 实时消息${realtimeUnread > 0 ? ` (${realtimeUnread} 条未读)` : ''}`}>
          <p className="text-gray-500 text-sm mb-4">
            通过飞书事件订阅接收实时消息，自动生成 AI 回复建议。
            需在飞书开放平台配置事件订阅，回调 URL：<code className="text-purple-400">https://relay.botook.ai/feishu/event</code>，
            订阅事件 <code className="text-purple-400">im.message.receive_v1</code>。
          </p>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={triggerRealtimePoll}
              disabled={realtimePolling}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm transition-colors disabled:opacity-50"
            >
              {realtimePolling ? '同步中...' : '手动拉取'}
            </button>
            {realtimeUnread > 0 && (
              <button
                onClick={markAllRead}
                className="px-4 py-2 rounded-lg bg-[#1f1f1f] hover:bg-[#2a2a2a] text-gray-400 hover:text-white text-sm border border-[#2a2a2a] transition-colors"
              >
                全部标记已读
              </button>
            )}
            <span className="text-xs text-gray-600">每30秒自动刷新</span>
          </div>
          {realtimeSuggestions.length === 0 ? (
            <p className="text-gray-600 text-sm">暂无实时消息。配置飞书事件订阅后，收到消息将在此显示。</p>
          ) : (
            <div className="space-y-3 max-h-[480px] overflow-y-auto">
              {realtimeSuggestions.map((s) => (
                <div key={s.id} className={`rounded-lg border p-3 ${s.is_read ? 'border-[#1f1f1f] bg-[#0a0a0a]' : 'border-blue-600/30 bg-[#0a0f1a]'}`}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-blue-400 font-medium text-sm">{s.contact_name}</span>
                    <span className="text-gray-600 text-xs font-mono">{s.created_at?.slice(0, 16)}</span>
                  </div>
                  <p className="text-white text-sm mb-2">{s.incoming_content}</p>
                  {s.suggestion && (
                    <div className="bg-[#111111] rounded p-2 text-xs text-gray-400 whitespace-pre-wrap border-l-2 border-purple-600/50">
                      {s.suggestion}
                    </div>
                  )}
                  {!s.suggestion && (
                    <p className="text-gray-600 text-xs">（设置 OPENROUTER_API_KEY 可自动生成回复建议）</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* ── 04 联系人邮箱 ── */}
        <Section title="04 联系人">
          {contacts.length === 0 ? (
            <p className="text-gray-600 text-sm">暂无联系人，先导入微信记录或同步飞书</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 text-xs border-b border-[#1f1f1f]">
                    <th className="text-left py-2 pr-4 font-mono">姓名</th>
                    <th className="text-left py-2 pr-4 font-mono">邮箱</th>
                    <th className="text-right py-2 font-mono">消息数</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => {
                    const isEditing = c.id in editingEmail
                    const currentEmail = isEditing ? editingEmail[c.id] : (c.email ?? '')
                    return (
                      <tr key={c.id} className="border-b border-[#1a1a1a] hover:bg-[#0f0f0f]">
                        <td className="py-2.5 pr-4 text-white font-medium">{c.name}</td>
                        <td className="py-2.5 pr-4">
                          <div className="flex items-center gap-2">
                            <input
                              type="email" value={currentEmail}
                              placeholder={c.email ? '' : '未填写'}
                              onChange={(e) => setEditingEmail({ ...editingEmail, [c.id]: e.target.value })}
                              className={`bg-transparent border-b text-sm py-0.5 focus:outline-none transition-colors w-48 ${
                                !c.email ? 'border-orange-500/50 text-orange-400 placeholder-orange-500/50' : 'border-[#2a2a2a] text-gray-300'
                              } focus:border-purple-600`}
                            />
                            {isEditing && (
                              <button onClick={() => saveEmail(c.id)} className="text-xs text-purple-400 hover:text-purple-300">保存</button>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 text-right text-gray-500 font-mono">{c.message_count}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* ── 04 飞书文档同步 ── */}
        <DocSyncSection />

        {/* ── 05 聊天记录 ── */}
        <Section title="06 聊天记录">
          <div className="flex gap-2 mb-4">
            <select
              value={msgContact}
              onChange={e => { setMsgContact(e.target.value); setMsgPage(1) }}
              className="bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-600/60 w-40"
            >
              <option value="">全部联系人</option>
              {contacts.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
            <input
              type="text"
              placeholder="搜索内容..."
              value={msgQuery}
              onChange={e => { setMsgQuery(e.target.value); setMsgPage(1) }}
              className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-purple-600/60"
            />
          </div>
          <div className="text-xs text-gray-600 mb-2">共 {msgTotal} 条{msgLoading ? '，加载中...' : ''}</div>
          <div className="space-y-1 max-h-[480px] overflow-y-auto">
            {messages.map(m => (
              <div key={m.id} className={`flex gap-2 text-xs rounded px-2 py-1.5 ${m.direction === 'sent' ? 'bg-[#0f0f1a]' : 'bg-[#0a0a0a]'}`}>
                <span className="text-gray-600 w-32 shrink-0 font-mono">{m.timestamp.slice(0, 16)}</span>
                <span className={`w-24 shrink-0 truncate ${m.direction === 'sent' ? 'text-purple-400' : 'text-blue-400'}`}>{m.contact_name}</span>
                <span className={`shrink-0 text-[10px] w-6 ${m.direction === 'sent' ? 'text-purple-600' : 'text-blue-600'}`}>{m.direction === 'sent' ? '发' : '收'}</span>
                <span className="text-gray-300 break-all">{m.content}</span>
              </div>
            ))}
          </div>
          {msgTotal > 50 && (
            <div className="flex items-center gap-3 mt-3">
              <button onClick={() => setMsgPage(p => Math.max(1, p - 1))} disabled={msgPage === 1}
                className="px-3 py-1 text-xs rounded bg-[#1f1f1f] text-gray-400 hover:text-white disabled:opacity-30">上一页</button>
              <span className="text-xs text-gray-600">{msgPage} / {Math.ceil(msgTotal / 50)}</span>
              <button onClick={() => setMsgPage(p => p + 1)} disabled={msgPage >= Math.ceil(msgTotal / 50)}
                className="px-3 py-1 text-xs rounded bg-[#1f1f1f] text-gray-400 hover:text-white disabled:opacity-30">下一页</button>
            </div>
          )}
        </Section>

        {/* ── 06 权限 + SMTP ── */}
        <Section title="07 权限 + SMTP 配置">
          <div className="mb-5">
            <p className="text-gray-400 text-xs mb-2">发送权限</p>
            <div className="flex gap-3">
              {[
                { value: 'suggest', label: '仅建议，需确认', desc: '安全' },
                { value: 'auto', label: '直接发送', desc: '自动' },
              ].map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="permission_mode" value={opt.value}
                    checked={settings.permission_mode === opt.value}
                    onChange={() => setSettings({ ...settings, permission_mode: opt.value })}
                    className="accent-purple-600"
                  />
                  <span className="text-sm text-white">{opt.label}</span>
                  <span className="text-xs text-gray-600">({opt.desc})</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-5">
            <Input label="SMTP Host" value={settings.smtp_host} onChange={(v) => setSettings({ ...settings, smtp_host: v })} placeholder="smtp.gmail.com" />
            <Input label="端口" value={settings.smtp_port} onChange={(v) => setSettings({ ...settings, smtp_port: v })} placeholder="587" />
            <Input label="邮箱账号" value={settings.smtp_user} onChange={(v) => setSettings({ ...settings, smtp_user: v })} placeholder="you@gmail.com" />
            <Input label="密码 / App Password" type="password" value={settings.smtp_pass} onChange={(v) => setSettings({ ...settings, smtp_pass: v })} placeholder="••••••••" />
            <div className="col-span-2">
              <Input label="发件人名字" value={settings.smtp_from_name} onChange={(v) => setSettings({ ...settings, smtp_from_name: v })} placeholder="张三" />
            </div>
          </div>

          <button onClick={saveSettings} disabled={settingsSaving}
            className="px-5 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm transition-colors disabled:opacity-50">
            {settingsSaved ? '已保存' : settingsSaving ? '保存中...' : '保存配置'}
          </button>
        </Section>

        {/* ── 07 安装命令 ── */}
        <Section title="08 安装 MCP Server">
          <p className="text-gray-400 text-sm mb-3">复制以下命令到终端，完成 agent 安装：</p>
          <div className="relative bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg px-4 py-3 font-mono text-sm text-green-400 overflow-x-auto">
            <pre className="whitespace-pre-wrap break-all">{installCmd}</pre>
            <button onClick={copyCmd}
              className="absolute top-2 right-2 px-2 py-1 text-xs rounded bg-[#1f1f1f] text-gray-400 hover:text-white hover:bg-[#2a2a2a] transition-colors">
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <p className="text-gray-600 text-xs mt-2">安装后重启 Claude Code，在对话中问"我该联系谁了？"即可开始使用。</p>
        </Section>
      </div>
    </main>
  )
}
