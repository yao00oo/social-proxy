// 飞书 Open API 封装
// 文档: https://open.feishu.cn/document/server-docs/im-v1/message/list

import https from 'https'
import http from 'http'

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

function post(path: string, body: object, headers: Record<string, string> = {}): Promise<any> {
  const bodyStr = JSON.stringify(body)
  return request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(bodyStr),
      ...headers,
    },
  }, bodyStr)
}

function get(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`
  return request(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
}

// ── 获取 App Access Token ─────────────────────────────
export async function getAppAccessToken(appId: string, appSecret: string): Promise<string> {
  const res = await post('/auth/v3/app_access_token/internal', { app_id: appId, app_secret: appSecret })
  if (res.code !== 0) throw new Error(`getAppAccessToken failed: ${res.msg}`)
  return res.app_access_token
}

// ── 构造 OAuth 授权 URL ───────────────────────────────
export function buildOAuthUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    app_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  })
  return `https://open.feishu.cn/open-apis/authen/v1/index?${params}`
}

// ── 用 code 换 user_access_token ─────────────────────
export async function exchangeCode(
  code: string,
  appAccessToken: string
): Promise<{ access_token: string; refresh_token: string; name: string; user_id: string }> {
  const res = await post(
    '/authen/v1/oidc/access_token',
    { grant_type: 'authorization_code', code },
    { Authorization: `Bearer ${appAccessToken}` }
  )
  if (res.code !== 0) throw new Error(`exchangeCode failed: ${res.msg}`)
  const d = res.data
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    name: d.name,
    user_id: d.user_id,
  }
}

// ── 刷新 token ────────────────────────────────────────
export async function refreshToken(
  refresh: string,
  appAccessToken: string
): Promise<{ access_token: string; refresh_token: string }> {
  const res = await post(
    '/authen/v1/oidc/refresh_access_token',
    { grant_type: 'refresh_token', refresh_token: refresh },
    { Authorization: `Bearer ${appAccessToken}` }
  )
  if (res.code !== 0) throw new Error(`refreshToken failed: ${res.msg}`)
  return { access_token: res.data.access_token, refresh_token: res.data.refresh_token }
}

// ── 获取用户加入的会话列表 ────────────────────────────
export async function listChats(userToken: string): Promise<Array<{ chat_id: string; name: string; chat_type: string }>> {
  const chats: any[] = []
  let pageToken = ''

  while (true) {
    const params: Record<string, string> = { page_size: '100' }
    if (pageToken) params.page_token = pageToken

    const res = await get('/im/v1/chats', userToken, params)
    if (res.code !== 0) throw new Error(`listChats failed: ${res.msg}`)

    chats.push(...(res.data.items || []))
    if (!res.data.has_more) break
    pageToken = res.data.page_token
  }

  return chats.map(c => ({
    chat_id: c.chat_id,
    name: c.name || c.chat_id,
    chat_type: c.chat_type || '',
  }))
}

export interface FeishuMessage {
  message_id: string
  sender_id: string
  sender_name: string
  chat_id: string
  create_time: string  // Unix ms
  msg_type: string
  content: string      // 已解析的纯文本
  parent_id?: string   // 回复的消息 ID
  image_key?: string   // 图片/表情的资源 key
}

// ── 拉取某会话的消息列表（分页） ──────────────────────
export async function listMessages(
  userToken: string,
  chatId: string,
  startTime?: string,  // Unix 秒，不传则从最早开始
): Promise<FeishuMessage[]> {
  const messages: FeishuMessage[] = []
  let pageToken = ''
  let pages = 0
  const MAX_PAGES = 200

  while (pages++ < MAX_PAGES) {
    const params: Record<string, string> = {
      container_id: chatId,
      container_id_type: 'chat',
      sort_type: 'ByCreateTimeAsc',
      page_size: '50',
    }
    if (startTime) params.start_time = startTime
    if (pageToken) params.page_token = pageToken

    const res = await get('/im/v1/messages', userToken, params)
    if (res.code !== 0) {
      // 没权限的群跳过
      if (res.code === 230002 || res.code === 102004) break
      throw new Error(`listMessages(${chatId}) failed: ${res.msg} (code=${res.code})`)
    }

    for (const item of res.data?.items || []) {
      const parsed = parseContent(item.msg_type, item.body?.content)
      messages.push({
        message_id: item.message_id,
        sender_id: item.sender?.id || '',
        sender_name: item.sender?.name || item.sender?.id || '未知',
        chat_id: chatId,
        create_time: item.create_time,
        msg_type: item.msg_type,
        content: parsed.text,
        parent_id: item.parent_id || undefined,
        image_key: parsed.imageKey,
      })
    }

    if (!res.data?.has_more) break
    pageToken = res.data.page_token
  }

  return messages
}

// ── 发送文本消息 ──────────────────────────────────────
export async function sendMessage(
  userToken: string,
  receiveId: string,
  text: string,
  receiveIdType: 'open_id' | 'chat_id' = 'chat_id',
): Promise<{ message_id: string }> {
  const res = await post(
    `/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
    { Authorization: `Bearer ${userToken}` },
  )
  if (res.code !== 0) throw new Error(`sendMessage failed: ${res.msg} (code=${res.code})`)
  return { message_id: res.data.message_id }
}

// ── 获取用户详细信息（手机、邮箱等） ─────────────────
export async function getUserInfo(
  appAccessToken: string,
  openId: string,
): Promise<{ name: string; email: string; mobile: string }> {
  const res = await get(
    `/contact/v3/users/${openId}`,
    appAccessToken,
    { user_id_type: 'open_id' },
  )
  if (res.code !== 0) throw new Error(`getUserInfo failed: ${res.msg} (code=${res.code})`)
  const u = res.data?.user || {}
  return {
    name: u.name || '',
    email: u.enterprise_email || u.email || '',
    mobile: u.mobile || '',
  }
}

// ── 下载消息中的图片/表情资源 ────────────────────────
export function downloadImage(
  userToken: string,
  messageId: string,
  imageKey: string,
): Promise<Buffer> {
  const url = `${BASE}/im/v1/messages/${messageId}/resources/${imageKey}?type=image`
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${userToken}` },
    }, (res) => {
      if (res.headers['content-type']?.includes('json')) {
        let d = ''
        res.on('data', c => d += c)
        res.on('end', () => reject(new Error(`download failed: ${d.slice(0, 200)}`)))
      } else {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      }
    })
    req.setTimeout(15000, () => { req.destroy(new Error('download timeout')) })
    req.on('error', reject)
    req.end()
  })
}

// ── 解析消息内容为纯文本 ──────────────────────────────
function parseContent(msgType: string, rawContent: string | undefined): { text: string; imageKey?: string } {
  if (!rawContent) return { text: '[空消息]' }

  try {
    const body = JSON.parse(rawContent)

    switch (msgType) {
      case 'text':
        return { text: body.text || '[空文本]' }

      case 'post': {
        // 富文本：遍历所有 block 提取文本
        const lines: string[] = []
        const content = body.content || body.zh_cn?.content || []
        for (const line of content) {
          const parts = Array.isArray(line) ? line : [line]
          const text = parts
            .map((p: any) => {
              if (p.tag === 'text') return p.text
              if (p.tag === 'a') return `${p.text}(${p.href})`
              if (p.tag === 'at') return `@${p.user_name || p.user_id}`
              return ''
            })
            .join('')
          if (text) lines.push(text)
        }
        return { text: lines.join('\n') || '[富文本]' }
      }

      case 'image':
        return { text: '[图片]', imageKey: body.image_key }

      case 'file':
        return { text: `[文件: ${body.file_name || ''}]` }

      case 'audio':
        return { text: '[语音]' }

      case 'video':
        return { text: '[视频]' }

      case 'sticker':
        return { text: '[表情包]', imageKey: body.file_key }

      case 'interactive':
        return { text: '[卡片消息]' }

      default:
        return { text: `[${msgType}]` }
    }
  } catch {
    return { text: rawContent.slice(0, 200) }
  }
}
