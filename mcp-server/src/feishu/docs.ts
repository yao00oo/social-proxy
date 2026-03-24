// 飞书云文档同步
import { getDb } from '../db'

const BASE = 'https://open.feishu.cn/open-apis'

async function get(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  return res.json()
}

// 列出我的云文档（递归遍历文件夹）
export async function listDocs(userToken: string): Promise<Array<{
  doc_id: string; title: string; doc_type: string; url: string; modified_time: string; created_time: string
}>> {
  const docs: any[] = []

  async function fetchFolder(folderToken: string) {
    let pageToken = ''
    while (true) {
      const params: Record<string, string> = { page_size: '200' }
      if (folderToken) params.folder_token = folderToken
      if (pageToken) params.page_token = pageToken

      const res = await get('/drive/v1/files', userToken, params)
      if (res.code !== 0) {
        console.error('listDocs error:', res.msg)
        break
      }

      for (const item of res.data?.files || []) {
        if (item.type === 'folder') {
          await fetchFolder(item.token)
        } else if (['doc', 'docx', 'sheet', 'bitable', 'mindnote'].includes(item.type)) {
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

  log('获取文档列表...')
  const docs = await listDocs(token)
  log(`共 ${docs.length} 个文档`)

  const upsert = db.prepare(`
    INSERT INTO feishu_docs(doc_id, title, doc_type, url, created_time, modified_time, content, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(doc_id) DO UPDATE SET
      title = excluded.title,
      modified_time = excluded.modified_time,
      content = CASE WHEN excluded.modified_time > feishu_docs.modified_time THEN excluded.content ELSE feishu_docs.content END,
      synced_at = excluded.synced_at
  `)

  const errors: string[] = []
  let synced = 0

  for (const doc of docs) {
    try {
      let content = ''
      if (doc.doc_type === 'docx') {
        content = await getDocContent(token, doc.doc_id)
      }
      upsert.run(doc.doc_id, doc.title, doc.doc_type, doc.url, doc.created_time, doc.modified_time, content)
      log(`  ✓ ${doc.title} (${doc.doc_type})`)
      synced++
    } catch (e: any) {
      const msg = `${doc.title}: ${e.message}`
      errors.push(msg)
      log(`  ⚠ ${msg}`)
    }
  }

  log(`\n✅ 文档同步完成: ${synced} 个，${errors.length} 个错误`)
  return { total: docs.length, synced, errors }
}
