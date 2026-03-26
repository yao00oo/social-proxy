// GET /api/stats — 全量统计（移植自 MCP get_stats）
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getUserId, unauthorized } from '@/lib/auth-helper'

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const db = getDb()

  const total = (db.prepare('SELECT COUNT(*) as n FROM contacts').get() as any).n
  const totalMsgs = (db.prepare('SELECT COUNT(*) as n FROM messages').get() as any).n

  const buckets = db.prepare(`
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
      SELECT CAST((julianday('now') - julianday(last_contact_at)) AS INTEGER) AS days
      FROM contacts WHERE last_contact_at IS NOT NULL
    )
    GROUP BY bucket
    ORDER BY MIN(days) DESC
  `).all()

  const noEmail = (db.prepare(
    `SELECT COUNT(*) as n FROM contacts WHERE email IS NULL OR email = ''`
  ).get() as any).n

  const topActive = db.prepare(`
    SELECT name, message_count, last_contact_at,
      CAST((julianday('now') - julianday(last_contact_at)) AS INTEGER) AS days_since
    FROM contacts ORDER BY message_count DESC LIMIT 20
  `).all()

  const overdue = db.prepare(`
    SELECT name, email, message_count, last_contact_at,
      CAST((julianday('now') - julianday(last_contact_at)) AS INTEGER) AS days_since
    FROM contacts WHERE last_contact_at IS NOT NULL
    ORDER BY days_since DESC LIMIT 20
  `).all()

  const recent = db.prepare(`
    SELECT name, email, message_count, last_contact_at
    FROM contacts WHERE last_contact_at >= date('now', '-30 days')
    ORDER BY last_contact_at DESC LIMIT 20
  `).all()

  return NextResponse.json({ total, totalMsgs, noEmail, buckets, topActive, overdue, recent })
}
