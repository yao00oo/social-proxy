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

// 获取文档纯文本内容（仅支持 docx 类型）
export async function getDocContent(userToken: string, docId: string): Promise<string> {
  const res = await get(`/docx/v1/documents/${docId}/raw_content`, userToken)
  if (res.code !== 0) return ''
  return res.data?.content || ''
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

  // 合并去重（以 doc_id 为准，我的文档优先保留完整信息）
  const docMap = new Map<string, DocInfo>()
  for (const doc of myDocs) docMap.set(doc.doc_id, doc)
  for (const doc of sharedDocs) {
    if (!docMap.has(doc.doc_id)) docMap.set(doc.doc_id, doc)
  }
  const allDocs = [...docMap.values()]
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

// 增量文档同步：只拉列表，对比 modified_time，有变更才拉内容
export async function quickDocSync(): Promise<{ updated: number; added: number }> {
  const db = getDb()

  const token = (db.prepare(`SELECT value FROM settings WHERE key='feishu_user_access_token'`).get() as any)?.value
  if (!token) return { updated: 0, added: 0 }

  // 只拉我的文档列表（快速，不拉内容）
  const docs = await listMyDocs(token)
  // 也拉协作文档
  const shared = await listSharedDocs(token)
  const docMap = new Map<string, DocInfo>()
  for (const d of docs) docMap.set(d.doc_id, d)
  for (const d of shared) { if (!docMap.has(d.doc_id)) docMap.set(d.doc_id, d) }

  const getExisting = db.prepare(`SELECT modified_time FROM feishu_docs WHERE doc_id = ?`)
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

  for (const doc of docMap.values()) {
    const existing = getExisting.get(doc.doc_id) as any
    if (!existing) {
      // 新文档
      let content = ''
      if (doc.doc_type === 'docx') {
        try { content = await getDocContent(token, doc.doc_id) } catch {}
      }
      upsert.run(doc.doc_id, doc.title, doc.doc_type, doc.url, doc.created_time, doc.modified_time, content)
      added++
    } else if (doc.modified_time && doc.modified_time > (existing.modified_time || '')) {
      // 已有但有更新
      let content = ''
      if (doc.doc_type === 'docx') {
        try { content = await getDocContent(token, doc.doc_id) } catch {}
      }
      upsert.run(doc.doc_id, doc.title, doc.doc_type, doc.url, doc.created_time, doc.modified_time, content)
      updated++
    }
    // 没变化的跳过
  }

  return { updated, added }
}
