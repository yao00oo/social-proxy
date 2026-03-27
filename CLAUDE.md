# Social Proxy — 项目指南

## 项目概述
AI 社交关系管理工具。用户通过 Google 登录 → 连接飞书/Gmail → AI 助手"小林"帮你管理消息、联系人、社交关系。

线上地址：https://botook.ai

## 仓库结构

```
social-proxy/
├── web/                        # Next.js 16 前端（部署到 Vercel）
│   ├── src/app/
│   │   ├── page.tsx            # 主页（AI 对话 + 联系人侧边栏 + 同步进度条）
│   │   ├── settings/page.tsx   # 设置页（数据源卡片 + 飞书引导教程）
│   │   ├── login/page.tsx      # Google 登录页
│   │   ├── providers.tsx       # SessionProvider 客户端包装
│   │   ├── contact/[id]/       # 联系人详情页
│   │   └── api/
│   │       ├── auth/[...nextauth]/  # NextAuth 登录/回调
│   │       ├── agent/          # AI 对话（流式）
│   │       ├── feishu-auth/    # 飞书 OAuth 授权
│   │       ├── feishu-complete/# 飞书 OAuth code 换 token
│   │       ├── feishu-sync/    # 飞书消息同步（增量，支持续传）
│   │       ├── feishu-docs/    # 飞书文档同步
│   │       ├── gmail-auth/     # Gmail OAuth
│   │       ├── gmail-complete/ # Gmail OAuth 回调
│   │       ├── gmail-sync/     # Gmail 邮件同步
│   │       ├── email-sync/     # IMAP 邮件同步
│   │       ├── sync-status/    # 全局同步状态（所有数据源）
│   │       ├── contacts/       # 联系人 CRUD
│   │       ├── messages/       # 消息查询
│   │       ├── search/         # 消息搜索
│   │       ├── stats/          # 统计数据
│   │       ├── settings/       # 用户设置
│   │       ├── import/         # 微信/WhatsApp 导入
│   │       ├── send/           # 发送消息（飞书/邮件）
│   │       ├── draft/          # AI 草稿生成
│   │       ├── summaries/      # 会话摘要
│   │       └── health/         # 健康检查（公开）
│   ├── src/lib/
│   │   ├── db.ts               # Neon PG 连接（query/queryOne/exec）
│   │   ├── agent.ts            # AI 对话引擎（9 个工具函数）
│   │   ├── feishu.ts           # 飞书 API（getSetting/getAppAccessToken）
│   │   ├── schema.ts           # Drizzle ORM schema（所有表定义）
│   │   └── auth-helper.ts      # getUserId()（自动创建 PG 用户）
│   ├── src/auth.ts             # NextAuth v4（JWT + Google + 自动 upsert user）
│   ├── src/middleware.ts       # 路由保护（cookie 检查，非 Edge）
│   └── src/types/next-auth.d.ts # NextAuth 类型扩展
├── mcp-server/                 # MCP Server（本地 Claude Desktop 用）
│   ├── src/                    # 业务逻辑（工具函数、飞书API、同步）
│   └── drizzle.config.ts       # Drizzle Kit 配置
├── relay-worker/               # Cloudflare Worker（relay.botook.ai）
│   ├── src/index.ts            # OAuth 中继 + 飞书事件队列
│   └── wrangler.toml           # Cloudflare 部署配置
├── CLAUDE.md                   # 本文件
├── .gitignore                  # 排除 node_modules/images/.env.local/*.db
└── .env.example                # 环境变量模板
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 前端 | Next.js 16 (Turbopack) + Tailwind CSS |
| 数据库 | Neon PostgreSQL (serverless) |
| ORM | Drizzle (schema 在 web/src/lib/schema.ts) |
| 认证 | NextAuth v4 (JWT 模式, Google 登录) |
| AI | Vercel AI SDK + OpenRouter (deepseek-chat) |
| 部署 | Vercel (web/) + Cloudflare Workers (relay-worker/) |
| 域名 | botook.ai (DNS 在 Cloudflare, A 记录指向 Vercel) |

## 数据库

**连接**：Neon serverless，通过 `@neondatabase/serverless` 的 `neon()` 函数。
**查询方式**：`query(sql, params)` / `queryOne(sql, params)` / `exec(sql, params)`，自动把 `?` 转成 `$1,$2,...`。

**核心表**：
- `users` — NextAuth 用户（自动创建）
- `messages` — 聊天记录（user_id, contact_name, direction, content, timestamp, source_id, sender_name）
- `contacts` — 联系人（user_id, name, email, phone, feishu_open_id）
- `settings` — 配置（user_id, key, value）复合主键
- `feishu_sync_state` — 飞书同步进度（user_id, chat_id, last_sync_ts）
- `feishu_users` — 飞书用户映射（user_id, open_id, name）

所有表都有 `user_id` 外键关联 `users.id`，实现多租户数据隔离。

## 部署流程

```bash
# 1. 改代码
# 2. 推到 GitHub
cd /Users/yaoyao/Project/social-proxy
git add -A && git commit -m "描述" && git push origin main

# 3. Vercel 自动部署（GitHub webhook 触发）
# 构建目录：web/
# 约 30-60 秒完成
```

**Vercel 项目设置**：
- Root Directory: `web`
- Build Command: `npm run build`
- Framework: Next.js

## 环境变量（Vercel）

```
DATABASE_URL          # Neon PostgreSQL 连接串
NEXTAUTH_SECRET       # JWT 签名密钥
NEXTAUTH_URL          # https://botook.ai
GOOGLE_CLIENT_ID      # Google OAuth
GOOGLE_CLIENT_SECRET  # Google OAuth
OPENROUTER_API_KEY    # AI 模型调用
FEISHU_APP_ID         # 飞书应用（可选，不设则用户自建）
FEISHU_APP_SECRET     # 飞书应用（可选）
```

用 `npx vercel env add KEY production --value "VALUE" --yes` 管理。

## 关键 API Routes

| 路由 | 方法 | 用途 |
|------|------|------|
| `/api/auth/[...nextauth]` | GET/POST | NextAuth 登录/回调 |
| `/api/agent` | POST | AI 对话（流式） |
| `/api/contacts` | GET | 联系人列表 |
| `/api/stats` | GET | 统计数据 |
| `/api/search` | GET | 搜索消息 |
| `/api/messages/new` | GET | 最近消息 |
| `/api/feishu-auth` | GET/POST | 飞书 OAuth |
| `/api/feishu-complete` | POST | 飞书 OAuth 回调 |
| `/api/feishu-sync` | GET/POST | 飞书消息同步（增量，支持续传） |
| `/api/sync-status` | GET | 全局同步状态（所有数据源，主页轮询用） |
| `/api/settings` | GET/POST | 用户设置 |
| `/api/import` | POST | 微信/WhatsApp 聊天记录导入 |
| `/api/send/feishu` | POST | 通过飞书发消息 |
| `/api/send/email` | POST | 通过邮件发消息 |

所有 API（除 health/auth）都需要登录，通过 `getUserId()` 获取当前用户 ID。
`getUserId()` 会自动在 PG 的 users 表创建用户记录（JWT 模式不走 adapter）。

## 飞书同步机制

1. 用户在设置页通过 6 步引导教程创建飞书应用并授权（OAuth 回调走 relay.botook.ai）
2. 点同步 → POST `/api/feishu-sync` → 拉会话列表（`sort_type=ByActiveTimeDesc`，最近活跃的先同步）→ 逐个拉消息
3. 增量同步：每个会话记录 `last_sync_ts`，只拉新消息
4. Vercel 60 秒超时保护：接近超时自动停止，前端自动续传（递归调用 handleFeishuSync）
5. 支持两种模式：`FEISHU_APP_ID` 环境变量（共享应用）或用户自建应用（自行填写 App ID/Secret）
6. `POST /api/feishu-sync { reset: true }` 清空旧数据重新全量同步
7. **同步状态持久化到 DB**（`settings` 表 key=`feishu_sync_status`），因为 Vercel serverless 实例不共享内存，GET 和 POST 可能在不同实例
8. 主页通过 `/api/sync-status` 每 5 秒轮询显示全局进度

## 飞书 API 字段参考（避免踩坑）

### GET /im/v1/messages — 获取会话历史消息

**sender 对象只有 4 个字段，没有 name：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `sender.id` | string | 发送者 ID（open_id 或 app_id） |
| `sender.id_type` | string | ID 类型：`open_id`（用户）/ `app_id`（应用） |
| `sender.sender_type` | string | 发送者类型：`user` / `app` / `anonymous` / `unknown` |
| `sender.tenant_key` | string | 租户标识 |

**获取发送者姓名的正确方式**：用 `sender.id`（open_id）查 `feishu_users` 表，不要用 `sender.name`（不存在）。

**消息对象完整字段：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `message_id` | string | 消息唯一标识 |
| `root_id` | string | 话题根消息 ID |
| `parent_id` | string | 回复的上级消息 ID |
| `thread_id` | string | 话题 ID |
| `msg_type` | string | 消息类型：text/post/image/file/audio/video/sticker/interactive 等 |
| `create_time` | string | 创建时间（毫秒时间戳） |
| `update_time` | string | 更新时间（毫秒时间戳） |
| `deleted` | boolean | 是否已撤回 |
| `updated` | boolean | 是否已编辑 |
| `chat_id` | string | 所属会话 ID |
| `body.content` | string | 消息内容（JSON 字符串） |
| `mentions[].key` | string | @标记序列（如 @_user_3） |
| `mentions[].id` | string | 被@人的 open_id |
| `mentions[].name` | string | 被@人的显示名称 |

### GET /im/v1/chats — 获取会话列表

**不包含 p2p 单聊**，只返回群组。

| 字段 | 类型 | 说明 |
|------|------|------|
| `chat_id` | string | 群组 ID |
| `name` | string | 群名 |
| `avatar` | string | 群头像 URL |
| `description` | string | 群描述 |
| `owner_id` | string | 群主 ID（机器人群主无返回值） |
| `external` | boolean | 是否外部群 |
| `tenant_key` | string | 租户标识 |
| `chat_status` | string | 状态：`normal` / `dissolved` / `dissolved_save` |

### GET /im/v1/chats/:chat_id — 获取群详情

| 字段 | 类型 | 说明 |
|------|------|------|
| `chat_mode` | string | 会话模式：`group`（群组）/ `topic`（话题）/ `p2p`（单聊） |
| `chat_type` | string | 群类型：`private`（私有）/ `public`（公开） |
| `user_count` | string | 群内用户数 |
| `bot_count` | string | 群内机器人数 |
| 其他字段 | - | 与 list 返回类似，额外有权限配置等 |

### POST /search/v2/message — 搜索消息

可跨会话搜索，**包括 p2p 单聊**。用于发现 p2p 的 chat_id。

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string | 搜索关键词（必填） |
| `chat_type` | string | `group_chat` / `p2p_chat` |
| `from_ids` | string[] | 按发送者 open_id 筛选 |
| `message_type` | string | `file` / `image` / `media` |
| `start_time` / `end_time` | string | 时间范围 |

返回 `items: string[]`（message_id 列表），需要再调 `GET /im/v1/messages/:id` 获取消息详情（含 chat_id）。

## 注意事项

- **不要加 localhost 或其他域名的 OAuth 回调**：所有 OAuth 回调只用 botook.ai，不要建议用户加任何其他域名
- **Vercel serverless 限制**：函数最长 60 秒（Hobby），不能 fire-and-forget
- **PG 查询是异步的**：所有 DB 操作用 `await query()/queryOne()/exec()`
- **node_modules 不提交**：.gitignore 已配置
- **images/ 不提交**：.gitignore 已配置
- **.env.local 不提交**：敏感信息通过 Vercel 环境变量管理

<!-- VERCEL BEST PRACTICES START -->
## Vercel 开发最佳实践

- Vercel Functions 是无状态的（不能常驻内存、文件系统）
- 不要用 fire-and-forget 异步（函数响应后进程终止）
- maxDuration 设置超时（Hobby 最长 60s）
- 用 `waitUntil` 做响应后的清理工作
- 环境变量存在 Vercel Env Variables，不要放在代码或 `NEXT_PUBLIC_*` 里
<!-- VERCEL BEST PRACTICES END -->
