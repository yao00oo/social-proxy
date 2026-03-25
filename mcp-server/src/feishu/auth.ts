// 飞书 token 管理 — 读取/刷新 user_access_token
import { getDb } from '../db'
import { getAppAccessToken, refreshToken } from './api'

export function getSetting(key: string): string {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any
  return row?.value || ''
}

export function saveSetting(key: string, value: string) {
  getDb().prepare(`
    INSERT INTO settings(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

// 确保 token 有效，过期则自动刷新
export async function ensureValidToken(): Promise<string> {
  const token = getSetting('feishu_user_access_token')
  const tokenTime = parseInt(getSetting('feishu_token_time') || '0', 10)
  const refreshTk = getSetting('feishu_refresh_token')
  const appId = getSetting('feishu_app_id')
  const appSecret = getSetting('feishu_app_secret')

  if (!token) throw new Error('未授权，请先在配置页面完成飞书 OAuth 授权')

  // user_access_token 有效期 2 小时，提前 5 分钟刷新
  const age = Date.now() - tokenTime
  if (age > (2 * 60 - 5) * 60 * 1000 && refreshTk) {
    const appToken = await getAppAccessToken(appId, appSecret)
    const newTokens = await refreshToken(refreshTk, appToken)
    saveSetting('feishu_user_access_token', newTokens.access_token)
    saveSetting('feishu_refresh_token', newTokens.refresh_token)
    saveSetting('feishu_token_time', Date.now().toString())
    return newTokens.access_token
  }

  return token
}
