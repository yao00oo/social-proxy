// GET /api/sync-status — 返回所有数据源的同步状态（统一多平台模型）
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

  // 飞书是否已授权
  const feishuAuthRow = await queryOne<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'feishu_auth_done' AND user_id = ?`, [userId]
  )
  const feishuAuthed = feishuAuthRow?.value === '1'

  // 飞书同步统计：通过 channels + threads 计算
  const feishuChannel = await queryOne<{ id: number }>(
    `SELECT id FROM channels WHERE platform = 'feishu' AND user_id = ? LIMIT 1`, [userId]
  )

  let syncedChats = 0
  let totalChats = 0
  if (feishuChannel) {
    const feishuStats = await queryOne<{ synced: string; total: string }>(
      `SELECT
         (SELECT COUNT(*) FROM threads WHERE channel_id = ? AND user_id = ? AND last_sync_ts IS NOT NULL AND last_sync_ts != '0') as synced,
         (SELECT COUNT(*) FROM threads WHERE channel_id = ? AND user_id = ?) as total`,
      [feishuChannel.id, userId, feishuChannel.id, userId]
    )
    syncedChats = parseInt(feishuStats?.synced || '0')
    totalChats = parseInt(feishuStats?.total || '0')
  }

  // 总体数据统计
  const counts = await queryOne<{ messages: string; contacts: string }>(
    `SELECT
       (SELECT COUNT(*) FROM messages WHERE user_id = ?) as messages,
       (SELECT COUNT(*) FROM contacts WHERE user_id = ?) as contacts`,
    [userId, userId]
  )

  // status: idle | syncing | paused | error | completed | completed_with_errors | not_connected
  let feishuStatus = feishu?.status || 'idle'
  if (!feishuAuthed) feishuStatus = 'not_connected'

  return NextResponse.json({
    feishu: {
      status: feishuStatus,
      running: feishu?.running || false,
      log: feishu?.log || [],
      lastResult: feishu?.lastResult || null,
      syncedChats,
      totalChats,
      authed: feishuAuthed,
      updatedAt: feishu?.updatedAt || null,
    },
    gmail: { status: 'not_connected', running: false },
    wechat: { status: 'idle' },
    totals: {
      messages: parseInt(counts?.messages || '0'),
      contacts: parseInt(counts?.contacts || '0'),
    },
  })
}
