import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // NextAuth v4 cookie names
  const token = request.cookies.get('next-auth.session-token') || request.cookies.get('__Secure-next-auth.session-token')
  const isLoginPage = request.nextUrl.pathname.startsWith('/login')
  const isDeviceAuth = request.nextUrl.pathname.startsWith('/auth/device')
  const isAuthApi = request.nextUrl.pathname.startsWith('/api/auth')
  const isHealthApi = request.nextUrl.pathname.startsWith('/api/health')
  const isAgentApi = request.nextUrl.pathname.startsWith('/api/agent-sync') || request.nextUrl.pathname.startsWith('/api/auth/device')
  const isTerminalApi = request.nextUrl.pathname.startsWith('/api/terminal')
  const isStaticFile = request.nextUrl.pathname.endsWith('.sh') || request.nextUrl.pathname.endsWith('.ps1') || request.nextUrl.pathname.startsWith('/terminal/')
  const isInstallPage = request.nextUrl.pathname.startsWith('/install')
  const isLegalPage = request.nextUrl.pathname.startsWith('/privacy') || request.nextUrl.pathname.startsWith('/terms')
  const isConnectApi = request.nextUrl.pathname.startsWith('/api/connect') && request.method === 'GET'
  // Bearer token 请求不走 cookie 拦截（由 getUserId() 内部验证 token）
  const hasBearerToken = request.headers.get('authorization')?.startsWith('Bearer ')
  const isPublic = isLoginPage || isDeviceAuth || isAuthApi || isHealthApi || isAgentApi || isStaticFile || isTerminalApi || isInstallPage || isLegalPage || isConnectApi || hasBearerToken

  if (!token && !isPublic) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (token && isLoginPage) {
    return NextResponse.redirect(new URL('/', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}
