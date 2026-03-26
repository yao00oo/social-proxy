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
export interface Contact {
  name: string
  email: string | null
  phone: string | null
  feishu_open_id: string | null
  last_contact_at: string | null
  message_count: number
  days_since_last_contact: number
}

export interface Message {
  id: number
  contact_name: string
  direction: 'sent' | 'received'
  content: string
  timestamp: string
  source_id: string | null
}

export interface NewMessage {
  id: number
  message_id: string | null
  contact_name: string
  incoming_content: string
  created_at: string
  is_at_me: boolean
  is_read: boolean
  suggestion: string | null
}

export { schema }
