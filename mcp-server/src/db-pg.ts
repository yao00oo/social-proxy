// PostgreSQL 连接层 — 多租户 SaaS 模式
// 使用 Neon serverless driver + Drizzle ORM
import { neon } from '@neondatabase/serverless'
import { drizzle, NeonHttpDatabase } from 'drizzle-orm/neon-http'
import * as schema from './schema'

let _db: NeonHttpDatabase<typeof schema> | null = null

export function getPgDb(): NeonHttpDatabase<typeof schema> {
  if (_db) return _db

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL 环境变量未设置。多租户模式需要 PostgreSQL 数据库。')
  }

  const sql = neon(databaseUrl)
  _db = drizzle(sql, { schema })
  return _db
}

// Re-export schema for convenience
export { schema }
export type Db = NeonHttpDatabase<typeof schema>
