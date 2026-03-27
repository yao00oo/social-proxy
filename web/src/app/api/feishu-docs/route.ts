// API: POST /api/feishu-docs — 触发飞书文档同步
// GET  /api/feishu-docs — 查询同步状态

export const maxDuration = 60

import { NextResponse } from 'next/server'
import { getUserId, unauthorized } from '@/lib/auth-helper'
import { getSetting } from '@/lib/feishu'
import { query, queryOne, exec } from '@/lib/db'
import https from 'https'

// ── Feishu API helpers ──
const BASE = 'https://open.feishu.cn/open-apis'

function request(url: string, options: https.RequestOptions, body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)) }
      })
    })
    req.setTimeout(15000, () => { req.destroy(new Error('request timeout')) })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function feishuPost(path: string, body: object, headers: Record<string, string> = {}): Promise<any> {
  const bodyStr = JSON.stringify(body)
  return request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
      ...headers,
    },
  }, bodyStr)
}

function feishuGet(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`
  return request(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// ── Token management ──
async function ensureValidToken(userId: string): Promise<string> {
  const token = await getSetting('feishu_user_access_token', userId)
  const tokenTime = parseInt(await getSetting('feishu_token_time', userId) || '0', 10)
  const refreshTk = await getSetting('feishu_refresh_token', userId)
  const appId = process.env.FEISHU_APP_ID || await getSetting('feishu_app_id', userId)
  const appSecret = process.env.FEISHU_APP_SECRET || await getSetting('feishu_app_secret', userId)

  if (!token) throw new Error('未授权，请先在配置页面完成飞书 OAuth 授权')

  // user_access_token 有效期 2 小时，提前 5 分钟刷新
  const age = Date.now() - tokenTime
  if (age > (2 * 60 - 5) * 60 * 1000 && refreshTk) {
    if (!appId || !appSecret) throw new Error('未配置飞书 App ID / App Secret，请先在设置页面填写')
    const appRes = await feishuPost('/auth/v3/app_access_token/internal', { app_id: appId, app_secret: appSecret })
    if (appRes.code !== 0) throw new Error(`getAppAccessToken: ${appRes.msg}`)
    const appToken = appRes.app_access_token

    const refreshRes = await feishuPost(
      '/authen/v1/oidc/refresh_access_token',
      { grant_type: 'refresh_token', refresh_token: refreshTk },
      { Authorization: `Bearer ${appToken}` },
    )
    if (refreshRes.code !== 0) throw new Error(`refreshToken: ${refreshRes.msg}`)

    const newToken = refreshRes.data.access_token
    const newRefresh = refreshRes.data.refresh_token

    const upsertSql = `INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`
    await exec(upsertSql, [userId, 'feishu_user_access_token', newToken])
    await exec(upsertSql, [userId, 'feishu_refresh_token', newRefresh])
    await exec(upsertSql, [userId, 'feishu_token_time', Date.now().toString()])

    return newToken
  }

  return token
}

// ── File listing ──
interface FeishuFile {
  token: string
  name: string
  type: string
  created_time: number
  modified_time: number
  owner_id: string
  url: string
}

async function listFiles(token: string, folderToken: string): Promise<FeishuFile[]> {
  const allFiles: FeishuFile[] = []
  let pageToken = ''

  while (true) {
    const params: Record<string, string> = {
      page_size: '200',
      order_by: 'EditedTime',
      direction: 'DESC',
    }
    if (folderToken) params.folder_token = folderToken
    if (pageToken) params.page_token = pageToken

    const res = await feishuGet('/drive/v1/files', token, params)
    if (res.code !== 0) throw new Error(`listFiles failed: ${res.msg} (code=${res.code})`)

    const files = res.data?.files || []
    for (const f of files) {
      allFiles.push({
        token: f.token,
        name: f.name,
        type: f.type,
        created_time: f.created_time ? Number(f.created_time) : 0,
        modified_time: f.modified_time ? Number(f.modified_time) : 0,
        owner_id: f.owner_id || '',
        url: f.url || '',
      })
    }

    if (!res.data?.has_more) break
    pageToken = res.data.page_token
  }

  return allFiles
}

async function listFilesRecursive(
  token: string,
  folderToken: string,
  depth: number,
  maxDepth: number,
  allFiles: FeishuFile[],
): Promise<void> {
  // Rate limit between API calls
  await new Promise(r => setTimeout(r, 300))

  const files = await listFiles(token, folderToken)
  for (const file of files) {
    allFiles.push(file)
    if (file.type === 'folder' && depth < maxDepth) {
      await listFilesRecursive(token, file.token, depth + 1, maxDepth, allFiles)
    }
  }
}

// ── Content fetching ──
async function fetchDocContent(token: string, docToken: string): Promise<string> {
  await new Promise(r => setTimeout(r, 300))
  const res = await feishuGet(`/docx/v1/documents/${docToken}/raw_content`, token)
  if (res.code !== 0) throw new Error(`fetchDocContent(${docToken}) failed: ${res.msg} (code=${res.code})`)
  return res.data?.content || ''
}

// ── Sync status persistence ──
const SYNC_STATUS_KEY = 'feishu_docs_sync_status'

async function persistStatus(userId: string, status: object): Promise<void> {
  try {
    await exec(
      `INSERT INTO settings(user_id, key, value) VALUES(?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      [userId, SYNC_STATUS_KEY, JSON.stringify(status)]
    )
  } catch {}
}

// ── Full doc sync ──
async function syncDocs(userId: string) {
  let syncLog: string[] = []
  let lastResult: any = null

  const log = async (msg: string) => {
    console.log(`[feishu-docs] ${msg}`)
    syncLog.push(msg)
    if (syncLog.length > 200) syncLog = syncLog.slice(-100)
    await persistStatus(userId, { status: 'syncing', running: true, log: syncLog.slice(-50), lastResult })
  }

  const result = { total: 0, docx: 0, synced: 0, skipped: 0, errors: [] as string[] }

  try {
    const userToken = await ensureValidToken(userId)

    // 1. Recursively list all files (max depth 5)
    await log('扫描文件列表...')
    const allFiles: FeishuFile[] = []
    await listFilesRecursive(userToken, '', 0, 5, allFiles)
    result.total = allFiles.length
    await log(`共发现 ${allFiles.length} 个文件`)

    // 2. Filter docx files
    const docxFiles = allFiles.filter(f => f.type === 'docx')
    result.docx = docxFiles.length
    await log(`其中 ${docxFiles.length} 个文档 (docx)`)

    // 3. Fetch content and upsert
    for (let i = 0; i < docxFiles.length; i++) {
      const file = docxFiles[i]
      const pct = Math.round(((i + 1) / docxFiles.length) * 100)
      await log(`[${pct}%] 同步 ${i + 1}/${docxFiles.length}: ${file.name}`)

      try {
        const content = await fetchDocContent(userToken, file.token)

        // Generate a simple summary (first 200 chars)
        const summary = content.replace(/\s+/g, ' ').trim().slice(0, 200)

        await exec(
          `INSERT INTO feishu_docs (user_id, doc_id, title, doc_type, url, created_time, modified_time, content, summary, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
           ON CONFLICT (user_id, doc_id) DO UPDATE SET
             title = EXCLUDED.title,
             doc_type = EXCLUDED.doc_type,
             url = EXCLUDED.url,
             created_time = EXCLUDED.created_time,
             modified_time = EXCLUDED.modified_time,
             content = EXCLUDED.content,
             summary = EXCLUDED.summary,
             synced_at = NOW()`,
          [
            userId,
            file.token,
            file.name,
            file.type,
            file.url,
            file.created_time ? new Date(file.created_time * 1000).toISOString() : null,
            file.modified_time ? new Date(file.modified_time * 1000).toISOString() : null,
            content,
            summary,
          ],
        )
        result.synced++
      } catch (err: any) {
        const errMsg = `${file.name}: ${err.message}`
        result.errors.push(errMsg)
        await log(`  错误: ${errMsg}`)
        result.skipped++
      }

      lastResult = { ...result }
    }

    // Also upsert non-docx files (metadata only, no content)
    const nonDocxFiles = allFiles.filter(f => f.type !== 'docx' && f.type !== 'folder')
    for (const file of nonDocxFiles) {
      try {
        await exec(
          `INSERT INTO feishu_docs (user_id, doc_id, title, doc_type, url, created_time, modified_time, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
           ON CONFLICT (user_id, doc_id) DO UPDATE SET
             title = EXCLUDED.title,
             doc_type = EXCLUDED.doc_type,
             url = EXCLUDED.url,
             created_time = EXCLUDED.created_time,
             modified_time = EXCLUDED.modified_time,
             synced_at = NOW()`,
          [
            userId,
            file.token,
            file.name,
            file.type,
            file.url,
            file.created_time ? new Date(file.created_time * 1000).toISOString() : null,
            file.modified_time ? new Date(file.modified_time * 1000).toISOString() : null,
          ],
        )
      } catch {}
    }

    await log(`同步完成: ${result.synced} 个文档已同步，${result.errors.length} 个错误`)
  } catch (err: any) {
    await log(`同步失败: ${err.message}`)
    result.errors.push(err.message)
  }

  lastResult = result

  let finalStatus = 'completed'
  if (result.errors.length > 0 && result.synced === 0) finalStatus = 'error'
  else if (result.errors.length > 0) finalStatus = 'completed_with_errors'

  await persistStatus(userId, {
    status: finalStatus,
    running: false,
    log: syncLog.slice(-50),
    lastResult,
    updatedAt: Date.now(),
  })

  return { result, log: syncLog }
}

// ── Route handlers ──

export async function GET() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  const statusRow = await queryOne<{ value: string }>(
    `SELECT value FROM settings WHERE key = ? AND user_id = ?`,
    [SYNC_STATUS_KEY, userId],
  )
  const dbStatus = statusRow?.value ? JSON.parse(statusRow.value) : null

  return NextResponse.json({
    running: dbStatus?.running || false,
    log: dbStatus?.log || [],
    lastResult: dbStatus?.lastResult || null,
  })
}

export async function POST() {
  const userId = await getUserId()
  if (!userId) return unauthorized()

  // Check if already running
  const statusRow = await queryOne<{ value: string }>(
    `SELECT value FROM settings WHERE key = ? AND user_id = ?`,
    [SYNC_STATUS_KEY, userId],
  )
  const dbStatus = statusRow?.value ? JSON.parse(statusRow.value) : null
  if (dbStatus?.running) {
    return NextResponse.json({ ok: false, message: '文档同步正在进行中' }, { status: 409 })
  }

  // Mark as running immediately
  await persistStatus(userId, { status: 'syncing', running: true, log: ['开始文档同步...'], lastResult: null })

  try {
    const { result } = await syncDocs(userId)
    return NextResponse.json({ ok: true, message: '文档同步完成', result })
  } catch (err: any) {
    await persistStatus(userId, {
      status: 'error',
      running: false,
      log: [`同步异常: ${err.message}`],
      lastResult: null,
      updatedAt: Date.now(),
    })
    return NextResponse.json({ ok: false, message: err.message }, { status: 500 })
  }
}
