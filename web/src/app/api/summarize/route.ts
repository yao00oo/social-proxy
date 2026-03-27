// POST /api/summarize — Trigger AI summary generation for threads
export const maxDuration = 60

import { NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { generateSummaries } from '@/lib/summarize'

export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  try {
    const count = await generateSummaries(userId)
    return NextResponse.json({ ok: true, generated: count })
  } catch (err: any) {
    console.error('[summarize] API error:', err.message)
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}
