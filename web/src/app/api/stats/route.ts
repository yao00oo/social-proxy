// GET /api/stats — 全量统计（移植自 MCP get_stats）
import { NextResponse } from 'next/server'
import { query, queryOne } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const totalRow = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM contacts WHERE user_id = ?', [userId])
  const total = totalRow?.n || 0
  const totalMsgsRow = await queryOne<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE user_id = ?', [userId])
  const totalMsgs = totalMsgsRow?.n || 0

  const buckets = await query(`
    SELECT
      CASE
        WHEN days >= 365 THEN '365天以上'
        WHEN days >= 180 THEN '180-365天'
        WHEN days >= 90  THEN '90-180天'
        WHEN days >= 30  THEN '30-90天'
        WHEN days >= 7   THEN '7-30天'
        ELSE '7天内'
      END AS bucket,
      COUNT(*) as count
    FROM (
      SELECT EXTRACT(DAY FROM NOW() - last_contact_at::timestamp)::integer AS days
      FROM contacts WHERE last_contact_at IS NOT NULL AND user_id = ?
    ) sub
    GROUP BY bucket
    ORDER BY MIN(days) DESC
  `, [userId])

  const noEmailRow = await queryOne<{ n: number }>(
    `SELECT COUNT(*) as n FROM contacts WHERE user_id = ? AND (email IS NULL OR email = '')`,
    [userId]
  )
  const noEmail = noEmailRow?.n || 0

  const topActive = await query(`
    SELECT name, message_count, last_contact_at,
      EXTRACT(DAY FROM NOW() - last_contact_at::timestamp)::integer AS days_since
    FROM contacts WHERE user_id = ? ORDER BY message_count DESC LIMIT 20
  `, [userId])

  const overdue = await query(`
    SELECT name, email, message_count, last_contact_at,
      EXTRACT(DAY FROM NOW() - last_contact_at::timestamp)::integer AS days_since
    FROM contacts WHERE last_contact_at IS NOT NULL AND user_id = ?
    ORDER BY days_since DESC LIMIT 20
  `, [userId])

  const recent = await query(`
    SELECT name, email, message_count, last_contact_at
    FROM contacts WHERE user_id = ? AND last_contact_at::timestamp >= NOW() - INTERVAL '30 days'
    ORDER BY last_contact_at DESC LIMIT 20
  `, [userId])

  return NextResponse.json({ total, totalMsgs, noEmail, buckets, topActive, overdue, recent })
}
