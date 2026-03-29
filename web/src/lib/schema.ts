// Drizzle ORM schema — 多租户 + 多平台统一模型
import { pgTable, text, serial, integer, timestamp, uniqueIndex, index, primaryKey, jsonb } from 'drizzle-orm/pg-core'

// ════════════════════════════════════════════════════════
// Auth（NextAuth 管理，不动）
// ════════════════════════════════════════════════════════

export const users = pgTable('users', {
  id: text('id').primaryKey(),
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

// ════════════════════════════════════════════════════════
// Channels — 数据源/渠道（飞书、Gmail、微信、Telegram...）
// ════════════════════════════════════════════════════════

export const channels = pgTable('channels', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // 平台类型：feishu | gmail | wechat | telegram | whatsapp | slack | discord | custom
  platform: text('platform').notNull(),
  // 显示名：如"工作飞书"、"个人Gmail"
  name: text('name').notNull(),
  // 是否启用
  enabled: integer('enabled').default(1),
  // OAuth / API 凭证（加密 JSON）
  // feishu: { app_id, app_secret, user_token, refresh_token, user_id, token_time }
  // gmail: { access_token, refresh_token, client_id, client_secret }
  // smtp/imap: { host, port, user, pass, from_name }
  // telegram: { bot_token }
  // custom: {}
  credentials: jsonb('credentials').default({}),
  // 同步状态（JSON，各平台自定义格式）
  // feishu: { chats: { chat_id: { name, type, last_sync_ts } } }
  // gmail: { history_id, last_uid }
  // imap: { folders: { INBOX: { last_uid } } }
  syncState: jsonb('sync_state').default({}),
  // 权限模式: suggest（草稿确认）| auto（直接发送）
  sendMode: text('send_mode').default('suggest'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow(),
}, (t) => [
  index('idx_channels_user').on(t.userId),
  uniqueIndex('idx_channels_user_platform_name').on(t.userId, t.platform, t.name),
])

// ════════════════════════════════════════════════════════
// Contacts — 联系人（平台无关，可跨平台合并）
// ════════════════════════════════════════════════════════

export const contacts = pgTable('contacts', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  avatar: text('avatar'), // URL
  tags: jsonb('tags').default([]), // ['朋友', '同事', 'VIP']
  notes: text('notes'),
  lastContactAt: text('last_contact_at'),
  messageCount: integer('message_count').default(0),
  // 如果被合并到另一个联系人，此 ID 指向目标
  mergedInto: integer('merged_into'),
}, (t) => [
  uniqueIndex('idx_contacts_user_name').on(t.userId, t.name),
  index('idx_contacts_user_last').on(t.userId, t.lastContactAt),
])

// ════════════════════════════════════════════════════════
// Contact Identities — 联系人的平台身份（一个人多个平台）
// ════════════════════════════════════════════════════════

export const contactIdentities = pgTable('contact_identities', {
  id: serial('id').primaryKey(),
  contactId: integer('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  // 平台上的唯一 ID：飞书 open_id、邮箱地址、微信 wxid、Telegram user_id...
  platformUid: text('platform_uid').notNull(),
  // 该平台上的显示名（可能和 contacts.name 不同）
  displayName: text('display_name'),
  // 额外信息
  email: text('email'),
  phone: text('phone'),
  metadata: jsonb('metadata').default({}), // 平台特有数据
}, (t) => [
  uniqueIndex('idx_identity_channel_uid').on(t.channelId, t.platformUid),
  index('idx_identity_contact').on(t.contactId),
])

// ════════════════════════════════════════════════════════
// Threads — 会话（群聊、私聊、邮件主题...）
// ════════════════════════════════════════════════════════

export const threads = pgTable('threads', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  // 平台上的会话 ID：飞书 chat_id、Gmail thread_id、微信群 ID...
  platformThreadId: text('platform_thread_id').notNull(),
  name: text('name'),
  // dm（私聊）| group（群聊）| channel（频道）| email_thread（邮件线程）
  type: text('type').default('dm'),
  // 参与者列表 JSON: [{ identity_id, name }]
  participants: jsonb('participants').default([]),
  lastMessageAt: text('last_message_at'),
  lastSyncTs: text('last_sync_ts').default('0'),
  metadata: jsonb('metadata').default({}),
}, (t) => [
  uniqueIndex('idx_threads_channel_pid').on(t.channelId, t.platformThreadId),
  index('idx_threads_user').on(t.userId),
  index('idx_threads_user_last').on(t.userId, t.lastMessageAt),
])

// ════════════════════════════════════════════════════════
// Messages — 消息（统一格式，所有平台写入同一张表）
// ════════════════════════════════════════════════════════

export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  // 冗余 channelId（避免查消息来源时 JOIN threads）
  channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  // sent | received
  direction: text('direction').notNull(),
  // 发送者的 identity ID（可关联到 contact）
  senderIdentityId: integer('sender_identity_id'),
  // 冗余存发送者名（查询方便，避免 JOIN contact_identities）
  senderName: text('sender_name'),
  content: text('content').notNull(),
  // text | image | file | email | card | audio | video | sticker | system
  msgType: text('msg_type').default('text'),
  timestamp: text('timestamp').notNull(),
  // 平台消息 ID（去重用）
  platformMsgId: text('platform_msg_id'),
  // 已读标记
  isRead: integer('is_read').default(0),
  // 平台特有数据 JSON
  metadata: jsonb('metadata').default({}),
}, (t) => [
  index('idx_messages_user_thread').on(t.userId, t.threadId),
  index('idx_messages_user_ts').on(t.userId, t.timestamp),
  index('idx_messages_thread_ts').on(t.threadId, t.timestamp),
  uniqueIndex('idx_messages_channel_pid').on(t.channelId, t.platformMsgId),
])

// ════════════════════════════════════════════════════════
// Summaries — AI 摘要（按 thread）
// ════════════════════════════════════════════════════════

export const summaries = pgTable('summaries', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  threadId: integer('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  summary: text('summary'),
  startTime: text('start_time'),
  endTime: text('end_time'),
  messageCount: integer('message_count'),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow(),
}, (t) => [
  uniqueIndex('idx_summaries_user_thread').on(t.userId, t.threadId),
])

// ════════════════════════════════════════════════════════
// Documents — 文档（飞书文档、邮件附件、共享文件...）
// ════════════════════════════════════════════════════════

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  channelId: integer('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  platformDocId: text('platform_doc_id').notNull(),
  title: text('title').notNull(),
  docType: text('doc_type'), // doc | sheet | slide | wiki | pdf | attachment
  url: text('url'),
  content: text('content'),
  summary: text('summary'),
  createdTime: text('created_time'),
  modifiedTime: text('modified_time'),
  syncedAt: timestamp('synced_at', { mode: 'date' }).defaultNow(),
  metadata: jsonb('metadata').default({}),
}, (t) => [
  uniqueIndex('idx_docs_channel_pid').on(t.channelId, t.platformDocId),
  index('idx_docs_user').on(t.userId),
])

// ════════════════════════════════════════════════════════
// Settings — 用户偏好（KV 模式）
// 只存用户级别偏好：ai_model, language, notification 等
// 渠道凭证/同步配置存在 channels.credentials / channels.syncState
// ════════════════════════════════════════════════════════

export const settings = pgTable('settings', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull().default(''),
}, (t) => [
  primaryKey({ columns: [t.userId, t.key] }),
])

// ════════════════════════════════════════════════════════
// AI Conversations — 小林对话历史
// ════════════════════════════════════════════════════════

export const conversations = pgTable('conversations', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow(),
}, (t) => [
  index('idx_conv_user').on(t.userId),
])

// ════════════════════════════════════════════════════════
// Skills — 用户安装的技能（slash commands）
// ════════════════════════════════════════════════════════

export const skills = pgTable('skills', {
  id: serial('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // skill name (slash command)
  description: text('description'), // when to use this skill
  content: text('content').notNull(), // full SKILL.md content (markdown)
  enabled: integer('enabled').default(1),
  sourceUrl: text('source_url'), // where this skill came from (GitHub URL, ClawHub, etc.)
  metadata: jsonb('metadata').default({}), // frontmatter parsed as JSON
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow(),
}, (t) => [
  index('idx_skills_user').on(t.userId),
  uniqueIndex('idx_skills_user_name').on(t.userId, t.name),
])

export const conversationMessages = pgTable('conversation_messages', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant' | 'tool'
  content: text('content'),
  toolCalls: text('tool_calls'), // JSON
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow(),
})
