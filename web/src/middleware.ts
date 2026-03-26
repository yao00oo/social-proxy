import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // NextAuth v4 cookie names
  const token = request.cookies.get('next-auth.session-token') || request.cookies.get('__Secure-next-auth.session-token')
  const isLoginPage = request.nextUrl.pathname.startsWith('/login')
  const isAuthApi = request.nextUrl.pathname.startsWith('/api/auth')
  const isHealthApi = request.nextUrl.pathname.startsWith('/api/health')
  const isPublic = isLoginPage || isAuthApi || isHealthApi

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
