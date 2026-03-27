// Device Code 授权流程 — 终端生成码 → 浏览器授权 → 终端拿到 token
import * as crypto from 'crypto'
import * as os from 'os'
import { httpGet, httpPost, BASE_URL } from './http'
import { log, success, error } from './logger'

export interface AuthResult {
  token: string
  email: string
  userId: string
}

function getDeviceName(): string {
  const hostname = os.hostname().replace('.local', '')
  const user = os.userInfo().username
  return `${user} 的 ${hostname}`
}

function getDeviceInfo() {
  return {
    name: getDeviceName(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    osVersion: os.release(),
  }
}

export async function deviceAuth(): Promise<AuthResult> {
  const deviceCode = crypto.randomBytes(16).toString('hex')
  const device = getDeviceInfo()
  const authUrl = `${BASE_URL}/auth/device?code=${deviceCode}`

  log(`打开浏览器登录中...`)
  console.log(`  如果没有自动打开，请访问：`)
  console.log(`  ${authUrl}\n`)

  // 通知服务端有终端等待授权
  await httpPost('/api/terminal/auth/start', {
    code: deviceCode,
    device,
  }).catch(() => {}) // 非关键，服务端可能还没这个 API

  // 打开浏览器
  try {
    const open = (await import('open')).default
    await open(authUrl)
  } catch {
    const { exec } = await import('child_process')
    exec(`open "${authUrl}"`)
  }

  // 轮询等待授权
  log('等待授权...')
  const maxAttempts = 150 // 5 分钟
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000)

    try {
      const { status, body } = await httpGet(`/api/auth/device/poll?code=${deviceCode}`)

      if (status === 200) {
        const data = JSON.parse(body)
        if (data.token) {
          success(`已登录 (${data.email || 'user'})`)
          return {
            token: data.token,
            email: data.email || '',
            userId: data.userId || '',
          }
        }
      }

      if (status === 410) {
        error('授权已过期，请重新运行')
        process.exit(1)
      }
    } catch {
      // 网络错误，继续轮询
    }
  }

  error('授权超时，请重新运行')
  process.exit(1)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
