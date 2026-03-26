// 飞书 API 封装 — 移植自 social-proxy MCP server
import https from 'https'
import { queryOne } from './db'

const BASE = 'https://open.feishu.cn/open-apis'

function request(url: string, options: https.RequestOptions, body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error(`JSON parse: ${data.slice(0, 200)}`)) }
      })
    })
    req.setTimeout(15000, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function post(path: string, body: object, headers: Record<string, string> = {}): Promise<any> {
  const bodyStr = JSON.stringify(body)
  return request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(bodyStr)), ...headers },
  }, bodyStr)
}

// Settings helpers
export async function getSetting(key: string): Promise<string> {
  const row = await queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  return row?.value || ''
}

// Get app access token
export async function getAppAccessToken(): Promise<string> {
  const appId = await getSetting('feishu_app_id')
  const appSecret = await getSetting('feishu_app_secret')
  if (!appId || !appSecret) throw new Error('未配置飞书 App ID / App Secret')
  const res = await post('/auth/v3/app_access_token/internal', { app_id: appId, app_secret: appSecret })
  if (res.code !== 0) throw new Error(`getAppAccessToken: ${res.msg}`)
  return res.app_access_token
}

// Send message via app bot
export async function sendMessage(
  token: string,
  receiveId: string,
  text: string,
  receiveIdType: 'open_id' | 'chat_id' = 'open_id',
): Promise<{ message_id: string }> {
  const res = await post(
    `/im/v1/messages?receive_id_type=${receiveIdType}`,
    { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
    { Authorization: `Bearer ${token}` },
  )
  if (res.code !== 0) throw new Error(`sendMessage: ${res.msg} (${res.code})`)
  return { message_id: res.data.message_id }
}
