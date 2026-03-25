// 飞书云文档同步
// 同步两种来源：1) 我的云空间（递归遍历） 2) 搜索API（含他人分享/协作文档）
import { getDb } from '../db'

const BASE = 'https://open.feishu.cn/open-apis'

async function get(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  return res.json()
}

async function post(path: string, token: string, body: object): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

interface DocInfo {
  doc_id: string
  title: string
  doc_type: string
  url: string
  modified_time: string
  created_time: string
}

// 飞书 docs_type 数字 → 字符串映射
const DOC_TYPE_MAP: Record<number, string> = {
  1: 'doc', 2: 'sheet', 3: 'slides', 7: 'mindnote', 8: 'bitable',
  9: 'file', 11: 'wiki', 12: 'docx', 15: 'slides', 16: 'wiki',
}

// 1) 列出我的云文档（递归遍历文件夹）
export async function listMyDocs(userToken: string, onProgress?: (msg: string) => void): Promise<DocInfo[]> {
  const docs: DocInfo[] = []

  async function fetchFolder(folderToken: string, depth = 0) {
    if (depth > 5) return // 防止过深递归
    let pageToken = ''
    while (true) {
      const params: Record<string, string> = { page_size: '200' }
      if (folderToken) params.folder_token = folderToken
      if (pageToken) params.page_token = pageToken

      const res = await get('/drive/v1/files', userToken, params)
      if (res.code !== 0) {
        onProgress?.(`  ⚠ 文件夹访问失败: ${res.msg}`)
        break
      }

      for (const item of res.data?.files || []) {
        if (item.type === 'folder') {
          await fetchFolder(item.token, depth + 1)
        } else if (['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'slides'].includes(item.type)) {
          docs.push({
            doc_id: item.token,
            title: item.name || '无标题',
            doc_type: item.type,
            url: item.url || `https://bytedance.feishu.cn/${item.type}/${item.token}`,
            modified_time: item.modified_time ? new Date(parseInt(item.modified_time) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
            created_time: item.created_time ? new Date(parseInt(item.created_time) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
          })
        }
      }

      if (!res.data?.has_more) break
      pageToken = res.data.next_page_token
    }
  }

  await fetchFolder('')
  return docs
}

// 2) 搜索API获取协作/访问过的文档（包含他人分享的）
export async function listSharedDocs(userToken: string): Promise<DocInfo[]> {
  const docs: DocInfo[] = []
  let offset = 0

  while (true) {
    const res = await post('/suite/docs-api/search/object', userToken, {
      search_key: '',
      count: 50,
      offset,
      docs_types: [1, 2, 3, 7, 8, 9, 11, 12, 15, 16],
      owner_ids: [],
    })
    if (res.code !== 0) break

    for (const item of res.data?.docs_entities || []) {
      const docType = typeof item.docs_type === 'number'
        ? (DOC_TYPE_MAP[item.docs_type] || 'unknown')
        : item.docs_type || 'unknown'
      docs.push({
        doc_id: item.docs_token,
        title: item.title || '无标题',
        doc_type: docType,
        url: item.url || '',
        modified_time: '', // 搜索 API 不返回时间
        created_time: '',
      })
    }

    if (!res.data?.has_more) break
    offset += 50
  }

  return docs
}

// 3) 遍历所有 wiki 知识库空间的节点
export async function listWikiDocs(userToken: string, onProgress?: (msg: string) => void): Promise<DocInfo[]> {
  const docs: DocInfo[] = []

  // 先获取所有 space
  const spaces: string[] = []
  let pageToken = ''
  while (true) {
    const params: Record<string, string> = { page_size: '50' }
    if (pageToken) params.page_token = pageToken
    const res = await get('/wiki/v2/spaces', userToken, params)
    if (res.code !== 0) break
    for (const s of res.data?.items || []) spaces.push(s.space_id)
    if (!res.data?.has_more) break
    pageToken = res.data.page_token
  }

  // 递归遍历每个 space 的节点树
  async function fetchNodes(spaceId: string, parentToken?: string) {
    let pt = ''
    while (true) {
      const params: Record<string, string> = { page_size: '50' }
      if (parentToken) params.parent_node_token = parentToken
      if (pt) params.page_token = pt
      const res = await get(`/wiki/v2/spaces/${spaceId}/nodes`, userToken, params)
      if (res.code !== 0) break
      for (const n of res.data?.items || []) {
        if (n.obj_token && n.title) {
          docs.push({
            doc_id: n.obj_token,
            title: n.title,
            doc_type: n.obj_type || 'wiki',
            url: `https://wh9a7emh1y.feishu.cn/wiki/${n.node_token}`,
            modified_time: n.obj_edit_time ? new Date(parseInt(n.obj_edit_time) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
            created_time: n.obj_create_time ? new Date(parseInt(n.obj_create_time) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
          })
        }
        // 递归子节点
        if (n.has_child && n.node_token) {
          await fetchNodes(spaceId, n.node_token)
        }
      }
      if (!res.data?.has_more) break
      pt = res.data.page_token
    }
  }

  for (const spaceId of spaces) {
    onProgress?.(`  遍历知识库 ${spaceId}...`)
    await fetchNodes(spaceId)
  }

  return docs
}

// 获取文档纯文本内容（支持 docx 和 sheet）
export async function getDocContent(userToken: string, docId: string, docType?: string): Promise<string> {
  if (docType === 'sheet') return getSheetContent(userToken, docId)
  // 默认尝试 docx
  const res = await get(`/docx/v1/documents/${docId}/raw_content`, userToken)
  if (res.code !== 0) return ''
  return res.data?.content || ''
}

// 读取 sheet 所有工作表的内容，转为文本
async function getSheetContent(userToken: string, sheetToken: string): Promise<string> {
  // 获取 sheet 列表
  const metaRes = await get(`/sheets/v3/spreadsheets/${sheetToken}/sheets/query`, userToken)
  if (metaRes.code !== 0) return ''
  const sheets = metaRes.data?.sheets || []
  if (sheets.length === 0) return ''

  const parts: string[] = []
  for (const s of sheets.slice(0, 5)) { // 最多读 5 个工作表
    const rows = s.grid_properties?.row_count || 100
    const cols = s.grid_properties?.column_count || 26
    const maxRows = Math.min(rows, 200) // 最多 200 行
    const maxCol = String.fromCharCode(64 + Math.min(cols, 26)) // 最多 Z 列
    const range = `${s.sheet_id}!A1:${maxCol}${maxRows}`

    const dataRes = await get(
      `/sheets/v2/spreadsheets/${sheetToken}/values/${range}`,
      userToken,
      { valueRenderOption: 'FormattedValue' }
    )
    if (dataRes.code !== 0) continue
    const values = dataRes.data?.valueRange?.values || []
    if (values.length === 0) continue

    const text = values
      .filter((row: any[]) => row && row.some((c: any) => c != null && c !== ''))
      .map((row: any[]) => row.map((c: any) => String(c ?? '')).join('\t'))
      .join('\n')
    if (text) parts.push(`【${s.title}】\n${text}`)
  }

  return parts.join('\n\n')
}

// 根据飞书 URL 手动同步单个文档
export async function syncDocByUrl(url: string): Promise<{ ok: boolean; title?: string; doc_type?: string; error?: string }> {
  const db = getDb()
  const token = (db.prepare(`SELECT value FROM settings WHERE key='feishu_user_access_token'`).get() as any)?.value
  if (!token) return { ok: false, error: '未授权' }

  // 从 URL 提取 token
  const m = url.match(/feishu\.cn\/(?:wiki|docx|doc|sheets?|bitable|base|mindnote|slides|drive\/folder)\/([A-Za-z0-9]+)/)
  if (!m) return { ok: false, error: '无法识别飞书文档URL' }
  const docToken = m[1]
  const isWiki = url.includes('/wiki/')

  let info: DocInfo | null = null

  if (isWiki) {
    // wiki 文档需要先 get_node 拿 obj_token
    info = await getWikiNode(token, docToken)
    if (!info) return { ok: false, error: '无法访问该 wiki 文档' }
  } else {
    // 普通云文档直接用 token
    info = {
      doc_id: docToken,
      title: '',
      doc_type: url.includes('/docx/') ? 'docx' : url.includes('/sheet/') ? 'sheet' : 'unknown',
      url,
      modified_time: '',
      created_time: '',
    }
  }

  let content = ''
  if (info.doc_type === 'docx') {
    try { content = await getDocContent(token, info.doc_id) } catch {}
  }

  db.prepare(`
    INSERT INTO feishu_docs(doc_id, title, doc_type, url, created_time, modified_time, content, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(doc_id) DO UPDATE SET
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE feishu_docs.title END,
      content = CASE WHEN excluded.content != '' THEN excluded.content ELSE feishu_docs.content END,
      synced_at = excluded.synced_at
  `).run(info.doc_id, info.title, info.doc_type, info.url || url, info.created_time, info.modified_time, content)

  return { ok: true, title: info.title, doc_type: info.doc_type }
}

export async function syncDocs(onProgress?: (msg: string) => void): Promise<{ total: number; synced: number; errors: string[] }> {
  const db = getDb()
  const log = (msg: string) => { console.log(msg); onProgress?.(msg) }

  const token = (db.prepare(`SELECT value FROM settings WHERE key='feishu_user_access_token'`).get() as any)?.value
  if (!token) throw new Error('未授权，请先完成飞书 OAuth 授权')

  // 1) 我的云空间
  log('📂 获取我的文档列表...')
  const myDocs = await listMyDocs(token, onProgress)
  log(`  我的文档: ${myDocs.length} 个`)

  // 2) 搜索协作/访问过的文档
  log('🔍 搜索协作文档...')
  const sharedDocs = await listSharedDocs(token)
  log(`  协作文档: ${sharedDocs.length} 个`)

  // 2.5) 遍历 wiki 知识库
  log('📚 遍历知识库...')
  const wikiDocs = await listWikiDocs(token, onProgress)
  log(`  知识库文档: ${wikiDocs.length} 个`)

  // 合并去重（以 doc_id 为准，我的文档优先保留完整信息）
  const docMap = new Map<string, DocInfo>()
  for (const doc of myDocs) docMap.set(doc.doc_id, doc)
  for (const doc of sharedDocs) {
    if (!docMap.has(doc.doc_id)) docMap.set(doc.doc_id, doc)
  }
  for (const doc of wikiDocs) {
    if (!docMap.has(doc.doc_id)) docMap.set(doc.doc_id, doc)
  }

  // 3) 从全部历史消息中提取 wiki 链接
  log('🔗 扫描消息中的文档链接...')
  const msgTokens = extractDocTokensFromMessages(db, 0)
  let wikiAdded = 0
  for (const t of msgTokens) {
    if (docMap.has(t)) continue
    try {
      const info = await getWikiNode(token, t)
      if (info) {
        docMap.set(info.doc_id, info)
        if (info.doc_id !== t) docMap.set(t, { ...info, doc_id: t })
        wikiAdded++
      }
    } catch {}
  }
  log(`  消息中发现 ${msgTokens.length} 个链接，新增 ${wikiAdded} 个 wiki 文档`)

  const allDocs = Array.from(docMap.values())
  log(`📄 合并去重后: ${allDocs.length} 个文档`)

  const upsert = db.prepare(`
    INSERT INTO feishu_docs(doc_id, title, doc_type, url, created_time, modified_time, content, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(doc_id) DO UPDATE SET
      title = excluded.title,
      modified_time = CASE WHEN excluded.modified_time != '' THEN excluded.modified_time ELSE feishu_docs.modified_time END,
      content = CASE
        WHEN excluded.content != '' AND (excluded.modified_time > feishu_docs.modified_time OR feishu_docs.content IS NULL OR feishu_docs.content = '')
        THEN excluded.content ELSE feishu_docs.content END,
      synced_at = excluded.synced_at
  `)

  const errors: string[] = []
  let synced = 0

  for (let i = 0; i < allDocs.length; i++) {
    const doc = allDocs[i]
    try {
      let content = ''
      if (doc.doc_type === 'docx') {
        content = await getDocContent(token, doc.doc_id)
      }
      upsert.run(doc.doc_id, doc.title, doc.doc_type, doc.url, doc.created_time, doc.modified_time, content)
      if ((i + 1) % 20 === 0 || i === allDocs.length - 1) {
        log(`  进度: ${i + 1}/${allDocs.length}`)
      }
      synced++
    } catch (e: any) {
      const msg = `${doc.title}: ${e.message}`
      errors.push(msg)
      log(`  ⚠ ${msg}`)
    }
  }

  log(`\n✅ 文档同步完成: ${synced} 个，${errors.length} 个错误`)
  return { total: allDocs.length, synced, errors }
}

// 获取 wiki 节点信息（node_token → obj_token + 元信息）
async function getWikiNode(userToken: string, nodeToken: string): Promise<DocInfo | null> {
  const res = await get('/wiki/v2/spaces/get_node', userToken, { token: nodeToken })
  if (res.code !== 0) return null
  const n = res.data?.node
  if (!n) return null
  return {
    doc_id: n.obj_token || nodeToken,
    title: n.title || '无标题',
    doc_type: n.obj_type || 'wiki',
    url: `https://wh9a7emh1y.feishu.cn/wiki/${nodeToken}`,
    modified_time: n.obj_edit_time ? new Date(parseInt(n.obj_edit_time) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
    created_time: n.obj_create_time ? new Date(parseInt(n.obj_create_time) * 1000).toISOString().slice(0, 19).replace('T', ' ') : '',
  }
}

// 从消息中提取 wiki/docx 链接的 token
// minutes=0 表示扫描全部历史消息（用于 syncDocs 全量）
function extractDocTokensFromMessages(db: ReturnType<typeof getDb>, minutes = 0): string[] {
  const where = minutes > 0
    ? `AND timestamp > datetime('now', '-${minutes} minutes')`
    : ''
  const rows = db.prepare(`
    SELECT DISTINCT content FROM messages
    WHERE content LIKE '%feishu.cn/%' ${where}
  `).all() as any[]

  const tokens = new Set<string>()
  const re = /feishu\.cn\/(?:wiki|docx|doc|sheet|sheets|bitable|base|mindnote|slides|drive\/folder)\/([A-Za-z0-9]{15,})/g
  for (const row of rows) {
    let m
    while ((m = re.exec(row.content)) !== null) {
      tokens.add(m[1])
    }
  }
  return Array.from(tokens)
}

// 增量文档同步：云文档 + 消息中的 wiki 链接
export async function quickDocSync(): Promise<{ updated: number; added: number }> {
  const db = getDb()

  const token = (db.prepare(`SELECT value FROM settings WHERE key='feishu_user_access_token'`).get() as any)?.value
  if (!token) return { updated: 0, added: 0 }

  // 1) 云文档列表
  const docs = await listMyDocs(token)
  const shared = await listSharedDocs(token)
  const docMap = new Map<string, DocInfo>()
  for (const d of docs) docMap.set(d.doc_id, d)
  for (const d of shared) { if (!docMap.has(d.doc_id)) docMap.set(d.doc_id, d) }

  // 2) 只扫最近5分钟消息中的新 wiki 链接
  const getExisting = db.prepare(`SELECT doc_id, modified_time FROM feishu_docs WHERE doc_id = ?`)
  const msgTokens = extractDocTokensFromMessages(db, 5)
  for (const t of msgTokens) {
    if (docMap.has(t)) continue
    // 检查是否已入库（可能之前同步过）
    if (getExisting.get(t)) continue
    try {
      const info = await getWikiNode(token, t)
      if (info) {
        docMap.set(info.doc_id, info)
        // node_token 和 obj_token 可能不同，也加上
        if (info.doc_id !== t) docMap.set(t, { ...info, doc_id: t })
      }
    } catch {}
  }

  const upsert = db.prepare(`
    INSERT INTO feishu_docs(doc_id, title, doc_type, url, created_time, modified_time, content, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(doc_id) DO UPDATE SET
      title = excluded.title,
      modified_time = CASE WHEN excluded.modified_time != '' THEN excluded.modified_time ELSE feishu_docs.modified_time END,
      content = CASE WHEN excluded.content != '' THEN excluded.content ELSE feishu_docs.content END,
      synced_at = excluded.synced_at
  `)

  let updated = 0, added = 0

  for (const doc of Array.from(docMap.values())) {
    const existing = getExisting.get(doc.doc_id) as any
    if (!existing) {
      let content = ''
      if (doc.doc_type === 'docx') {
        try { content = await getDocContent(token, doc.doc_id) } catch {}
      }
      upsert.run(doc.doc_id, doc.title, doc.doc_type, doc.url, doc.created_time, doc.modified_time, content)
      added++
    } else if (doc.modified_time && doc.modified_time > (existing.modified_time || '')) {
      let content = ''
      if (doc.doc_type === 'docx') {
        try { content = await getDocContent(token, doc.doc_id) } catch {}
      }
      upsert.run(doc.doc_id, doc.title, doc.doc_type, doc.url, doc.created_time, doc.modified_time, content)
      updated++
    }
  }

  return { updated, added }
}
