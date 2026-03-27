// 数据库层 — 线上版本用 Neon PostgreSQL
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

let _sql: ReturnType<typeof neon> | null = null
let _drizzleDb: ReturnType<typeof drizzle> | null = null

function getSql() {
  if (_sql) return _sql
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set')
  _sql = neon(process.env.DATABASE_URL)
  return _sql
}

// Drizzle ORM instance (for NextAuth adapter etc.)
export function getDrizzleDb() {
  if (_drizzleDb) return _drizzleDb
  _drizzleDb = drizzle(getSql(), { schema })
  return _drizzleDb
}

// Raw SQL query helper — converts ? to $1,$2,... for PostgreSQL
export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  let i = 0
  const pgSql = sql.replace(/\?/g, () => `$${++i}`)
  const fn = getSql()
  return await fn.query(pgSql, params) as T[]
}

export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] || null
}

export async function exec(sql: string, params: any[] = []): Promise<void> {
  await query(sql, params)
}

// ── Types ──

export interface Channel {
  id: number
  user_id: string
  platform: string
  name: string
  credentials: Record<string, any> | null
  sync_state: Record<string, any> | null
}

export interface Thread {
  id: number
  user_id: string
  channel_id: number
  platform_thread_id: string
  name: string | null
  type: string | null
  participants: Array<{ identity_id: number; name: string }> | null
  last_message_at: string | null
  last_sync_ts: string | null
}

export interface Message {
  id: number
  user_id: string
  thread_id: number
  channel_id: number
  direction: 'sent' | 'received'
  sender_identity_id: number | null
  sender_name: string | null
  content: string
  msg_type: string | null
  timestamp: string
  platform_msg_id: string | null
  is_read: number
  metadata: Record<string, any> | null
}

export interface Contact {
  id: number
  user_id: string
  name: string
  avatar: string | null
  tags: string[] | null
  notes: string | null
  last_contact_at: string | null
  message_count: number
  merged_into: number | null
}

export interface ContactIdentity {
  id: number
  contact_id: number
  channel_id: number
  platform_uid: string
  display_name: string | null
  email: string | null
  phone: string | null
  metadata: Record<string, any> | null
}

export interface Summary {
  id: number
  user_id: string
  thread_id: number
  summary: string | null
  start_time: string | null
  end_time: string | null
  message_count: number | null
}

export { schema }
