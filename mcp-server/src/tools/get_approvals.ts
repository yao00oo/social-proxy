// Tool: get_approvals — 查询待审批/已审批任务，获取详情和附件
import { getDb } from '../db'
import { ensureValidToken, getSetting } from '../feishu/auth'
import { getAppAccessToken } from '../feishu/api'
import https from 'https'

const BASE = 'https://open.feishu.cn/open-apis'

function get(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)) }
      })
    })
    req.setTimeout(15000, () => { req.destroy(new Error('request timeout')) })
    req.on('error', reject)
    req.end()
  })
}

export interface ApprovalTask {
  title: string
  instance_code: string
  status: string
  initiator_name?: string
  create_time?: string
  url?: string
}

// 查询用户的审批任务
export async function getApprovalTasks(
  userId: string,
  topic: number = 1, // 1=待审批 2=已审批 3=我发起的
  limit: number = 20,
): Promise<ApprovalTask[]> {
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'
  const token = await ensureValidToken(uid)
  const feishuUserId = getSetting('feishu_user_id', uid)
  if (!feishuUserId) throw new Error('未设置 feishu_user_id，请先完成飞书授权')

  const params: Record<string, string> = {
    user_id: feishuUserId,
    user_id_type: 'open_id',
    topic: topic.toString(),
    page_size: Math.min(limit, 200).toString(),
  }

  const res = await get('/approval/v4/tasks/query', token, params)
  if (res.code !== 0) throw new Error(`查询审批任务失败: ${res.msg} (code=${res.code})`)

  const tasks: ApprovalTask[] = (res.data?.tasks || []).map((t: any) => ({
    title: t.title || t.definition_name || '无标题',
    instance_code: t.process_code || t.instance_code || '',
    status: t.status === 2 ? '已完成' : t.status === 1 ? '进行中' : String(t.status),
    initiator_name: t.initiator_names?.[0] || '',
    create_time: t.create_time ? new Date(parseInt(t.create_time) * 1000).toISOString().slice(0, 16) : '',
    url: t.urls?.pc_link || t.urls?.mobile_link || '',
    process_id: t.process_id || '',
  }))

  return tasks
}

// 获取审批实例详情（表单数据 + 附件）— 需要 tenant_access_token
export async function getApprovalDetail(userId: string, instanceCode: string): Promise<any> {
  const uid = userId || process.env.DEFAULT_USER_ID || 'local'
  const appId = getSetting('feishu_app_id', uid)
  const appSecret = getSetting('feishu_app_secret', uid)
  const token = await getAppAccessToken(appId, appSecret)

  const res = await get(`/approval/v4/instances/${instanceCode}`, token)
  if (res.code !== 0) throw new Error(`获取审批详情失败: ${res.msg} (code=${res.code})`)

  const inst = res.data
  const result: any = {
    title: inst.approval_name || '',
    status: inst.status || '',
    initiator: inst.user_id || '',
    create_time: inst.start_time || '',
    end_time: inst.end_time || '',
  }

  // 解析表单数据
  if (inst.form) {
    try {
      const formData = JSON.parse(inst.form)
      result.form = formData.map((f: any) => ({
        name: f.name || f.id,
        type: f.type,
        value: f.value,
        ext: f.ext,
      }))
    } catch {
      result.form_raw = inst.form
    }
  }

  // 收集附件（从评论和时间线中）
  const files: any[] = []
  for (const comment of inst.comment_list || []) {
    for (const file of comment.files || []) {
      files.push({
        title: file.title || file.name || '未命名文件',
        url: file.url,
        size: file.size,
        type: file.type,
        from: 'comment',
      })
    }
  }
  for (const event of inst.timeline || []) {
    for (const file of event.files || []) {
      files.push({
        title: file.title || file.name || '未命名文件',
        url: file.url,
        size: file.size,
        type: file.type,
        from: 'timeline',
      })
    }
  }

  // 表单中的附件字段
  if (result.form) {
    for (const field of result.form) {
      if (field.type === 'attachmentV2' || field.type === 'attachment') {
        const attachments = Array.isArray(field.value) ? field.value : []
        for (const att of attachments) {
          files.push({
            title: att.name || att.title || '未命名文件',
            url: att.url,
            size: att.size,
            type: att.type || att.mime_type,
            from: 'form',
          })
        }
      }
    }
  }

  if (files.length > 0) result.files = files

  // 审批节点
  result.tasks = (inst.task_list || []).map((t: any) => ({
    node: t.node_name || '',
    user_id: t.user_id || '',
    status: t.status || '',
  }))

  return result
}
