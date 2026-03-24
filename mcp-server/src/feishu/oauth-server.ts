// 本地 OAuth 回调服务器
// 飞书授权完成后，浏览器重定向到 http://localhost:PORT/callback?code=xxx
// 这个脚本捕获 code，换取 token，存入数据库

import http from 'http'
import { execSync } from 'child_process'
import { getDb } from '../db'
import { getAppAccessToken, buildOAuthUrl, exchangeCode } from './api'

const PORT = 19721
const REDIRECT_URI = `http://localhost:${PORT}/callback`

function saveSetting(key: string, value: string) {
  getDb().prepare(`
    INSERT INTO settings(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

function getSetting(key: string): string {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as any
  return row?.value || ''
}

export async function startOAuth(): Promise<void> {
  const appId = getSetting('feishu_app_id')
  const appSecret = getSetting('feishu_app_secret')

  if (!appId || !appSecret) {
    throw new Error('请先在配置页面填写飞书 App ID 和 App Secret')
  }

  const state = Math.random().toString(36).slice(2)

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, `http://localhost:${PORT}`)

      if (url.pathname !== '/callback') {
        res.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')

      if (returnedState !== state) {
        res.end('<p>state 不匹配，请重试</p>')
        reject(new Error('OAuth state mismatch'))
        server.close()
        return
      }

      if (!code) {
        res.end('<p>未获取到 code</p>')
        reject(new Error('No code in callback'))
        server.close()
        return
      }

      try {
        const appToken = await getAppAccessToken(appId, appSecret)
        const user = await exchangeCode(code, appToken)

        // 保存 token 和用户信息
        saveSetting('feishu_user_access_token', user.access_token)
        saveSetting('feishu_refresh_token', user.refresh_token)
        saveSetting('feishu_user_name', user.name)
        saveSetting('feishu_user_id', user.user_id)
        // token 有效期 2 小时，记录获取时间
        saveSetting('feishu_token_time', Date.now().toString())

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`
          <html><body style="font-family:sans-serif;padding:40px;background:#0a0a0a;color:white">
            <h2>✅ 授权成功</h2>
            <p>已登录为：<strong>${user.name}</strong></p>
            <p>可以关闭此页面，回到配置页面开始同步。</p>
          </body></html>
        `)

        server.close()
        resolve()
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<p>授权失败: ${err}</p>`)
        reject(err)
        server.close()
      }
    })

    server.listen(PORT, () => {
      const authUrl = buildOAuthUrl(appId, REDIRECT_URI, state)
      console.log(`\n🔑 请在浏览器中完成授权:\n${authUrl}\n`)

      // 自动打开浏览器（macOS）
      try { execSync(`open "${authUrl}"`) } catch {}
    })

    server.on('error', (err) => {
      reject(new Error(`OAuth 服务器启动失败: ${err.message}`))
    })

    // 超时 5 分钟
    setTimeout(() => {
      server.close()
      reject(new Error('OAuth 授权超时（5分钟）'))
    }, 5 * 60 * 1000)
  })
}
