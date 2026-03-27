'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSession } from 'next-auth/react'

export default function DeviceAuthPage() {
  const { data: session, status } = useSession()
  const searchParams = useSearchParams()
  const code = searchParams.get('code')
  const [authStatus, setAuthStatus] = useState<'loading' | 'authorizing' | 'done' | 'error'>('loading')

  useEffect(() => {
    if (!code) return
    if (status === 'loading') return

    if (status === 'unauthenticated') {
      // Redirect to login with callback back to this page
      window.location.href = `/login?callbackUrl=${encodeURIComponent(`/auth/device?code=${code}`)}`
      return
    }

    // User is logged in — authorize the device
    setAuthStatus('authorizing')
    fetch(`/api/auth/device?code=${code}`)
      .then(r => {
        if (r.ok) setAuthStatus('done')
        else setAuthStatus('error')
      })
      .catch(() => setAuthStatus('error'))
  }, [code, status])

  if (!code) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <p className="text-outline">缺少设备码</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center">
      <div className="bg-white rounded-2xl border border-outline-variant/20 p-10 w-full max-w-sm text-center space-y-4 shadow-lg">
        {authStatus === 'loading' && (
          <>
            <div className="w-12 h-12 rounded-full bg-surface-container-high mx-auto animate-pulse" />
            <p className="text-outline">加载中...</p>
          </>
        )}
        {authStatus === 'authorizing' && (
          <>
            <div className="w-12 h-12 rounded-full bg-primary-container/20 mx-auto flex items-center justify-center">
              <span className="material-symbols-outlined text-primary-container animate-spin">sync</span>
            </div>
            <p className="text-on-surface font-medium">正在授权设备...</p>
          </>
        )}
        {authStatus === 'done' && (
          <>
            <div className="text-4xl">✅</div>
            <h1 className="font-[Manrope] font-bold text-xl text-primary">设备已授权</h1>
            <p className="text-outline text-sm">你可以关闭这个窗口了<br/>botook-agent 正在同步...</p>
          </>
        )}
        {authStatus === 'error' && (
          <>
            <div className="text-4xl">❌</div>
            <h1 className="font-[Manrope] font-bold text-xl text-on-surface">授权失败</h1>
            <p className="text-outline text-sm">请重新运行安装命令</p>
          </>
        )}
      </div>
    </div>
  )
}
