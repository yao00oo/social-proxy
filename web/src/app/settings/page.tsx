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
  imap_host: string
  imap_port: string
  imap_user: string
  imap_pass: string
  gmail_client_id: string
  gmail_client_secret: string
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
  imap_host: '',
  imap_port: '993',
  imap_user: '',
  imap_pass: '',
  gmail_client_id: '',
  gmail_client_secret: '',
  feishu_app_id: '',
  feishu_app_secret: '',
}

// ---------- Sub-components ----------

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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="text-[10px] px-2 py-0.5 rounded bg-surface-container-high hover:bg-surface-container-highest transition-colors cursor-pointer">
      {copied ? '已复制' : '复制'}
    </button>
  )
}

// ---------- Card components ----------

function SourceCard({
  icon,
  iconClass = 'text-on-surface-variant',
  title,
  subtitle,
  connected,
  connectedLabel,
  actionLabel,
  onAction,
  disabled,
  disabledLabel,
  dashed,
  children,
  expanded,
}: {
  icon: string
  iconClass?: string
  title: string
  subtitle?: string
  connected?: boolean
  connectedLabel?: string
  actionLabel?: string
  onAction?: () => void
  disabled?: boolean
  disabledLabel?: string
  dashed?: boolean
  children?: React.ReactNode
  expanded?: boolean
}) {
  if (dashed) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 rounded-[10px] border border-dashed border-outline-variant/40 p-3.5 h-[100px] text-outline">
        <span className="material-symbols-outlined text-2xl">add</span>
        <span className="text-xs">{title}</span>
      </div>
    )
  }

  if (disabled) {
    return (
      <div className="bg-surface-container-low opacity-60 outline outline-1 outline-outline-variant/20 rounded-[10px] p-3.5 h-[100px] flex flex-col justify-between">
        <div className="flex items-start gap-2.5">
          <span className={`material-symbols-outlined text-xl text-outline`}>{icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-on-surface truncate">{title}</p>
            {subtitle && <p className="text-xs text-outline mt-0.5 truncate">{subtitle}</p>}
          </div>
        </div>
        <p className="text-xs text-outline">{disabledLabel || '即将支持'}</p>
      </div>
    )
  }

  return (
    <div className={`bg-white outline outline-1 outline-outline-variant/20 rounded-[10px] p-3.5 h-[100px] flex flex-col justify-between ${onAction ? 'group cursor-pointer hover:bg-surface-container-low transition-colors' : ''}`}
      onClick={onAction || undefined}
    >
      <div className="flex items-start gap-2.5">
        <span className={`material-symbols-outlined text-xl ${iconClass}`} style={{ fontVariationSettings: "'FILL' 1" }}>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-on-surface truncate">{title}</p>
          {subtitle && <p className="text-xs text-on-surface-variant mt-0.5 truncate">{subtitle}</p>}
        </div>
      </div>
      <div className="flex items-center justify-between">
        {connected ? (
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-teal-500" />
            <span className="text-xs text-teal-700">{connectedLabel}</span>
          </div>
        ) : (
          actionLabel ? (
            <button className="text-xs font-medium text-primary hover:text-primary-container transition-colors cursor-pointer">
              {actionLabel}
            </button>
          ) : <span />
        )}
      </div>
      {children}
    </div>
  )
}

function SectionHeader({ icon, title, badge, badgeColor }: { icon: string; title: string; badge?: string; badgeColor?: string }) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <span className="material-symbols-outlined text-xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>{icon}</span>
      <h2 className="text-base font-semibold text-on-surface font-headline">{title}</h2>
      {badge && (
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
          badgeColor === 'orange' ? 'bg-accent-orange/10 text-accent-orange' :
          badgeColor === 'green' ? 'bg-teal-50 text-teal-700' :
          'bg-surface-container-high text-outline'
        }`}>{badge}</span>
      )}
    </div>
  )
}

// ---------- Feishu Stepper ----------

const FEISHU_PERMISSIONS = [
  { name: 'im:chat:readonly', desc: '获取会话列表' },
  { name: 'im:message:readonly', desc: '读取消息' },
  { name: 'im:message.group_msg:get_as_user', desc: '读取群消息' },
  { name: 'contact:contact:readonly', desc: '读取通讯录' },
  { name: 'drive:drive:readonly', desc: '读取云文档' },
  { name: 'docx:document:readonly', desc: '读取文档内容' },
]

const FEISHU_STEPS = [
  { title: '创建飞书应用' },
  { title: '开通权限' },
  { title: '配置回调地址' },
  { title: '填写凭证' },
  { title: '发布应用' },
  { title: '授权' },
]

function FeishuStepper({
  step,
  setStep,
  settings,
  setSettings,
  onSaveCredentials,
  savingCredentials,
  savedCredentials,
  onAuth,
  authing,
  authUrl,
  authed,
  userName,
}: {
  step: number
  setStep: (s: number) => void
  settings: Settings
  setSettings: (s: Settings) => void
  onSaveCredentials: () => Promise<void>
  savingCredentials: boolean
  savedCredentials: boolean
  onAuth: () => void
  authing: boolean
  authUrl: string
  authed: boolean
  userName: string
}) {
  return (
    <div className="space-y-4">
      {/* Step indicators */}
      <div className="flex items-center gap-1">
        {FEISHU_STEPS.map((s, i) => {
          const stepNum = i + 1
          const isActive = step === stepNum
          const isCompleted = step > stepNum || (stepNum === 6 && authed)
          return (
            <div key={i} className="flex items-center gap-1">
              {i > 0 && <div className={`w-4 h-px ${isCompleted ? 'bg-teal-400' : 'bg-outline-variant'}`} />}
              <button
                onClick={() => setStep(stepNum)}
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors cursor-pointer ${
                  isCompleted
                    ? 'bg-teal-500 text-white'
                    : isActive
                      ? 'bg-primary text-on-primary'
                      : 'border border-outline-variant text-outline'
                }`}
              >
                {isCompleted ? (
                  <span className="material-symbols-outlined text-sm">check</span>
                ) : stepNum}
              </button>
            </div>
          )
        })}
      </div>

      {/* Step title */}
      <p className="text-sm font-medium text-on-surface">
        步骤 {step}：{FEISHU_STEPS[step - 1].title}
      </p>

      {/* Step 1: Create app */}
      {step === 1 && (
        <div className="space-y-3">
          <p className="text-xs text-on-surface-variant">在飞书开放平台创建一个企业自建应用</p>
          <a
            href="https://open.feishu.cn/app"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            <span className="material-symbols-outlined text-base">open_in_new</span>
            打开飞书开放平台
          </a>
          <p className="text-xs text-outline leading-relaxed">
            点击「创建企业自建应用」 → 填写应用名称（如「社交助手」） → 点击创建
          </p>
          <div className="flex justify-end">
            <button onClick={() => setStep(2)}
              className="px-4 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium hover:bg-primary-container transition-colors cursor-pointer">
              下一步
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Permissions */}
      {step === 2 && (
        <div className="space-y-3">
          <p className="text-xs text-on-surface-variant">在应用的「权限管理」页面，搜索并开通以下权限：</p>
          <div className="space-y-2">
            {FEISHU_PERMISSIONS.map((perm) => (
              <div key={perm.name} className="flex items-center gap-2 bg-surface rounded-lg px-3 py-2">
                <code className="text-xs font-mono text-primary flex-1">{perm.name}</code>
                <span className="text-xs text-outline">{perm.desc}</span>
                <CopyButton text={perm.name} />
              </div>
            ))}
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(1)}
              className="px-4 py-2 rounded-xl bg-surface-container-high text-on-surface text-sm font-medium hover:bg-surface-container-highest transition-colors cursor-pointer">
              上一步
            </button>
            <button onClick={() => setStep(3)}
              className="px-4 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium hover:bg-primary-container transition-colors cursor-pointer">
              下一步
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Callback URL */}
      {step === 3 && (
        <div className="space-y-3">
          <p className="text-xs text-on-surface-variant">在应用的「安全设置」页面，添加重定向 URL：</p>
          <div className="flex items-center gap-2 bg-surface rounded-lg px-3 py-2.5">
            <code className="text-xs font-mono text-primary flex-1 break-all">https://relay.botook.ai/feishu/callback</code>
            <CopyButton text="https://relay.botook.ai/feishu/callback" />
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(2)}
              className="px-4 py-2 rounded-xl bg-surface-container-high text-on-surface text-sm font-medium hover:bg-surface-container-highest transition-colors cursor-pointer">
              上一步
            </button>
            <button onClick={() => setStep(4)}
              className="px-4 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium hover:bg-primary-container transition-colors cursor-pointer">
              下一步
            </button>
          </div>
        </div>
      )}

      {/* Step 4: Credentials */}
      {step === 4 && (
        <div className="space-y-3">
          <p className="text-xs text-on-surface-variant">在应用的「凭证与基础信息」页面，复制 App ID 和 App Secret 填入下方：</p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="App ID" value={settings.feishu_app_id} onChange={(v) => setSettings({ ...settings, feishu_app_id: v })} placeholder="cli_xxxxx" />
            <Input label="App Secret" type="password" value={settings.feishu_app_secret} onChange={(v) => setSettings({ ...settings, feishu_app_secret: v })} placeholder="xxxxx" />
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(3)}
              className="px-4 py-2 rounded-xl bg-surface-container-high text-on-surface text-sm font-medium hover:bg-surface-container-highest transition-colors cursor-pointer">
              上一步
            </button>
            <button onClick={async () => { await onSaveCredentials(); setStep(5) }}
              disabled={!settings.feishu_app_id || !settings.feishu_app_secret || savingCredentials}
              className="px-4 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium hover:bg-primary-container transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
              {savingCredentials ? '保存中...' : savedCredentials ? '已保存' : '保存并继续'}
            </button>
          </div>
        </div>
      )}

      {/* Step 5: Publish app */}
      {step === 5 && (
        <div className="space-y-3">
          <p className="text-xs text-on-surface-variant">在「版本管理与发布」页面，创建版本并提交审核</p>
          <p className="text-xs text-outline">如果你是企业管理员，审核会立即通过</p>
          <div className="flex justify-between">
            <button onClick={() => setStep(4)}
              className="px-4 py-2 rounded-xl bg-surface-container-high text-on-surface text-sm font-medium hover:bg-surface-container-highest transition-colors cursor-pointer">
              上一步
            </button>
            <button onClick={() => setStep(6)}
              className="px-4 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium hover:bg-primary-container transition-colors cursor-pointer">
              下一步
            </button>
          </div>
        </div>
      )}

      {/* Step 6: Authorize */}
      {step === 6 && (
        <div className="space-y-3">
          <p className="text-xs text-on-surface-variant">一切就绪！点击下方按钮完成飞书授权</p>
          <div className="flex items-center gap-3">
            {authed ? (
              <div className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-teal-500" />
                <span className="text-sm text-teal-700">已授权：{userName}</span>
              </div>
            ) : (
              <button onClick={onAuth} disabled={authing}
                className="px-4 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-medium hover:bg-primary-container transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                {authing ? '等待授权...' : '授权飞书'}
              </button>
            )}
          </div>
          {/* Auth URL fallback */}
          {authUrl && !authed && (
            <div className="p-3 bg-accent-orange/5 border border-accent-orange/20 rounded-xl">
              <p className="text-accent-orange text-xs mb-2">如果弹窗未打开，点击下方链接完成飞书授权：</p>
              <a href={authUrl} target="_blank" rel="noreferrer"
                className="text-secondary text-sm underline break-all">
                点击授权飞书账号
              </a>
            </div>
          )}
          <div className="flex justify-start">
            <button onClick={() => setStep(5)}
              className="px-4 py-2 rounded-xl bg-surface-container-high text-on-surface text-sm font-medium hover:bg-surface-container-highest transition-colors cursor-pointer">
              上一步
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- Doc Sync Section (state kept internal) ----------

function useDocSync() {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [result, setResult] = useState<any>(null)

  const handleSync = async () => {
    setRunning(true); setLog([]); setResult(null)
    await fetch('/api/feishu-docs', { method: 'POST' })
    const poll = setInterval(async () => {
      const s = await fetch('/api/feishu-docs').then(r => r.json())
      setLog(s.log || [])
      if (!s.running) { clearInterval(poll); setRunning(false); setResult(s.lastResult) }
    }, 1500)
  }

  return { running, log, result, handleSync }
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
  const [feishuStep, setFeishuStep] = useState(1)
  const [feishuCredSaving, setFeishuCredSaving] = useState(false)
  const [feishuCredSaved, setFeishuCredSaved] = useState(false)

  // AI Model
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; description: string }>>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [modelSaving, setModelSaving] = useState(false)

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

  // Expanded panels
  const [expandedCard, setExpandedCard] = useState<string | null>(null)

  // Terminal
  const [terminalConnected, setTerminalConnected] = useState(false)
  const [terminalName, setTerminalName] = useState<string | null>(null)

  // Doc sync
  const docSync = useDocSync()

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

  const saveFeishuCredentials = async () => {
    setFeishuCredSaving(true)
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feishu_app_id: settings.feishu_app_id,
        feishu_app_secret: settings.feishu_app_secret,
      }),
    })
    setFeishuCredSaving(false)
    setFeishuCredSaved(true)
    setTimeout(() => setFeishuCredSaved(false), 2000)
  }

  // ---------- Init ----------

  useEffect(() => {
    fetchSettings()
    checkFeishuAuth()
    checkGmailAuth()
    // Load available models
    fetch('/api/models').then(r => r.json()).then(data => setAvailableModels(data.models || [])).catch(() => {})
    // Load current model selection
    fetch('/api/settings').then(r => r.json()).then(data => {
      if (data.settings?.agent_model) setSelectedModel(data.settings.agent_model)
    }).catch(() => {})
    // Check terminal connection
    fetch('/api/contacts?limit=500').then(r => r.json()).then(data => {
      const term = (data.contacts || []).find((c: any) => c.platform === 'terminal')
      if (term) { setTerminalConnected(true); setTerminalName(term.name) }
    }).catch(() => {})
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
    setFeishuAuthing(true)
    setFeishuAuthUrl('')

    const res = await fetch('/api/feishu-auth', { method: 'POST' })
    const data = await res.json()
    if (data.error) { alert(data.error); setFeishuAuthing(false); return }

    setFeishuAuthed(false)
    setFeishuAuthUrl(data.authUrl)
    window.open(data.authUrl, '_blank', 'width=600,height=700')
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
    setFeishuLog(['开始同步...'])
    setFeishuResult(null)

    // Start polling for progress immediately
    const poll = setInterval(async () => {
      try {
        const status = await fetch('/api/feishu-sync').then(r => r.json())
        if (status.log?.length) setFeishuLog(status.log)
        if (status.lastResult) setFeishuResult(status.lastResult)
      } catch {}
    }, 2000)

    // Send sync request (this blocks until done or timeout)
    try {
      const res = await fetch('/api/feishu-sync', { method: 'POST' }).then(r => r.json())
      const result = res.result || {}

      // If there are remaining chats, auto-continue
      if (result.remaining > 0) {
        clearInterval(poll)
        setFeishuLog(prev => [...prev, `已同步 ${result.imported} 条，继续同步剩余 ${result.remaining} 个会话...`])
        // Recursive call to continue
        await handleFeishuSync()
        return
      }

      clearInterval(poll)
      setFeishuResult(result)
      setFeishuLog(prev => [...prev, `✅ 同步完成，共导入 ${result.imported || 0} 条消息`])
    } catch (err: any) {
      clearInterval(poll)
      setFeishuLog(prev => [...prev, `❌ 同步出错: ${err.message}`])
    }

    setFeishuSyncing(false)
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

  // ---------- Progress calculation ----------
  const connectedSources = [
    importResult !== null,
    feishuAuthed,
    gmailAuthed,
  ].filter(Boolean).length
  const totalSteps = 3

  // ---------- Render ----------

  return (
    <main className="h-screen overflow-y-auto bg-surface text-on-surface">
      {/* Header */}
      <header className="border-b border-outline-variant/30 px-6 py-4">
        <div className="max-w-[720px] mx-auto flex items-center gap-3">
          <Link href="/" className="flex items-center text-on-surface-variant hover:text-on-surface transition-colors">
            <span className="material-symbols-outlined text-xl">arrow_back</span>
          </Link>
          <span className="text-on-surface-variant text-sm">设置</span>
          <span className="text-outline text-sm">/</span>
          <span className="text-on-surface text-sm font-medium">数据源与能力配置</span>
        </div>
      </header>

      <div className="max-w-[720px] mx-auto px-6 py-8">
        {/* Title */}
        <div className="mb-6">
          <h1 className="text-on-surface font-bold text-xl font-headline">数据源与能力配置</h1>
          <p className="text-outline text-sm mt-1">告诉小林更多，它能帮你做更多</p>
        </div>

        {/* Progress stepper */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-on-surface-variant">配置进度</span>
            <span className="text-xs text-on-surface-variant">{connectedSources} / {totalSteps}</span>
          </div>
          <div className="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${(connectedSources / totalSteps) * 100}%` }} />
          </div>
          <div className="flex justify-between mt-2">
            {['导入消息', '授权发送', '监听配置'].map((step, i) => (
              <div key={step} className="flex items-center gap-1.5">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium ${
                  i < connectedSources ? 'bg-primary text-on-primary' : 'bg-surface-container-high text-outline'
                }`}>{i + 1}</div>
                <span className={`text-xs ${i < connectedSources ? 'text-primary' : 'text-outline'}`}>{step}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Section 0: AI 模型选择 */}
        <div className="mb-8">
          <SectionHeader icon="smart_toy" title="小林的大脑" />
          <div className="bg-white rounded-2xl p-5 ambient-shadow ghost-border">
            <p className="text-sm text-outline mb-3">选择小林使用的 AI 模型（通过 OpenRouter）</p>
            <div className="grid grid-cols-2 gap-2">
              {availableModels.map(m => (
                <button
                  key={m.id}
                  onClick={async () => {
                    setSelectedModel(m.id)
                    setModelSaving(true)
                    await fetch('/api/settings', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ agent_model: m.id }),
                    })
                    setModelSaving(false)
                  }}
                  className={`p-3 rounded-xl text-left transition-all ${
                    selectedModel === m.id || (!selectedModel && m.id === 'deepseek/deepseek-chat-v3-0324')
                      ? 'bg-primary/10 border-2 border-primary'
                      : 'bg-surface-container-highest/50 border-2 border-transparent hover:border-outline/20'
                  }`}
                >
                  <div className="text-sm font-medium text-on-surface">{m.name}</div>
                  <div className="text-xs text-outline mt-0.5">{m.description}</div>
                </button>
              ))}
            </div>
            {modelSaving && <p className="text-xs text-primary mt-2">保存中...</p>}
          </div>
        </div>

        {/* Section 1: 让小林了解你 */}
        <div className="mb-8">
          <SectionHeader icon="psychology" title="让小林了解你" />
          <div className="grid grid-cols-3 gap-3">
            {/* WeChat */}
            <SourceCard
              icon="chat_bubble"
              iconClass="text-teal-600"
              title="微信"
              subtitle="导入聊天记录"
              connected={importResult !== null}
              connectedLabel="已同步历史消息"
              actionLabel={importing ? '导入中...' : '导入'}
              onAction={() => fileRef.current?.click()}
            />
            <input ref={fileRef} type="file" accept=".txt,.csv" className="hidden" onChange={handleImport} disabled={importing} />

            {/* Feishu */}
            <SourceCard
              icon="corporate_fare"
              iconClass="text-blue-600"
              title="飞书"
              subtitle="企业消息同步"
              connected={feishuAuthed}
              connectedLabel="企业账号已关联"
              actionLabel={feishuAuthing ? '等待授权...' : '授权'}
              onAction={() => {
                if (feishuAuthed) {
                  setExpandedCard(expandedCard === 'feishu' ? null : 'feishu')
                } else {
                  setExpandedCard('feishu')
                }
              }}
            />

            {/* iMessage */}
            <SourceCard
              icon="sms"
              iconClass="text-green-600"
              title="iMessage"
              subtitle="通过 Mac 同步"
              actionLabel="设置"
              onAction={() => setExpandedCard(expandedCard === 'imessage' ? null : 'imessage')}
            />

            {/* 终端/CLI */}
            <SourceCard
              icon="terminal"
              iconClass="text-on-surface"
              title="终端/CLI"
              subtitle="远程控制 & 消息同步"
              connected={terminalConnected}
              connectedLabel={terminalName || '已连接'}
              actionLabel="连接终端"
              onAction={() => setExpandedCard(expandedCard === 'terminal' ? null : 'terminal')}
            />

            {/* WhatsApp */}
            <SourceCard icon="perm_phone_msg" title="WhatsApp" disabled disabledLabel="即将支持" />

            {/* Telegram */}
            <SourceCard icon="send" title="Telegram" disabled disabledLabel="即将支持" />

            {/* More */}
            <SourceCard icon="add" title="更多数据源" dashed />
          </div>

          {/* Terminal expanded panel */}
          {expandedCard === 'terminal' && (
            <div className="bg-white outline outline-1 outline-outline-variant/20 rounded-[10px] p-5 space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-on-surface">terminal</span>
                <h3 className="text-sm font-bold text-on-surface">连接终端</h3>
              </div>

              <p className="text-xs text-on-surface-variant leading-relaxed">
                在任意终端（Mac / Linux / Windows）运行以下命令，即可将终端连接为 Social Proxy 联系人。
                连接后可以在 Web 端给终端发消息，也可以在终端使用 Social Proxy 的所有数据。
              </p>

              <div className="bg-surface rounded-xl p-4 font-mono text-sm text-on-surface relative">
                <code>curl -fsSL https://botook.ai/install-terminal.sh | sh</code>
                <div className="absolute top-2 right-2">
                  <CopyButton text="curl -fsSL https://botook.ai/install-terminal.sh | sh" />
                </div>
              </div>

              <div className="space-y-2 text-xs text-on-surface-variant">
                <p className="font-medium text-on-surface">安装后会：</p>
                <div className="flex items-start gap-2"><span className="text-primary">1.</span><span>自动检测运行环境（Node.js / Bun）</span></div>
                <div className="flex items-start gap-2"><span className="text-primary">2.</span><span>弹出浏览器，登录并授权此终端</span></div>
                <div className="flex items-start gap-2"><span className="text-primary">3.</span><span>终端出现在联系人列表中，双向同步消息</span></div>
              </div>

              <div className="bg-surface rounded-xl p-3 space-y-2">
                <p className="text-[11px] font-bold text-outline uppercase tracking-wider">安装后可用的命令</p>
                <div className="font-mono text-xs text-on-surface-variant space-y-1">
                  <div><span className="text-primary">socialproxy-terminal</span> — 启动终端（首次需授权，之后免登录）</div>
                  <div><span className="text-primary">socialproxy-terminal send &quot;消息&quot;</span> — 发一条消息（脚本用）</div>
                  <div><span className="text-primary">socialproxy-terminal status</span> — 查看连接状态</div>
                  <div><span className="text-primary">socialproxy-terminal logout</span> — 断开连接</div>
                </div>
              </div>

              {terminalConnected && (
                <div className="flex items-center gap-2 p-3 bg-primary/5 rounded-xl">
                  <div className="w-2 h-2 rounded-full bg-teal-500" />
                  <span className="text-xs text-teal-700 font-medium">{terminalName} 已连接</span>
                </div>
              )}
            </div>
          )}

          {/* WeChat import result */}
          {importResult && (
            <div className="mt-3 p-3 bg-surface-container-low rounded-xl text-sm text-on-surface-variant">
              导入完成：成功 <span className="text-primary font-mono font-semibold">{importResult.imported}</span> 条，
              跳过 <span className="text-outline font-mono">{importResult.skipped}</span> 条
            </div>
          )}

          {/* Feishu expanded panel */}
          {expandedCard === 'feishu' && (
            <div className="mt-3 bg-surface-container-low rounded-xl p-5 space-y-4 ghost-border">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-on-surface">飞书授权配置</p>
                <button onClick={() => setExpandedCard(null)} className="text-outline hover:text-on-surface cursor-pointer">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>

              {feishuAuthed ? (
                <>
                  {/* Connected state: show status + sync controls */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full bg-teal-500" />
                      <span className="text-sm text-teal-700">已授权：{feishuUserName}</span>
                    </div>
                    <button onClick={handleFeishuAuth} disabled={feishuAuthing}
                      className="px-4 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed hover:bg-primary-container">
                      {feishuAuthing ? '等待授权...' : '重新授权'}
                    </button>
                    <button onClick={handleFeishuSync} disabled={feishuSyncing}
                      className="px-4 py-2 rounded-xl bg-surface-container-high text-on-surface text-sm font-medium border border-outline-variant transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed hover:bg-surface-container-highest">
                      {feishuSyncing ? '同步中...' : '立即同步'}
                    </button>
                  </div>

                  {/* Auto sync */}
                  <div className="flex items-center gap-3 flex-wrap">
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
                      <option value={15}>每 15 秒</option>
                      <option value={30}>每 30 秒</option>
                      <option value={60}>每 1 分钟</option>
                      <option value={300}>每 5 分钟</option>
                      <option value={600}>每 10 分钟</option>
                    </select>
                    {autoSync && <span className="text-xs text-primary">● 运行中</span>}
                  </div>

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

                  {/* Sync progress log */}
                  {(feishuSyncing || feishuLog.length > 0) && (
                    <div className="mt-3 bg-surface rounded-lg p-3 max-h-40 overflow-y-auto">
                      {feishuLog.map((line, i) => (
                        <p key={i} className="text-xs text-on-surface-variant font-mono leading-5">{line}</p>
                      ))}
                      {feishuSyncing && <p className="text-xs text-teal-600 animate-pulse mt-1">同步中...</p>}
                    </div>
                  )}
                  {feishuResult && !feishuSyncing && (
                    <p className="mt-2 text-xs text-on-surface-variant">
                      上次同步：导入 {feishuResult.imported || 0} 条消息
                    </p>
                  )}
                </>
              ) : (
                /* Not connected: show guided stepper */
                <FeishuStepper
                  step={feishuStep}
                  setStep={setFeishuStep}
                  settings={settings}
                  setSettings={setSettings}
                  onSaveCredentials={saveFeishuCredentials}
                  savingCredentials={feishuCredSaving}
                  savedCredentials={feishuCredSaved}
                  onAuth={handleFeishuAuth}
                  authing={feishuAuthing}
                  authUrl={feishuAuthUrl}
                  authed={feishuAuthed}
                  userName={feishuUserName}
                />
              )}
            </div>
          )}

          {/* iMessage expanded panel */}
          {expandedCard === 'imessage' && (
            <div className="mt-3 bg-surface-container-low rounded-xl p-5 space-y-4 ghost-border">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-on-surface">iMessage 同步设置</p>
                <button onClick={() => setExpandedCard(null)} className="text-outline hover:text-on-surface cursor-pointer">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>

              <p className="text-xs text-on-surface-variant">
                通过 botook-agent 在你的 Mac 上读取 iMessage 数据库，自动同步所有聊天记录和新消息。仅支持 macOS。
              </p>

              {/* Step 1 */}
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary-container text-white flex items-center justify-center text-xs font-bold">1</div>
                  <p className="text-sm font-medium text-on-surface">在 Mac 终端运行以下命令</p>
                </div>
                <div className="bg-surface rounded-lg p-3 font-mono text-sm text-primary relative group">
                  <code>curl -fsSL https://botook.ai/install-imessage.sh | sh</code>
                  <button
                    onClick={() => { navigator.clipboard.writeText('curl -fsSL https://botook.ai/install-imessage.sh | sh') }}
                    className="absolute right-2 top-2 text-[10px] px-2 py-0.5 rounded bg-surface-container-high hover:bg-surface-container-highest transition-colors opacity-0 group-hover:opacity-100"
                  >复制</button>
                </div>
              </div>

              {/* Step 2 */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary-container text-white flex items-center justify-center text-xs font-bold">2</div>
                  <p className="text-sm font-medium text-on-surface">浏览器弹出后，用 Google 账号登录</p>
                </div>
                <p className="text-xs text-on-surface-variant ml-9">和你在 botook.ai 登录的账号一致，数据会自动关联。</p>
              </div>

              {/* Step 3 */}
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary-container text-white flex items-center justify-center text-xs font-bold">3</div>
                  <p className="text-sm font-medium text-on-surface">授权完成，自动开始同步</p>
                </div>
                <p className="text-xs text-on-surface-variant ml-9">历史消息一次性导入，新消息实时同步。首次可能需要授权"完全磁盘访问"权限。</p>
              </div>

              <div className="bg-surface rounded-lg p-3 text-xs text-on-surface-variant space-y-1">
                <p className="font-medium text-on-surface">💡 常见问题</p>
                <p>• 需要 macOS 系统和 Node.js</p>
                <p>• 如果提示权限不足，在「系统设置 → 隐私与安全性 → 完全磁盘访问」中添加终端</p>
                <p>• agent 会在后台运行，关闭终端后需要重新启动</p>
              </div>
            </div>
          )}
        </div>

        {/* Section 2: 让小林帮你发送消息 */}
        <div className="mb-8">
          <SectionHeader
            icon="send"
            title="让小林帮你发送消息"
            badge={(!gmailAuthed || !feishuAuthed) ? '需要配置' : undefined}
            badgeColor="orange"
          />
          <div className="grid grid-cols-3 gap-3">
            {/* Gmail */}
            <SourceCard
              icon="mail"
              iconClass="text-error"
              title="Gmail"
              subtitle="OAuth 授权发送"
              connected={gmailAuthed}
              connectedLabel={gmailEmail || '已授权'}
              actionLabel="授权"
              onAction={() => setExpandedCard(expandedCard === 'gmail' ? null : 'gmail')}
            />

            {/* Feishu Bot */}
            <SourceCard
              icon="corporate_fare"
              iconClass="text-blue-600"
              title="飞书 Bot"
              subtitle="机器人消息发送"
              connected={feishuAuthed}
              connectedLabel="机器人权限已开启"
            />

            {/* SMTP */}
            <SourceCard
              icon="settings_suggest"
              iconClass="text-on-surface-variant"
              title="SMTP"
              subtitle="自定义邮件发送"
              connected={!!settings.smtp_host && !!settings.smtp_user}
              connectedLabel="已配置"
              actionLabel="配置"
              onAction={() => setExpandedCard(expandedCard === 'smtp' ? null : 'smtp')}
            />
          </div>

          {/* Gmail expanded panel */}
          {expandedCard === 'gmail' && (
            <div className="mt-3 bg-surface-container-low rounded-xl p-5 space-y-4 ghost-border">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-on-surface">Gmail 授权配置</p>
                <button onClick={() => setExpandedCard(null)} className="text-outline hover:text-on-surface cursor-pointer">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <p className="text-outline text-xs">
                在{' '}
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" className="text-secondary underline">Google Cloud Console</a>
                {' '}创建 OAuth Client ID，回调地址填{' '}
                <code className="text-primary font-mono text-xs">http://localhost:3000/api/gmail-callback</code>
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Input label="Gmail Client ID" value={settings.gmail_client_id} onChange={(v) => setSettings({ ...settings, gmail_client_id: v })} placeholder="xxx.apps.googleusercontent.com" />
                <Input label="Client Secret" type="password" value={settings.gmail_client_secret} onChange={(v) => setSettings({ ...settings, gmail_client_secret: v })} placeholder="GOCSPX-xxx" />
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {gmailAuthed ? (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-teal-500" />
                    <span className="text-sm text-teal-700">{gmailEmail}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-slate-300" />
                    <span className="text-sm text-outline">未授权</span>
                  </div>
                )}
                <button onClick={handleGmailAuth} disabled={!settings.gmail_client_id}
                  className="px-4 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed hover:bg-primary-container">
                  {gmailAuthed ? '重新授权' : '授权 Gmail'}
                </button>
                {gmailAuthed && (
                  <button onClick={handleGmailSync} disabled={gmailSyncing}
                    className="px-4 py-2 rounded-xl bg-surface-container-high text-on-surface text-sm font-medium border border-outline-variant transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed hover:bg-surface-container-highest">
                    {gmailSyncing ? '同步中...' : '同步邮件'}
                  </button>
                )}
                {gmailSyncResult && !gmailSyncResult.error && (
                  <span className="text-sm text-on-surface-variant">导入 <span className="text-primary font-mono font-semibold">{gmailSyncResult.imported}</span> 封</span>
                )}
              </div>
              {gmailSyncLog.length > 0 && (
                <LogPanel log={gmailSyncLog} running={gmailSyncing} />
              )}

              {/* Permission mode */}
              <div>
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
            </div>
          )}

          {/* SMTP expanded panel */}
          {expandedCard === 'smtp' && (
            <div className="mt-3 bg-surface-container-low rounded-xl p-5 space-y-4 ghost-border">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-on-surface">SMTP 配置</p>
                <button onClick={() => setExpandedCard(null)} className="text-outline hover:text-on-surface cursor-pointer">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Input label="SMTP Host" value={settings.smtp_host} onChange={(v) => setSettings({ ...settings, smtp_host: v })} placeholder="smtp.gmail.com" />
                <Input label="端口" value={settings.smtp_port} onChange={(v) => setSettings({ ...settings, smtp_port: v })} placeholder="587" />
                <Input label="邮箱账号" value={settings.smtp_user} onChange={(v) => setSettings({ ...settings, smtp_user: v })} placeholder="you@gmail.com" />
                <Input label="密码 / App Password" type="password" value={settings.smtp_pass} onChange={(v) => setSettings({ ...settings, smtp_pass: v })} placeholder="••••••••" />
                <div className="col-span-2">
                  <Input label="发件人名字" value={settings.smtp_from_name} onChange={(v) => setSettings({ ...settings, smtp_from_name: v })} placeholder="张三" />
                </div>
              </div>
              <button onClick={saveSettings} disabled={settingsSaving}
                className="px-4 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed hover:bg-primary-container">
                {settingsSaved ? '已保存' : settingsSaving ? '保存中...' : '保存配置'}
              </button>
            </div>
          )}
        </div>

        {/* Section 3: 让小林监听新消息 */}
        <div className="mb-8">
          <SectionHeader
            icon="notifications_active"
            title="让小林监听新消息"
            badge={feishuAuthed ? `${[feishuAuthed, gmailAuthed].filter(Boolean).length} 个运行中` : '未配置'}
            badgeColor={feishuAuthed ? 'green' : undefined}
          />
          <div className="grid grid-cols-3 gap-3">
            {/* Gmail IMAP */}
            <SourceCard
              icon="sync"
              iconClass="text-on-surface-variant"
              title="Gmail IMAP"
              subtitle="收件箱监听"
              connected={gmailAuthed}
              connectedLabel="同步运行中"
              actionLabel="配置"
              onAction={() => setExpandedCard(expandedCard === 'imap' ? null : 'imap')}
            />

            {/* Feishu Event */}
            <SourceCard
              icon="webhook"
              iconClass="text-blue-600"
              title="飞书 Event"
              subtitle="实时事件推送"
              connected={feishuAuthed}
              connectedLabel="实时同步中"
            />

            {/* Slack */}
            <SourceCard icon="tag" title="Slack" disabled disabledLabel="即将支持" />
          </div>

          {/* IMAP expanded panel */}
          {expandedCard === 'imap' && (
            <div className="mt-3 bg-surface-container-low rounded-xl p-5 space-y-4 ghost-border">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-on-surface">IMAP 收件同步</p>
                <button onClick={() => setExpandedCard(null)} className="text-outline hover:text-on-surface cursor-pointer">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              <p className="text-outline text-xs">
                同步收件箱和已发送邮件到本地。不填则自动从 SMTP 推导（smtp.→imap.）。
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Input label="IMAP Host" value={settings.imap_host} onChange={(v) => setSettings({ ...settings, imap_host: v })} placeholder="imap.gmail.com（可留空）" />
                <Input label="端口" value={settings.imap_port} onChange={(v) => setSettings({ ...settings, imap_port: v })} placeholder="993" />
                <Input label="邮箱账号" value={settings.imap_user} onChange={(v) => setSettings({ ...settings, imap_user: v })} placeholder="同 SMTP（可留空）" />
                <Input label="密码 / App Password" type="password" value={settings.imap_pass} onChange={(v) => setSettings({ ...settings, imap_pass: v })} placeholder="同 SMTP（可留空）" />
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <button onClick={saveSettings} disabled={settingsSaving}
                  className="px-4 py-2 rounded-xl bg-primary text-on-primary text-sm font-medium transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed hover:bg-primary-container">
                  {settingsSaved ? '已保存' : settingsSaving ? '保存中...' : '保存配置'}
                </button>
                <button onClick={handleEmailSync} disabled={emailSyncing}
                  className="px-4 py-2 rounded-xl bg-surface-container-high text-on-surface text-sm font-medium border border-outline-variant transition-colors disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed hover:bg-surface-container-highest">
                  {emailSyncing ? '同步中...' : '同步邮件'}
                </button>
                {emailSyncResult && !emailSyncResult.error && (
                  <span className="text-sm text-on-surface-variant">
                    收件 <span className="text-primary font-mono font-semibold">{emailSyncResult.inbox}</span>，
                    已发送 <span className="text-primary font-mono font-semibold">{emailSyncResult.sent}</span>
                  </span>
                )}
              </div>
              {emailSyncLog.length > 0 && (
                <LogPanel log={emailSyncLog} running={emailSyncing} />
              )}
            </div>
          )}
        </div>

        {/* Section 4: 让小林读取你的文件 */}
        <div className="mb-8">
          <SectionHeader
            icon="folder_open"
            title="让小林读取你的文件（可选）"
            badge="可选"
          />
          <div className="grid grid-cols-3 gap-3">
            {/* 多维表格/文档 */}
            <SourceCard
              icon="description"
              iconClass="text-blue-600"
              title="多维表格/文档"
              subtitle="飞书云文档同步"
              connected={docSync.result !== null && !docSync.result?.error}
              connectedLabel={docSync.result ? `${docSync.result.synced} 个文档` : undefined}
              actionLabel={docSync.running ? '同步中...' : docSync.result ? '重新同步' : '同步'}
              onAction={docSync.handleSync}
            />

            {/* 企业通讯录 */}
            <SourceCard
              icon="groups"
              iconClass="text-on-surface-variant"
              title="企业通讯录"
              subtitle="组织架构同步"
              connected={feishuAuthed}
              connectedLabel="通过飞书同步"
            />

            {/* Notion */}
            <SourceCard icon="edit_note" title="Notion" disabled disabledLabel="即将支持" />
          </div>

          {/* Doc sync log */}
          {(docSync.log.length > 0 || (docSync.result && !docSync.result.error)) && (
            <div className="mt-3">
              <LogPanel log={docSync.log} running={docSync.running} />
              {docSync.result && !docSync.result.error && (
                <p className="text-sm text-on-surface-variant mt-2">
                  共同步 <span className="text-primary font-mono font-semibold">{docSync.result.synced}</span> 个文档
                </p>
              )}
            </div>
          )}
        </div>

        {/* Spacer for footer */}
        <div className="h-20" />
      </div>

      {/* Footer Action Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-primary-container">
        <div className="max-w-[720px] mx-auto px-6 py-4 flex items-center justify-between">
          <span className="text-on-primary-container text-sm font-medium">准备好了吗？</span>
          <Link href="/"
            className="px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-medium hover:opacity-90 transition-opacity">
            开始对话
          </Link>
        </div>
      </div>
    </main>
  )
}
