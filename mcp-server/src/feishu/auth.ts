// 飞书 token 管理 — 读取/刷新 user_access_token
import { getDb } from '../db'
import { getAppAccessToken, refreshToken } from './api'

const DEFAULT_USER_ID = process.env.DEFAULT_USER_ID || 'local'

export function getSetting(key: string, userId?: string): string {
  const uid = userId || DEFAULT_USER_ID
  const db = getDb()
  // 先尝试 per-user setting，再 fallback 到全局（兼容旧数据）
  const row = db.prepare(`SELECT value FROM settings WHERE key = ? AND (user_id = ? OR user_id IS NULL) ORDER BY user_id DESC LIMIT 1`).get(key, uid) as any
  if (row?.value) return row.value
  // 兼容旧表结构（无 user_id 列）
  try {
    const old = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any
    return old?.value || ''
  } catch {
    return ''
  }
}

export function saveSetting(key: string, value: string, userId?: string) {
  const uid = userId || DEFAULT_USER_ID
  const db = getDb()
  try {
    db.prepare(`
      INSERT INTO settings(user_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
    `).run(uid, key, value)
  } catch {
    // 兼容旧表结构（无 user_id 列）
    db.prepare(`
      INSERT INTO settings(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  }
}

// 确保 token 有效，过期则自动刷新
export async function ensureValidToken(userId?: string): Promise<string> {
  const token = getSetting('feishu_user_access_token', userId)
  const tokenTime = parseInt(getSetting('feishu_token_time', userId) || '0', 10)
  const refreshTk = getSetting('feishu_refresh_token', userId)
  const appId = getSetting('feishu_app_id', userId)
  const appSecret = getSetting('feishu_app_secret', userId)

  if (!token) throw new Error('未授权，请先在配置页面完成飞书 OAuth 授权')

  // user_access_token 有效期 2 小时，提前 5 分钟刷新
  const age = Date.now() - tokenTime
  if (age > (2 * 60 - 5) * 60 * 1000 && refreshTk) {
    const appToken = await getAppAccessToken(appId, appSecret)
    const newTokens = await refreshToken(refreshTk, appToken)
    saveSetting('feishu_user_access_token', newTokens.access_token, userId)
    saveSetting('feishu_refresh_token', newTokens.refresh_token, userId)
    saveSetting('feishu_token_time', Date.now().toString(), userId)
    return newTokens.access_token
  }

  return token
}
