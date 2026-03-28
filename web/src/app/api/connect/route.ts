import { NextRequest, NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { exec, queryOne, query } from '@/lib/db'

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I/O/0/1 to avoid confusion
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

// POST /api/connect — Generate a one-time connect code (requires auth)
export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const code = generateCode()
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString() // 5 minutes
  const databaseUrl = process.env.DATABASE_URL || ''

  const value = JSON.stringify({ code, userId, databaseUrl, expires })

  // Clean up any existing connect codes for this user
  await exec(
    `DELETE FROM settings WHERE user_id = ? AND key = 'connect_code'`,
    [userId]
  )

  // Insert new code
  await exec(
    `INSERT INTO settings (user_id, key, value) VALUES (?, 'connect_code', ?)`,
    [userId, value]
  )

  return NextResponse.json({ code })
}

// GET /api/connect?code=XXXXXX — Exchange code for DATABASE_URL (public, no auth)
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.json({ error: 'Missing code parameter' }, { status: 400 })
  }

  // Find the code in settings
  const rows = await query<{ user_id: string; value: string }>(
    `SELECT user_id, value FROM settings WHERE key = 'connect_code'`
  )

  for (const row of rows) {
    try {
      const data = JSON.parse(row.value)
      if (data.code === code.toUpperCase()) {
        // Check expiry
        if (new Date(data.expires) < new Date()) {
          // Expired — delete and return error
          await exec(
            `DELETE FROM settings WHERE user_id = ? AND key = 'connect_code'`,
            [row.user_id]
          )
          return NextResponse.json({ error: 'Code expired' }, { status: 401 })
        }

        // Valid — delete (one-time use) and return credentials
        await exec(
          `DELETE FROM settings WHERE user_id = ? AND key = 'connect_code'`,
          [row.user_id]
        )

        return NextResponse.json({
          database_url: data.databaseUrl,
          user_id: data.userId,
        })
      }
    } catch {
      // Skip malformed entries
    }
  }

  return NextResponse.json({ error: 'Invalid code' }, { status: 401 })
}
