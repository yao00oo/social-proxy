// Tool: get_stats — 全量数据统计分析，不受 token 限制
import { getDb } from '../db'

export function getStats(userId?: string) {
  const db = getDb()
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'

  const total = (db.prepare(`SELECT COUNT(*) as n FROM contacts WHERE user_id = ?`).get(uid) as any).n
  const totalMsgs = (db.prepare(`SELECT COUNT(*) as n FROM messages WHERE user_id = ?`).get(uid) as any).n

  // 按失联天数分桶
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
      FROM contacts WHERE last_contact_at IS NOT NULL AND user_id = ?
    )
    GROUP BY bucket
    ORDER BY MIN(days) DESC
  `).all(uid)

  // 无邮箱的联系人数量
  const noEmail = (db.prepare(`SELECT COUNT(*) as n FROM contacts WHERE (email IS NULL OR email = '') AND user_id = ?`).get(uid) as any).n

  // 最活跃 Top 20
  const topActive = db.prepare(`
    SELECT name, message_count, last_contact_at,
      CAST((julianday('now') - julianday(last_contact_at)) AS INTEGER) AS days_since
    FROM contacts WHERE user_id = ? ORDER BY message_count DESC LIMIT 20
  `).all(uid)

  // 最久未联系 Top 20（有邮箱的优先，便于发邮件跟进）
  const overdue = db.prepare(`
    SELECT name, email, message_count, last_contact_at,
      CAST((julianday('now') - julianday(last_contact_at)) AS INTEGER) AS days_since
    FROM contacts
    WHERE last_contact_at IS NOT NULL AND user_id = ?
    ORDER BY days_since DESC LIMIT 20
  `).all(uid)

  // 最近 30 天活跃联系人
  const recent = db.prepare(`
    SELECT name, email, message_count, last_contact_at
    FROM contacts
    WHERE last_contact_at >= date('now', '-30 days') AND user_id = ?
    ORDER BY last_contact_at DESC LIMIT 20
  `).all(uid)

  return { total, totalMsgs, noEmail, buckets, topActive, overdue, recent }
}
