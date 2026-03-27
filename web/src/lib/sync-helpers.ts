// 统一多平台 CRUD helpers — 所有 sync/send/import route 复用
import { query, queryOne, exec } from './db'

// ── Channel（数据源） ──────────────────────────────────

export async function getOrCreateChannel(
  userId: string,
  platform: string,
  name: string,
  credentials: any = {},
): Promise<{ id: number }> {
  const existing = await queryOne<{ id: number }>(
    'SELECT id FROM channels WHERE user_id = ? AND platform = ?',
    [userId, platform],
  )
  if (existing) return existing

  const rows = await query<{ id: number }>(
    `INSERT INTO channels (user_id, platform, name, credentials)
     VALUES (?, ?, ?, ?::jsonb)
     ON CONFLICT (user_id, platform) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [userId, platform, name, JSON.stringify(credentials)],
  )
  return rows[0]
}

export async function getChannelCredentials(channelId: number): Promise<any> {
  const row = await queryOne<{ credentials: any }>('SELECT credentials FROM channels WHERE id = ?', [channelId])
  return row?.credentials || {}
}

export async function updateChannelCredentials(channelId: number, credentials: any): Promise<void> {
  await exec('UPDATE channels SET credentials = ?::jsonb WHERE id = ?', [JSON.stringify(credentials), channelId])
}

// ── Thread（会话） ─────────────────────────────────────

export async function getOrCreateThread(
  userId: string,
  channelId: number,
  platformThreadId: string,
  name: string,
  type: string = 'group',
): Promise<{ id: number; last_sync_ts: string }> {
  const existing = await queryOne<{ id: number; last_sync_ts: string }>(
    'SELECT id, last_sync_ts FROM threads WHERE channel_id = ? AND platform_thread_id = ?',
    [channelId, platformThreadId],
  )
  if (existing) {
    // 更新名字
    if (name) await exec('UPDATE threads SET name = ? WHERE id = ?', [name, existing.id])
    return existing
  }

  const rows = await query<{ id: number; last_sync_ts: string }>(
    `INSERT INTO threads (user_id, channel_id, platform_thread_id, name, type, last_sync_ts)
     VALUES (?, ?, ?, ?, ?, '0')
     ON CONFLICT (channel_id, platform_thread_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, last_sync_ts`,
    [userId, channelId, platformThreadId, name, type],
  )
  return rows[0]
}

export async function updateThreadSyncTs(threadId: number, ts: string): Promise<void> {
  // ts 是飞书的毫秒时间戳，last_sync_ts 保持原样用于增量同步，last_message_at 转 ISO 给前端显示
  const isoTime = new Date(parseInt(ts)).toISOString()
  await exec('UPDATE threads SET last_sync_ts = ?, last_message_at = ? WHERE id = ?', [ts, isoTime, threadId])
}

// ── Contact（联系人） ──────────────────────────────────

export async function getOrCreateContact(
  userId: string,
  name: string,
): Promise<{ id: number }> {
  const existing = await queryOne<{ id: number }>(
    'SELECT id FROM contacts WHERE user_id = ? AND name = ?',
    [userId, name],
  )
  if (existing) return existing

  const rows = await query<{ id: number }>(
    `INSERT INTO contacts (user_id, name, message_count)
     VALUES (?, ?, 0)
     ON CONFLICT (user_id, name) DO NOTHING
     RETURNING id`,
    [userId, name],
  )
  // ON CONFLICT DO NOTHING 不返回 id，需要再查一次
  if (rows.length === 0) {
    const row = await queryOne<{ id: number }>('SELECT id FROM contacts WHERE user_id = ? AND name = ?', [userId, name])
    return row!
  }
  return rows[0]
}

export async function updateContactStats(
  userId: string,
  name: string,
  timestamp: string,
): Promise<void> {
  await exec(
    `UPDATE contacts SET
       message_count = message_count + 1,
       last_contact_at = CASE WHEN ? > COALESCE(last_contact_at, '') THEN ? ELSE last_contact_at END
     WHERE user_id = ? AND name = ?`,
    [timestamp, timestamp, userId, name],
  )
}

// ── Contact Identity（平台身份） ──────────────────────

export async function getOrCreateContactIdentity(
  contactId: number,
  channelId: number,
  platformUid: string,
  displayName?: string,
  email?: string,
  phone?: string,
): Promise<{ id: number }> {
  const existing = await queryOne<{ id: number }>(
    'SELECT id FROM contact_identities WHERE channel_id = ? AND platform_uid = ?',
    [channelId, platformUid],
  )
  if (existing) {
    if (displayName) {
      await exec('UPDATE contact_identities SET display_name = ? WHERE id = ?', [displayName, existing.id])
    }
    return existing
  }

  const rows = await query<{ id: number }>(
    `INSERT INTO contact_identities (contact_id, channel_id, platform_uid, display_name, email, phone)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id, platform_uid) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contact_identities.display_name)
     RETURNING id`,
    [contactId, channelId, platformUid, displayName || null, email || null, phone || null],
  )
  return rows[0]
}

// ── Message（消息） ────────────────────────────────────

export async function insertUnifiedMessage(
  userId: string,
  threadId: number,
  channelId: number,
  msg: {
    direction: 'sent' | 'received'
    senderName: string
    senderIdentityId?: number
    content: string
    msgType?: string
    timestamp: string
    platformMsgId: string
    metadata?: any
  },
): Promise<boolean> {
  // 返回 true 表示新插入，false 表示已存在（去重）
  const rows = await query<{ id: number }>(
    `INSERT INTO messages (user_id, thread_id, channel_id, direction, sender_identity_id, sender_name,
       content, msg_type, timestamp, platform_msg_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
     ON CONFLICT (channel_id, platform_msg_id) DO NOTHING
     RETURNING id`,
    [
      userId, threadId, channelId, msg.direction,
      msg.senderIdentityId || null, msg.senderName,
      msg.content, msg.msgType || 'text', msg.timestamp,
      msg.platformMsgId, JSON.stringify(msg.metadata || {}),
    ],
  )
  return rows.length > 0
}

// ── Sender Name Cache（从 contact_identities 构建） ───

export async function buildSenderNameCache(
  userId: string,
  channelId: number,
): Promise<Map<string, string>> {
  const cache = new Map<string, string>()
  const rows = await query<{ platform_uid: string; display_name: string }>(
    `SELECT ci.platform_uid, COALESCE(ci.display_name, c.name) as display_name
     FROM contact_identities ci
     JOIN contacts c ON ci.contact_id = c.id
     WHERE c.user_id = ? AND ci.channel_id = ?`,
    [userId, channelId],
  )
  for (const r of rows) {
    if (r.display_name) cache.set(r.platform_uid, r.display_name)
  }
  return cache
}
