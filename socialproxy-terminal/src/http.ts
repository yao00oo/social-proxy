// HTTP 工具 — 和 botook.ai 通信
import * as https from 'https'
import * as http from 'http'

export const BASE_URL = process.env.SOCIALPROXY_URL || 'https://botook.ai'

export function httpGet(
  path: string,
  token?: string
): Promise<{ status: number; body: string }> {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 35000,
    }, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
  })
}

export function httpPost(
  path: string,
  data: unknown,
  token?: string
): Promise<{ status: number; body: string }> {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
  const bodyStr = JSON.stringify(data)
  const parsed = new URL(url)

  return new Promise((resolve, reject) => {
    const mod = parsed.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'User-Agent': 'socialproxy-terminal/0.1.0',
      },
      timeout: 15000,
    }, (res) => {
      let body = ''
      res.on('data', chunk => body += chunk)
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
    req.write(bodyStr)
    req.end()
  })
}
