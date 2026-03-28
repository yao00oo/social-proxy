'use client'

import { useSession } from 'next-auth/react'
import { signIn } from 'next-auth/react'
import { useState } from 'react'

export default function ConnectPage() {
  const { data: session, status } = useSession()
  const [code, setCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-outline text-sm">Loading...</p>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl border border-outline-variant/20 p-10 w-full max-w-sm text-center space-y-6 shadow-lg">
          <div>
            <div className="w-14 h-14 bg-primary-container rounded-2xl flex items-center justify-center text-white font-black text-2xl font-[Manrope] mx-auto mb-3">S</div>
            <h1 className="font-[Manrope] font-extrabold text-xl text-on-surface">连接 CLI</h1>
            <p className="text-outline text-sm mt-1">请先登录以授权 CLI 访问</p>
          </div>
          <button
            onClick={() => signIn('google', { callbackUrl: '/connect' })}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface text-sm font-medium transition-colors border border-outline-variant/20"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Sign in with Google
          </button>
        </div>
      </div>
    )
  }

  async function handleConfirm() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/connect', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to generate code')
      }
      const data = await res.json()
      setCode(data.code)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function handleCopy() {
    if (code) {
      navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-6">
      <div className="bg-white rounded-2xl border border-outline-variant/20 p-10 w-full max-w-sm text-center space-y-6 shadow-lg">
        <div>
          <div className="w-14 h-14 bg-primary-container rounded-2xl flex items-center justify-center text-white font-black text-2xl font-[Manrope] mx-auto mb-3">S</div>
          <h1 className="font-[Manrope] font-extrabold text-xl text-on-surface">连接 CLI</h1>
          <p className="text-outline text-sm mt-1">
            {session.user?.name || session.user?.email}
          </p>
        </div>

        {!code ? (
          <div className="space-y-4">
            <p className="text-on-surface-variant text-sm">
              授权 CLI 访问你的数据？
            </p>
            <p className="text-outline text-xs">
              确认后会生成一个一次性代码，将其粘贴到终端中完成连接。代码 5 分钟内有效。
            </p>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="w-full px-4 py-3 rounded-xl bg-primary-container text-white text-sm font-semibold transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {loading ? '生成中...' : '确认授权'}
            </button>
            {error && <p className="text-red-500 text-xs">{error}</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-on-surface-variant text-sm">
              你的一次性连接代码：
            </p>
            <div
              onClick={handleCopy}
              className="bg-surface-container rounded-xl p-4 font-mono text-2xl font-bold tracking-[0.3em] text-on-surface cursor-pointer hover:bg-surface-container-high transition-colors border border-outline-variant/20"
              title="Click to copy"
            >
              {code}
            </div>
            <button
              onClick={handleCopy}
              className="w-full px-4 py-2 rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface text-sm font-medium transition-colors border border-outline-variant/20"
            >
              {copied ? '已复制' : '复制代码'}
            </button>
            <p className="text-outline text-xs">
              将此代码粘贴到终端中，5 分钟内有效，仅可使用一次。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
