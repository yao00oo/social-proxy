'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import Link from 'next/link'

// ---------- Types ----------
interface Settings {
  smtp_host: string
  smtp_port: string
  smtp_user: string
  smtp_pass: string
  smtp_from_name: string
  permission_mode: string
  feishu_app_id: string
  feishu_app_secret: string
  imap_host: string
  imap_port: string
  imap_user: string
  imap_pass: string
  gmail_client_id: string
  gmail_client_secret: string
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
  imap_host: '',
  imap_port: '993',
  imap_user: '',
  imap_pass: '',
  gmail_client_id: '',
  gmail_client_secret: '',
}

// ---------- Sub-components ----------

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="bg-surface-container-low rounded-2xl ghost-border ambient-shadow">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-6 py-5 cursor-pointer"
      >
        <h2 className="text-on-surface font-semibold text-base font-headline">{title}</h2>
        <span className="material-symbols-outlined text-outline transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          expand_more
        </span>
      </button>
      {open && <div className="px-6 pb-6">{children}</div>}
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
      <label className="block text-on-surface-variant text-xs mb-1.5">{label}</label>
      <input
        type={type} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-surface border border-outline-variant rounded-xl px-3 py-2.5 text-on-surface text-sm placeholder-outline focus:outline-none focus:border-primary transition-colors"
      />
    </div>
  )
}

function LogPanel({ log, running, label = '同步中...' }: { log: string[]; running: boolean; label?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [log])
  if (log.length === 0) return null
  return (
    <div ref={ref} className="bg-surface border border-outline-variant rounded-xl p-3 h-36 overflow-y-auto font-mono text-xs text-on-surface-variant space-y-0.5">
      {log.map((l, i) => <div key={i}>{l}</div>)}
      {running && <div className="text-primary animate-pulse">{label}</div>}
    </div>
  )
}

function PrimaryButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-5 py-2.5 rounded-xl bg-primary hover:bg-primary-container text-on-primary text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed">
      {children}
    </button>
  )
}

function SecondaryButton({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-5 py-2.5 rounded-xl bg-surface-container-high hover:bg-surface-container-highest text-on-surface text-sm font-medium border border-outline-variant transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed">
      {children}
    </button>
  )
}

function StatusDot({ active, label }: { active: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full inline-block ${active ? 'bg-primary-fixed-dim' : 'bg-outline'}`} />
      <span className={`text-sm ${active ? 'text-primary' : 'text-outline'}`}>{label}</span>
    </div>
  )
}

// ---------- Doc Sync Section ----------

function DocSyncSection() {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [result, setResult] = useState<any>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [log])

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
    <Section title="飞书文档同步">
      <p className="text-on-surface-variant text-sm mb-4">
        同步飞书云文档内容到本地，需开通 <code className="text-primary font-mono text-xs">drive:drive:readonly</code> 和 <code className="text-primary font-mono text-xs">docx:document:readonly</code> 用户身份权限。
      </p>
      <div className="flex items-center gap-3 mb-4">
        <PrimaryButton onClick={handleSync} disabled={running}>
          {running ? '同步中...' : '同步文档'}
        </PrimaryButton>
        {result && !result.error && (
          <span className="text-sm text-on-surface-variant">共 <span className="text-primary font-mono font-semibold">{result.synced}</span> 个文档</span>
        )}
      </div>
      <LogPanel log={log} running={running} />
    </Section>
  )
}

// ---------- Main Settings Page ----------

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  // WeChat import
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null)
  const [importing, setImporting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // Feishu
  const [feishuAuthed, setFeishuAuthed] = useState(false)
  const [feishuUserName, setFeishuUserName] = useState('')
  const [feishuAuthing, setFeishuAuthing] = useState(false)
  const [feishuAuthUrl, setFeishuAuthUrl] = useState('')
  const [feishuSyncing, setFeishuSyncing] = useState(false)
  const [feishuLog, setFeishuLog] = useState<string[]>([])
  const [feishuResult, setFeishuResult] = useState<any>(null)
  const [autoSync, setAutoSync] = useState(true)
  const [autoSyncSeconds, setAutoSyncSeconds] = useState(15)

  // Gmail OAuth
  const [gmailAuthed, setGmailAuthed] = useState(false)
  const [gmailEmail, setGmailEmail] = useState('')
  const [gmailSyncing, setGmailSyncing] = useState(false)
  const [gmailSyncLog, setGmailSyncLog] = useState<string[]>([])
  const [gmailSyncResult, setGmailSyncResult] = useState<any>(null)

  // IMAP email sync
  const [emailSyncing, setEmailSyncing] = useState(false)
  const [emailSyncLog, setEmailSyncLog] = useState<string[]>([])
  const [emailSyncResult, setEmailSyncResult] = useState<any>(null)

  // ---------- Fetchers ----------

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

  const checkGmailAuth = useCallback(async () => {
    const data = await fetch('/api/gmail-auth').then(r => r.json())
    setGmailAuthed(data.authed)
    if (data.email) setGmailEmail(data.email)
  }, [])

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

  // ---------- Init ----------

  useEffect(() => {
    fetchSettings()
    checkFeishuAuth()
    checkGmailAuth()
    fetch('/api/feishu-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoSyncSeconds: 15 }),
    })
  }, [fetchSettings, checkFeishuAuth, checkGmailAuth])

  // ---------- WeChat Import ----------

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
    if (fileRef.current) fileRef.current.value = ''
  }

  // ---------- Feishu OAuth ----------

  const handleFeishuAuth = async () => {
    if (!settings.feishu_app_id || !settings.feishu_app_secret) {
      alert('请先填写飞书 App ID 和 App Secret 并保存')
      return
    }
    setFeishuAuthing(true)
    setFeishuAuthUrl('')

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

    setFeishuAuthed(false)
    setFeishuAuthUrl(data.authUrl)
    const state = data.state

    let tries = 0
    const poll = setInterval(async () => {
      tries++
      try {
        const codeRes = await fetch(`https://relay.botook.ai/feishu/code?state=${state}`).then(r => r.json())
        if (codeRes.code) {
          clearInterval(poll)
          setFeishuAuthUrl('')
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

  // ---------- Feishu Sync ----------

  const handleFeishuSync = async () => {
    setFeishuSyncing(true)
    setFeishuLog([])
    setFeishuResult(null)
    await fetch('/api/feishu-sync', { method: 'POST' })
    const poll = setInterval(async () => {
      const status = await fetch('/api/feishu-sync').then(r => r.json())
      setFeishuLog(status.log || [])
      if (!status.running) {
        clearInterval(poll)
        setFeishuSyncing(false)
        setFeishuResult(status.lastResult)
      }
    }, 1500)
  }

  // ---------- Gmail OAuth ----------

  const handleGmailAuth = async () => {
    await saveSettings()
    const res = await fetch('/api/gmail-auth', { method: 'POST' })
    const data = await res.json()
    if (data.error) { alert(data.error); return }
    if (data.authUrl) {
      window.open(data.authUrl, '_blank', 'width=600,height=700')
      const state = data.state
      let tries = 0
      const poll = setInterval(async () => {
        tries++
        try {
          const codeRes = await fetch(`https://relay.botook.ai/gmail/code?state=${state}`).then(r => r.json())
          if (codeRes.code) {
            clearInterval(poll)
            const completeRes = await fetch('/api/gmail-complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: codeRes.code }),
            }).then(r => r.json())
            if (completeRes.error) {
              alert(`Gmail 授权失败: ${completeRes.error}`)
            } else {
              setGmailAuthed(true)
              setGmailEmail(completeRes.email || '')
            }
          }
        } catch {}
        if (tries > 60) clearInterval(poll)
      }, 2000)
    }
  }

  const handleGmailSync = async () => {
    setGmailSyncing(true); setGmailSyncLog([]); setGmailSyncResult(null)
    await fetch('/api/gmail-sync', { method: 'POST' })
    const poll = setInterval(async () => {
      const s = await fetch('/api/gmail-sync').then(r => r.json())
      setGmailSyncLog(s.log || [])
      if (!s.running) { clearInterval(poll); setGmailSyncing(false); setGmailSyncResult(s.lastResult) }
    }, 1500)
  }

  // ---------- IMAP Sync ----------

  const handleEmailSync = async () => {
    setEmailSyncing(true); setEmailSyncLog([])
    await fetch('/api/email-sync', { method: 'POST' })
    const poll = setInterval(async () => {
      const s = await fetch('/api/email-sync').then(r => r.json())
      setEmailSyncLog(s.log || [])
      if (!s.running) { clearInterval(poll); setEmailSyncing(false); setEmailSyncResult(s.lastResult) }
    }, 1500)
  }

  // ---------- Render ----------

  return (
    <main className="h-screen overflow-y-auto bg-surface text-on-surface">
      {/* Header */}
      <header className="border-b border-outline-variant/30 px-6 py-4">
        <div className="max-w-2xl mx-auto flex items-center gap-4">
          <Link href="/" className="flex items-center gap-1 text-on-surface-variant hover:text-on-surface transition-colors">
            <span className="material-symbols-outlined text-xl">arrow_back</span>
          </Link>
          <div>
            <h1 className="text-on-surface font-bold text-lg font-headline">Settings</h1>
            <p className="text-outline text-xs mt-0.5">数据源配置与同步</p>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-6 py-8 space-y-5">

        {/* ── 微信导入 ── */}
        <Section title="导入微信记录">
          <div className="mb-5 space-y-3">
            <p className="text-on-surface-variant text-sm font-medium">如何导出微信聊天记录？</p>

            <details className="group" open>
              <summary className="cursor-pointer text-sm text-secondary hover:text-secondary/80 transition-colors">
                方法一：电脑端多选复制（推荐）
              </summary>
              <ol className="mt-2 ml-4 text-xs text-on-surface-variant space-y-1.5 list-decimal list-outside">
                <li>在电脑端微信（Mac / Windows）打开聊天窗口</li>
                <li>滚动到要导出的起始位置，<strong className="text-on-surface">右键</strong>一条消息 → 点击「多选」</li>
                <li>勾选需要的消息（可按住 Shift 批量选择）</li>
                <li>点击底部「合并转发」→ 发送给「<strong className="text-on-surface">文件传输助手</strong>」</li>
                <li>打开「文件传输助手」→ 点开合并的聊天记录 → <strong className="text-on-surface">全选复制</strong></li>
                <li>粘贴到文本编辑器（记事本 / TextEdit），保存为 <code className="text-primary font-mono">.txt</code> 文件</li>
                <li>在下方上传该文件</li>
              </ol>
              <div className="mt-2 ml-4 p-2.5 bg-surface border border-outline-variant rounded-xl text-xs text-on-surface-variant">
                复制出的格式类似：
                <pre className="text-primary mt-1 whitespace-pre-wrap font-mono">{'张三 2024/09/16 2:51 PM\n今天下午开会吗？\n李四 2024/09/16 2:52 PM\n好的，三点见'}</pre>
              </div>
            </details>

            <details className="group">
              <summary className="cursor-pointer text-sm text-secondary hover:text-secondary/80 transition-colors">
                方法二：手机多选转发到电脑
              </summary>
              <ol className="mt-2 ml-4 text-xs text-on-surface-variant space-y-1.5 list-decimal list-outside">
                <li>手机微信打开聊天 → <strong className="text-on-surface">长按</strong>消息 → 「多选」</li>
                <li>勾选消息后点击底部「合并转发」→ 发给「<strong className="text-on-surface">文件传输助手</strong>」</li>
                <li>在电脑端微信打开「文件传输助手」→ 点开合并记录 → 全选复制</li>
                <li>粘贴到文本编辑器，保存为 <code className="text-primary font-mono">.txt</code> 后上传</li>
              </ol>
            </details>
          </div>

          <div className="mb-4 p-3 bg-surface border border-outline-variant rounded-xl">
            <p className="text-xs text-on-surface-variant mb-1">支持的文件格式：</p>
            <div className="flex gap-4 text-xs">
              <span className="text-primary font-mono">.txt</span>
              <span className="text-outline">每行 <code>时间 发送者: 消息内容</code></span>
            </div>
            <div className="flex gap-4 text-xs">
              <span className="text-primary font-mono">.csv</span>
              <span className="text-outline">包含时间、发送者、内容的 CSV</span>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <label className="cursor-pointer">
              <span className="inline-block px-5 py-2.5 rounded-xl bg-primary hover:bg-primary-container text-on-primary text-sm font-medium transition-colors">
                {importing ? '导入中...' : '选择文件上传'}
              </span>
              <input ref={fileRef} type="file" accept=".txt,.csv" className="hidden" onChange={handleImport} disabled={importing} />
            </label>
            {importResult && (
              <span className="text-sm text-on-surface-variant">
                成功 <span className="text-primary font-mono font-semibold">{importResult.imported}</span> 条，
                跳过 <span className="text-outline font-mono">{importResult.skipped}</span> 条
              </span>
            )}
          </div>
        </Section>

        {/* ── 飞书聊天同步 ── */}
        <Section title="飞书聊天同步">
          <p className="text-on-surface-variant text-sm mb-2">
            通过飞书 OAuth 授权，自动拉取聊天记录、通讯录、云文档。
            需要先在 <a href="https://open.feishu.cn" target="_blank" className="text-secondary underline">open.feishu.cn</a> 创建自建应用，开通以下权限：
          </p>
          <div className="bg-surface-container rounded-xl p-3 mb-4 text-xs font-mono text-on-surface-variant space-y-1">
            <p className="text-outline mb-1">应用身份权限（在开发者后台「权限管理」添加）：</p>
            <p>im:chat:readonly <span className="text-outline">— 获取会话列表</span></p>
            <p>im:message:readonly <span className="text-outline">— 读取消息</span></p>
            <p>im:message.group_msg:get_as_user <span className="text-outline">— 读取群消息</span></p>
            <p>contact:contact:readonly <span className="text-outline">— 读取通讯录（手机、邮箱）</span></p>
            <p>contact:user.employee:readonly <span className="text-outline">— 获取企业邮箱</span></p>
            <p>drive:drive:readonly <span className="text-outline">— 读取云文档</span></p>
            <p>docx:document:readonly <span className="text-outline">— 读取文档内容</span></p>
            <p>approval:approval:readonly <span className="text-outline">— 读取审批</span></p>
            <p className="text-outline mt-2">通讯录权限范围设为「全部员工」</p>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <Input label="App ID" value={settings.feishu_app_id} onChange={(v) => setSettings({ ...settings, feishu_app_id: v })} placeholder="cli_xxxxxxxxx" />
            <Input label="App Secret" type="password" value={settings.feishu_app_secret} onChange={(v) => setSettings({ ...settings, feishu_app_secret: v })} placeholder="••••••••" />
          </div>

          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <StatusDot active={feishuAuthed} label={feishuAuthed ? `已授权：${feishuUserName}` : '未授权'} />
            <SecondaryButton onClick={handleFeishuAuth} disabled={feishuAuthing}>
              {feishuAuthing ? '等待授权...' : feishuAuthed ? '重新授权' : '授权飞书账号'}
            </SecondaryButton>
            {feishuAuthed && (
              <PrimaryButton onClick={handleFeishuSync} disabled={feishuSyncing}>
                {feishuSyncing ? '同步中...' : '立即同步'}
              </PrimaryButton>
            )}
          </div>

          {/* Auto sync */}
          {feishuAuthed && (
            <div className="flex items-center gap-3 mb-4 flex-wrap">
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
                  className="accent-primary w-4 h-4"
                />
                <span className="text-sm text-on-surface">自动同步</span>
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
                className="bg-surface border border-outline-variant rounded-xl px-3 py-2 text-on-surface text-sm focus:outline-none disabled:opacity-40"
              >
                <option value={15}>每 15 秒（快速）</option>
                <option value={30}>每 30 秒</option>
                <option value={60}>每 1 分钟</option>
                <option value={300}>每 5 分钟</option>
                <option value={600}>每 10 分钟</option>
              </select>
              {autoSync && <span className="text-xs text-primary">● 自动同步运行中</span>}
            </div>
          )}

          {/* Auth URL fallback */}
          {feishuAuthUrl && !feishuAuthed && (
            <div className="mb-4 p-3 bg-accent-orange/5 border border-accent-orange/20 rounded-xl">
              <p className="text-accent-orange text-xs mb-2">点击下方链接完成飞书授权：</p>
              <a href={feishuAuthUrl} target="_blank" rel="noreferrer"
                className="text-secondary text-sm underline break-all"
                onClick={() => setFeishuAuthUrl('')}>
                点击授权飞书账号
              </a>
            </div>
          )}

          {/* Sync log */}
          {(feishuLog.length > 0 || feishuResult) && (
            <div>
              <LogPanel log={feishuLog} running={feishuSyncing} />
              {feishuResult && !feishuResult.error && (
                <p className="text-sm text-on-surface-variant mt-2">
                  同步完成：导入 <span className="text-primary font-mono font-semibold">{feishuResult.imported}</span> 条，
                  处理 <span className="font-mono">{feishuResult.chats}</span> 个会话
                  {feishuResult.errors?.length > 0 && (
                    <span className="text-accent-orange">，{feishuResult.errors.length} 个错误</span>
                  )}
                </p>
              )}
            </div>
          )}
        </Section>

        {/* ── 飞书文档同步 ── */}
        <DocSyncSection />

        {/* ── 邮件配置 ── */}
        <Section title="邮件配置">
          {/* Gmail OAuth */}
          <p className="text-on-surface-variant text-xs mb-2 font-medium">Gmail（推荐，OAuth 授权）</p>
          <p className="text-outline text-xs mb-3">
            一键授权后自动同步收件箱和已发送邮件。需先在{' '}
            <a href="https://console.cloud.google.com/apis/credentials" target="_blank" className="text-secondary underline">Google Cloud Console</a>
            {' '}创建 OAuth Client ID（类型选 Web application，回调地址填{' '}
            <code className="text-primary font-mono text-xs">http://localhost:3000/api/gmail-callback</code>），并启用 Gmail API。
          </p>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Input label="Gmail Client ID" value={settings.gmail_client_id} onChange={(v) => setSettings({ ...settings, gmail_client_id: v })} placeholder="xxx.apps.googleusercontent.com" />
            <Input label="Client Secret" type="password" value={settings.gmail_client_secret} onChange={(v) => setSettings({ ...settings, gmail_client_secret: v })} placeholder="GOCSPX-xxx" />
          </div>
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <PrimaryButton onClick={saveSettings} disabled={settingsSaving}>
              {settingsSaved ? '已保存' : '保存'}
            </PrimaryButton>
            <StatusDot active={gmailAuthed} label={gmailAuthed ? gmailEmail : '未授权'} />
            {!gmailAuthed ? (
              <SecondaryButton onClick={handleGmailAuth} disabled={!settings.gmail_client_id}>
                授权 Gmail
              </SecondaryButton>
            ) : (
              <>
                <PrimaryButton onClick={handleGmailSync} disabled={gmailSyncing}>
                  {gmailSyncing ? '同步中...' : '同步邮件'}
                </PrimaryButton>
                {gmailSyncResult && !gmailSyncResult.error && (
                  <span className="text-sm text-on-surface-variant">导入 <span className="text-primary font-mono font-semibold">{gmailSyncResult.imported}</span> 封</span>
                )}
              </>
            )}
          </div>
          {gmailSyncLog.length > 0 && (
            <div className="mb-5">
              <LogPanel log={gmailSyncLog} running={gmailSyncing} />
            </div>
          )}

          <hr className="border-outline-variant/30 my-5" />

          {/* Permission mode */}
          <div className="mb-5">
            <p className="text-on-surface-variant text-xs mb-2 font-medium">发送权限</p>
            <div className="flex gap-4">
              {[
                { value: 'suggest', label: '仅建议，需确认', desc: '安全' },
                { value: 'auto', label: '直接发送', desc: '自动' },
              ].map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="permission_mode" value={opt.value}
                    checked={settings.permission_mode === opt.value}
                    onChange={() => setSettings({ ...settings, permission_mode: opt.value })}
                    className="accent-primary"
                  />
                  <span className="text-sm text-on-surface">{opt.label}</span>
                  <span className="text-xs text-outline">({opt.desc})</span>
                </label>
              ))}
            </div>
          </div>

          {/* SMTP */}
          <p className="text-on-surface-variant text-xs mb-2 font-medium">SMTP（发件）</p>
          <div className="grid grid-cols-2 gap-3 mb-5">
            <Input label="SMTP Host" value={settings.smtp_host} onChange={(v) => setSettings({ ...settings, smtp_host: v })} placeholder="smtp.gmail.com" />
            <Input label="端口" value={settings.smtp_port} onChange={(v) => setSettings({ ...settings, smtp_port: v })} placeholder="587" />
            <Input label="邮箱账号" value={settings.smtp_user} onChange={(v) => setSettings({ ...settings, smtp_user: v })} placeholder="you@gmail.com" />
            <Input label="密码 / App Password" type="password" value={settings.smtp_pass} onChange={(v) => setSettings({ ...settings, smtp_pass: v })} placeholder="••••••••" />
            <div className="col-span-2">
              <Input label="发件人名字" value={settings.smtp_from_name} onChange={(v) => setSettings({ ...settings, smtp_from_name: v })} placeholder="张三" />
            </div>
          </div>

          {/* IMAP */}
          <p className="text-on-surface-variant text-xs mb-2 font-medium">IMAP（收件同步）</p>
          <p className="text-outline text-xs mb-3">
            同步收件箱和已发送邮件到本地，作为联系人沟通记录。不填则自动从 SMTP 推导（smtp.→imap.）。
          </p>
          <div className="grid grid-cols-2 gap-3 mb-5">
            <Input label="IMAP Host" value={settings.imap_host} onChange={(v) => setSettings({ ...settings, imap_host: v })} placeholder="imap.gmail.com（可留空自动推导）" />
            <Input label="端口" value={settings.imap_port} onChange={(v) => setSettings({ ...settings, imap_port: v })} placeholder="993" />
            <Input label="邮箱账号" value={settings.imap_user} onChange={(v) => setSettings({ ...settings, imap_user: v })} placeholder="同 SMTP（可留空）" />
            <Input label="密码 / App Password" type="password" value={settings.imap_pass} onChange={(v) => setSettings({ ...settings, imap_pass: v })} placeholder="同 SMTP（可留空）" />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <PrimaryButton onClick={saveSettings} disabled={settingsSaving}>
              {settingsSaved ? '已保存' : settingsSaving ? '保存中...' : '保存配置'}
            </PrimaryButton>
            <SecondaryButton onClick={handleEmailSync} disabled={emailSyncing}>
              {emailSyncing ? '同步中...' : '同步邮件'}
            </SecondaryButton>
            {emailSyncResult && !emailSyncResult.error && (
              <span className="text-sm text-on-surface-variant">
                收件 <span className="text-primary font-mono font-semibold">{emailSyncResult.inbox}</span>，
                已发送 <span className="text-primary font-mono font-semibold">{emailSyncResult.sent}</span>
              </span>
            )}
          </div>
          {emailSyncLog.length > 0 && (
            <div className="mt-4">
              <LogPanel log={emailSyncLog} running={emailSyncing} />
            </div>
          )}
        </Section>

      </div>
    </main>
  )
}
