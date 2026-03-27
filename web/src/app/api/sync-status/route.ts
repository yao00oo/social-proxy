// GET /api/sync-status — 返回所有数据源的同步状态（实时）
import { NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { queryOne, query } from '@/lib/db'

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  // 飞书同步状态
  const feishuStatusRow = await queryOne<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'feishu_sync_status' AND user_id = ?`, [userId]
  )
  const feishu = feishuStatusRow?.value ? JSON.parse(feishuStatusRow.value) : null

  // 飞书同步统计
  const feishuStats = await queryOne<{ synced: string; total: string }>(
    `SELECT
       (SELECT COUNT(*) FROM feishu_sync_state WHERE user_id = ? AND last_sync_ts != '0') as synced,
       (SELECT COUNT(*) FROM feishu_sync_state WHERE user_id = ?) as total`,
    [userId, userId]
  )

  // 总体数据统计
  const counts = await queryOne<{ messages: string; contacts: string }>(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE user_id = ?) as messages,
       (SELECT COUNT(*) FROM contacts WHERE user_id = ?) as contacts`,
    [userId, userId]
  )

  return NextResponse.json({
    feishu: {
      running: feishu?.running || false,
      log: feishu?.log || [],
      lastResult: feishu?.lastResult || null,
      syncedChats: parseInt(feishuStats?.synced || '0'),
      totalChats: parseInt(feishuStats?.total || '0'),
    },
    gmail: { running: false, synced: false }, // TODO
    wechat: { imported: false }, // TODO
    totals: {
      messages: parseInt(counts?.messages || '0'),
      contacts: parseInt(counts?.contacts || '0'),
    },
  })
}
