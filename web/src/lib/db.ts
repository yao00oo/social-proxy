// 数据库层 — 多租户模式用 PG（Drizzle），本地模式 fallback SQLite
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from '../../mcp-server/src/schema'

// ── PostgreSQL (Drizzle) ──
let _pgDb: ReturnType<typeof drizzle> | null = null

export function getPgDb() {
  if (_pgDb) return _pgDb
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set')
  _pgDb = drizzle(neon(process.env.DATABASE_URL), { schema })
  return _pgDb
}

// ── SQLite (legacy, 本地开发) ──
import Database from 'better-sqlite3'
import path from 'path'

const DB_PATH = process.env.DB_PATH || path.resolve('/Users/yaoyao/Project/social-proxy/social-proxy.db')
let _sqliteDb: Database.Database | null = null

export function getDb(): Database.Database {
  if (_sqliteDb) return _sqliteDb
  _sqliteDb = new Database(DB_PATH, { readonly: false })
  _sqliteDb.pragma('journal_mode = WAL')
  return _sqliteDb
}

// ── 判断当前模式 ──
export const isPgMode = !!process.env.DATABASE_URL

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
