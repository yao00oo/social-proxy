// 飞书 OAuth 本地轮询器
// 飞书回调由 https://relay.botook.ai/feishu/callback 接收
// 本脚本轮询 relay 拿到 code，本地完成 code→token 交换，写入 DB

const https = require('https')
const path = require('path')
const Database = require('better-sqlite3')

const RELAY_URL = 'https://relay.botook.ai'
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../social-proxy.db')

function getDb() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  return db
}

function getSetting(db, key) {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key))?.value || ''
}

function saveSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve(JSON.parse(data)))
    }).on('error', reject)
  })
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body)
    const u = new URL(url)
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve(JSON.parse(data)))
    })
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

// 轮询 relay，等待 code 就绪
async function waitForCode(state, maxRetries = 36) {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, 5000))
    try {
      const res = await httpsGet(`${RELAY_URL}/feishu/code?state=${state}`)
      if (res.code) return res.code
      if (res.error === 'Code expired') throw new Error('授权 code 已过期，请重新授权')
    } catch (err) {
      if (err.message.includes('过期')) throw err
      // 网络错误继续重试
    }
  }
  throw new Error('等待授权超时（3分钟），请重试')
}

// 主流程：收到前端触发信号后启动轮询
async function handleAuth(state) {
  const db = getDb()
  const appId = getSetting(db, 'feishu_app_id')
  const appSecret = getSetting(db, 'feishu_app_secret')

  console.log(`[feishu] 等待授权回调 (state: ${state.slice(0, 8)}...)`)
  const code = await waitForCode(state)
  console.log('[feishu] 获取到 code，换取 token...')

  // 1. app_access_token
  const appTokenRes = await httpsPost(
    'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
    { app_id: appId, app_secret: appSecret }
  )
  if (appTokenRes.code !== 0) throw new Error(`获取 app token 失败: ${appTokenRes.msg}`)

  // 2. user_access_token
  const userTokenRes = await httpsPost(
    'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token',
    { grant_type: 'authorization_code', code },
    { Authorization: `Bearer ${appTokenRes.app_access_token}` }
  )
  if (userTokenRes.code !== 0) throw new Error(`换取 user token 失败: ${userTokenRes.msg}`)

  const d = userTokenRes.data
  saveSetting(db, 'feishu_user_access_token', d.access_token)
  saveSetting(db, 'feishu_refresh_token', d.refresh_token)
  saveSetting(db, 'feishu_user_name', d.name)
  saveSetting(db, 'feishu_user_id', d.user_id)
  saveSetting(db, 'feishu_token_time', Date.now().toString())
  saveSetting(db, 'feishu_auth_done', '1')

  console.log(`[feishu] ✅ 授权成功: ${d.name}`)
}

// 暴露给 API route 调用
module.exports = { handleAuth }
