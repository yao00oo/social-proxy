// Drizzle ORM schema — 多租户 SaaS 版本，所有表含 userId
import { pgTable, text, serial, integer, timestamp, uniqueIndex, index, primaryKey } from 'drizzle-orm/pg-core'

// ── 用户表（NextAuth 管理） ──────────────────────────
export const users = pgTable('users', {
  id: text('id').primaryKey(), // NextAuth 生成的 UUID
  name: text('name'),
  email: text('email').unique(),
  emailVerified: timestamp('email_verified', { mode: 'date' }),
  image: text('image'),
})

export const accounts = pgTable('accounts', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  provider: text('provider').notNull(),
  providerAccountId: text('provider_account_id').notNull(),
  refreshToken: text('refresh_token'),
  accessToken: text('access_token'),
  expiresAt: integer('expires_at'),
  tokenType: text('token_type'),
  scope: text('scope'),
  idToken: text('id_token'),
  sessionState: text('session_state'),
}, (t) => [
  primaryKey({ columns: [t.provider, t.providerAccountId] }),
])

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
})

export const verificationTokens = pgTable('verification_tokens', {
  identifier: text('identifier').notNull(),
  token: text('token').notNull(),
  expires: timestamp('expires', { mode: 'date' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.identifier, t.token] }),
])

// ── 聊天记录 ─────────────────────────────────────────
export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  contactName: text('contact_name').notNull(),
  direction: text('direction').notNull(), // 'sent' | 'received'
  content: text('content').notNull(),
  timestamp: text('timestamp').notNull(),
  sourceId: text('source_id'),
}, (t) => [
  index('idx_messages_user_contact').on(t.userId, t.contactName),
  index('idx_messages_user_ts').on(t.userId, t.timestamp),
  uniqueIndex('idx_messages_user_source').on(t.userId, t.sourceId),
])

// ── 联系人 ───────────────────────────────────────────
export const contacts = pgTable('contacts', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  feishuOpenId: text('feishu_open_id'),
  lastContactAt: text('last_contact_at'),
  messageCount: integer('message_count').default(0),
}, (t) => [
  uniqueIndex('idx_contacts_user_name').on(t.userId, t.name),
])

// ── 配置 (per-user key-value) ────────────────────────
export const settings = pgTable('settings', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull().default(''),
}, (t) => [
  primaryKey({ columns: [t.userId, t.key] }),
])

// ── 飞书用户映射 ─────────────────────────────────────
export const feishuUsers = pgTable('feishu_users', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  openId: text('open_id').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
}, (t) => [
  primaryKey({ columns: [t.userId, t.openId] }),
  index('idx_feishu_users_name').on(t.userId, t.name),
])

// ── 飞书文档 ─────────────────────────────────────────
export const feishuDocs = pgTable('feishu_docs', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  docId: text('doc_id').notNull(),
  title: text('title').notNull(),
  docType: text('doc_type'),
  url: text('url'),
  createdTime: text('created_time'),
  modifiedTime: text('modified_time'),
  content: text('content'),
  summary: text('summary'),
  syncedAt: text('synced_at'),
}, (t) => [
  primaryKey({ columns: [t.userId, t.docId] }),
  index('idx_feishu_docs_modified').on(t.userId, t.modifiedTime),
])

// ── 飞书同步状态 ─────────────────────────────────────
export const feishuSyncState = pgTable('feishu_sync_state', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull(),
  chatName: text('chat_name'),
  chatType: text('chat_type'),
  lastSyncTs: text('last_sync_ts').default('0'),
}, (t) => [
  primaryKey({ columns: [t.userId, t.chatId] }),
])

// ── 回复建议 ─────────────────────────────────────────
export const replySuggestions = pgTable('reply_suggestions', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  messageId: text('message_id'),
  contactName: text('contact_name').notNull(),
  chatId: text('chat_id'),
  incomingContent: text('incoming_content').notNull(),
  suggestion: text('suggestion'),
  createdAt: text('created_at').notNull(),
  isRead: integer('is_read').default(0),
  isAtMe: integer('is_at_me').default(0),
}, (t) => [
  uniqueIndex('idx_reply_user_msgid').on(t.userId, t.messageId),
  index('idx_reply_user_created').on(t.userId, t.createdAt),
])

// ── AI 对话（Phase 3） ───────────────────────────────
export const conversations = pgTable('conversations', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow(),
}, (t) => [
  index('idx_conv_user').on(t.userId),
])

export const conversationMessages = pgTable('conversation_messages', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant' | 'tool'
  content: text('content'),
  toolCalls: text('tool_calls'), // JSON string
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow(),
})

// ── 邮件同步状态 ─────────────────────────────────────
export const emailSyncState = pgTable('email_sync_state', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  folder: text('folder').notNull(),
  lastUid: integer('last_uid').default(0),
}, (t) => [
  primaryKey({ columns: [t.userId, t.folder] }),
])

// ── 聊天摘要 ─────────────────────────────────────────
export const chatSummaries = pgTable('chat_summaries', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  chatId: text('chat_id').notNull(),
  chatName: text('chat_name'),
  startTime: text('start_time'),
  endTime: text('end_time'),
  messageCount: integer('message_count'),
  summary: text('summary'),
  updatedAt: text('updated_at'),
}, (t) => [
  primaryKey({ columns: [t.userId, t.chatId] }),
])
