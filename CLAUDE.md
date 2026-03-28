# Social Proxy — 项目指南

## 产品定义

**Social Proxy 是一个统一收件箱，把所有你能对话的东西变成联系人。**

联系人是人、机器、还是 AI 不重要。交互方式完全一样：看消息、发消息、让小林帮你处理。

线上地址：https://botook.ai

### 联系人的来源

| 来源 | 接入方式 | 联系人举例 |
|------|---------|-----------|
| 飞书 | OAuth 授权 | 张三、打包群 |
| Gmail | OAuth 授权 | 李四（邮件往来） |
| 微信 | 导入聊天记录 | 妈妈、同学群 |
| iMessage | Mac 本地同步 | iPhone 联系人 |
| 终端 | `curl -fsSL https://botook.ai/install-terminal.sh \| sh` | 我的 MacBook、生产服务器 |
| Telegram | Bot Token | Telegram 联系人 |
| Webhook | 粘贴 URL | Sentry 告警、CI 通知 |
| AI | 填 API Key | ChatGPT、自定义 Bot |
| 任意 IM | 未来扩展 | WhatsApp、Discord、Slack |

### 每种联系人的对话

**人（飞书/邮件/微信）** — 正常聊天消息
```
张三: 明天开会吗
我: 好的，几点
```

**终端（MacBook/服务器）** — 命令和输出
```
我: df -h
MacBook: Filesystem  Size  Used  Avail
         /dev/disk1  500G  380G  120G
```

**Webhook（CI/告警）** — 事件通知 + 可回复
```
GitHub Actions: ❌ Build #128 failed — test timeout
我: 看看日志
```

**AI** — 对话
```
我: 帮我写个正则匹配邮箱
ChatGPT: ^[a-zA-Z0-9._%+-]+@...
```

**全部都是同一个界面：** 左边联系人列表，右边聊天记录，底部输入框。

### 小林（AI 助理）

小林能操作所有联系人，跨平台编排：
```
你: 把 MacBook 上的报告发给祝悦
小林: → 给"我的MacBook"发命令读取文件
      → MacBook 回传文件内容
      → 给"祝悦"(飞书) 发送附件
      → 完成
```

### 统一模型

不管来源是什么，在 Social Proxy 里都是同一个结构：
- **Channel** — 怎么连的（飞书OAuth / 终端daemon / Webhook URL）
- **Thread** — 一个对话（和张三的私聊 / 打包群 / 我的MacBook）
- **Message** — 一条消息（文本 / 命令输出 / 邮件 / 图片）

### 接入新 IM 的标准

只需实现两个能力：
- **收消息**：能把消息推到 Social Proxy（Webhook / 轮询 / WebSocket）
- **发消息**：Social Proxy 能把消息发出去（API / SMTP / stdin）

```sql
INSERT INTO channels (user_id, platform, name, credentials)
VALUES ('user1', '新平台', '显示名', '{"token":"xxx"}')
-- 消息自动写入 threads + messages，Web 端自动出现这个联系人
```

### 术语表

| 术语 | 定义 | 不要叫 |
|------|------|--------|
| **联系人** | 任何你能发消息的对象 | ~~用户、设备、服务~~ |
| **Channel** | 连接方式（飞书/终端/Webhook） | ~~数据源、平台~~ |
| **Thread** | 一个对话 | ~~会话、聊天室~~ |
| **Message** | 一条消息 | ~~记录、日志~~ |
| **小林** | AI 助理，能操作所有联系人 | ~~Bot、Agent~~ |
| **终端** | 通过 daemon 连接的机器 | ~~设备、节点~~ |

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
├── mcp-server/                 # MCP Server（本地 AI 工具连接 Neon 云数据库）
│   ├── src/
│   │   ├── index.ts            # MCP Server 入口（7 个工具内联，无后台同步）
│   │   ├── bin.ts              # CLI 入口（setup / server 分流）
│   │   ├── cli-setup.ts        # `npx social-proxy-mcp setup` 交互式安装
│   │   ├── db-pg.ts            # Neon PostgreSQL 连接（Drizzle ORM）
│   │   └── schema.ts           # Drizzle ORM schema（与 web 共享）
│   └── package.json            # bin: social-proxy-mcp
├── relay-worker/               # Cloudflare Worker（relay.botook.ai）
│   ├── src/index.ts            # OAuth 中继 + 飞书事件队列
│   └── wrangler.toml           # Cloudflare 部署配置
├── web/public/
│   ├── install-ai-connector.sh # AI 工具数据连接器安装脚本
│   ├── install-terminal.sh     # Terminal agent 安装脚本
│   ├── install-imessage.sh     # iMessage 同步安装脚本
│   └── skill/                  # Agent Skills 标准格式（跨平台）
│       ├── SKILL.md            # Skill 定义（Claude Code / OpenClaw / Cursor）
│       └── scripts/setup.sh    # 浏览器授权 + MCP 配置
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

**连接**：Neon serverless PostgreSQL，通过 `@neondatabase/serverless` + Drizzle ORM。
**Schema 定义**：`web/src/lib/schema.ts`（Drizzle pgTable），同步到 `mcp-server/src/schema.ts`。
**所有表都有 `user_id` 外键，实现多租户数据隔离。**

### 统一多平台数据模型

```
users (NextAuth)
  ├── channels ── 数据源渠道（飞书/Gmail/微信/Telegram/任意IM）
  │     ├── threads ── 会话（私聊/群聊/邮件线程）
  │     │     ├── messages ── 消息（统一格式）
  │     │     └── summaries ── AI 摘要
  │     ├── contact_identities ── 联系人的平台身份
  │     └── documents ── 文档
  ├── contacts ── 联系人（平台无关，可合并）
  ├── settings ── 用户偏好
  └── conversations ── 小林对话历史
```

### 表字段详情

#### `channels` — 数据源渠道
| 字段 | 类型 | 说明 |
|------|------|------|
| id | serial PK | |
| user_id | text FK→users | 所属用户 |
| platform | text NOT NULL | 平台类型：`feishu` `gmail` `wechat` `telegram` `whatsapp` `slack` `discord` `custom` |
| name | text NOT NULL | 显示名（如"工作飞书"、"个人Gmail"） |
| enabled | integer | 是否启用（1/0） |
| credentials | jsonb | OAuth/API 凭证（加密 JSON）。飞书: `{app_id, app_secret, user_token, refresh_token, user_id, token_time}`。Gmail: `{access_token, refresh_token, client_id, client_secret}`。SMTP: `{host, port, user, pass, from_name}` |
| sync_state | jsonb | 同步状态（各平台自定义）。飞书: `{chats:{chat_id:{name,type,last_sync_ts}}}`。Gmail: `{history_id}` |
| send_mode | text | 发送权限：`suggest`（草稿需确认）/ `auto`（直接发送） |
| created_at | timestamptz | |

**新 IM 接入**：只需 INSERT 一行 channel + 写 sync adapter，不需要建新表。

#### `contacts` — 联系人（平台无关）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | serial PK | |
| user_id | text FK→users | |
| name | text NOT NULL | 显示名（唯一索引 user_id+name） |
| avatar | text | 头像 URL |
| tags | jsonb | 标签数组：`["朋友","同事","VIP"]` |
| notes | text | 用户备注 |
| last_contact_at | text | 最后联系时间（冗余，写消息时更新） |
| message_count | integer | 消息总数（冗余，写消息时更新） |
| merged_into | integer | 合并目标联系人 ID（跨平台合并用） |

#### `contact_identities` — 联系人的平台身份
| 字段 | 类型 | 说明 |
|------|------|------|
| id | serial PK | |
| contact_id | integer FK→contacts | 所属联系人 |
| channel_id | integer FK→channels | 所属渠道 |
| platform_uid | text NOT NULL | 平台唯一 ID：飞书 open_id、邮箱地址、微信 wxid 等（唯一索引 channel_id+platform_uid） |
| display_name | text | 该平台上的显示名（可能和 contacts.name 不同） |
| email | text | 可索引的邮箱（方便搜索，其他字段放 metadata） |
| phone | text | 可索引的电话 |
| metadata | jsonb | 平台特有数据 |

**一个联系人可有多个身份**：张三在飞书(open_id) + Gmail(邮箱) + 微信(wxid)。

#### `threads` — 会话
| 字段 | 类型 | 说明 |
|------|------|------|
| id | serial PK | |
| user_id | text FK→users | |
| channel_id | integer FK→channels | 所属渠道 |
| platform_thread_id | text NOT NULL | 平台会话 ID：飞书 chat_id、Gmail thread_id 等（唯一索引 channel_id+platform_thread_id） |
| name | text | 会话名（群名、私聊对方名、邮件主题） |
| type | text | `dm`（私聊）/ `group`（群聊）/ `channel`（频道）/ `email_thread` |
| participants | jsonb | 参与者列表 `[{identity_id, name}]` |
| last_message_at | text | 最后消息时间 |
| last_sync_ts | text | 该会话的同步游标（飞书用毫秒时间戳） |
| metadata | jsonb | 平台特有数据 |

#### `messages` — 消息（统一格式，所有平台写入同一张表）
| 字段 | 类型 | 说明 |
|------|------|------|
| id | serial PK | |
| user_id | text FK→users | 冗余（避免 JOIN threads），查询优化 |
| thread_id | integer FK→threads | 所属会话 |
| channel_id | integer FK→channels | 冗余，来源渠道（避免 JOIN threads） |
| direction | text NOT NULL | `sent` / `received` |
| sender_identity_id | integer | 发送者的 contact_identity ID |
| sender_name | text | 冗余，发送者显示名（避免 JOIN） |
| content | text NOT NULL | 消息文本内容 |
| msg_type | text | `text` `image` `file` `email` `card` `audio` `video` `sticker` `system` |
| timestamp | text NOT NULL | ISO 格式时间 |
| platform_msg_id | text | 平台消息 ID（去重，唯一索引 channel_id+platform_msg_id） |
| is_read | integer | 已读标记（0/1） |
| metadata | jsonb | 平台特有数据。邮件: `{subject,to,cc,html}`。飞书: `{mentions,parent_id,image_key}` |

#### `summaries` — AI 摘要
| 字段 | 类型 | 说明 |
|------|------|------|
| id | serial PK | |
| user_id | text FK→users | 冗余 |
| thread_id | integer FK→threads | 所属会话（唯一索引 user_id+thread_id） |
| summary | text | AI 生成的摘要 |
| start_time / end_time | text | 摘要覆盖的时间范围 |
| message_count | integer | 摘要覆盖的消息数 |
| updated_at | timestamptz | |

#### `documents` — 文档
| 字段 | 类型 | 说明 |
|------|------|------|
| id | serial PK | |
| user_id | text FK→users | |
| channel_id | integer FK→channels | 来源渠道 |
| platform_doc_id | text NOT NULL | 平台文档 ID（唯一索引 channel_id+platform_doc_id） |
| title | text NOT NULL | |
| doc_type | text | `doc` `sheet` `slide` `wiki` `pdf` `attachment` |
| url | text | |
| content / summary | text | |
| metadata | jsonb | |

#### `settings` — 用户偏好（KV）
| 字段 | 类型 | 说明 |
|------|------|------|
| user_id | text FK→users | 复合主键 |
| key | text | 复合主键。如 `ai_model` `language` `notification` |
| value | text | |

**注意**：渠道凭证（OAuth token、SMTP 配置）存在 `channels.credentials`，不要存 settings。

#### `conversations` / `conversation_messages` — 小林对话历史
用于持久化 AI 助手的对话。`role`: `user` / `assistant` / `tool`。`tool_calls`: JSON 字符串。

### 设计原则

1. **冗余字段有明确理由**：`messages.user_id`/`channel_id`/`sender_name` 是查询优化，避免高频 JOIN
2. **时间字段类型**：历史原因部分用 `text`（ISO 字符串），新表用 `timestamptz`，后续统一
3. **JSONB 用于可变结构**：`credentials`、`sync_state`、`metadata`、`participants`、`tags` — 各平台格式不同，不适合固定列
4. **去重靠唯一索引**：`channel_id + platform_msg_id`（消息）、`channel_id + platform_uid`（身份）、`channel_id + platform_thread_id`（会话）

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
| `/api/connect` | POST/GET | CLI 授权：POST 生成授权码，GET 用码换 DATABASE_URL |
| `/api/models` | GET | 可用 AI 模型列表 |

所有 API（除 health/auth）都需要登录，通过 `getUserId()` 获取当前用户 ID。
`getUserId()` 会自动在 PG 的 users 表创建用户记录（JWT 模式不走 adapter）。

## 同步机制（通用）

所有平台同步遵循统一流程：
1. 用户在设置页连接数据源 → 创建 `channels` 记录（含 credentials）
2. 点同步 → sync adapter 拉取数据 → 写入 `threads` + `messages` + `contact_identities`
3. 增量同步：`threads.last_sync_ts` 记录每个会话的同步游标
4. Vercel 60 秒超时保护：接近超时自动停止，前端自动续传
5. 同步状态存在 `channels.sync_state`（JSON），serverless 无状态安全

### 飞书特有
- OAuth 回调走 relay.botook.ai（Cloudflare Worker 中继）
- `listChats` 不返回 p2p 单聊，需用搜索 API 发现
- 凭证存 `channels.credentials`: `{app_id, app_secret, user_token, refresh_token, user_id, token_time}`
- 发送者姓名：用 `sender.id`（open_id）查 `contact_identities.platform_uid`

## 飞书 API 字段参考（避免踩坑）

### GET /im/v1/messages — 获取会话历史消息

**sender 对象只有 4 个字段，没有 name：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `sender.id` | string | 发送者 ID（open_id 或 app_id） |
| `sender.id_type` | string | ID 类型：`open_id`（用户）/ `app_id`（应用） |
| `sender.sender_type` | string | 发送者类型：`user` / `app` / `anonymous` / `unknown` |
| `sender.tenant_key` | string | 租户标识 |

**获取发送者姓名的正确方式**：
1. 先看 `sender.sender_type`：
   - `app`（或 id 以 `cli_` 开头）→ 显示"机器人"，**不要创建 contact**
   - 空 / `unknown` / `anonymous` → 显示"系统消息"，**不要创建 contact**
   - `user`（id 以 `ou_` 开头）→ 用 `sender.id` 查 `contact_identities.platform_uid` 获取真名
2. **绝对不要**用 `sender.name`（不存在）或把 `cli_xxx` / `ou_xxx` 当名字显示
3. 同步前用 `buildSenderNameCache()` 构建 open_id → 真名缓存

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

## AI Connector（让 AI 工具连上数据）

用户在 Claude Code / OpenClaw / Cursor 等 AI 工具里连接 botook 数据的方式：

**安装方式 1：运行脚本**
```bash
curl -fsSL https://botook.ai/install-ai-connector.sh | bash
```
脚本下载 skill 文件到 `~/.claude/skills/botook/`（或 `~/.openclaw/skills/botook/`），然后用户说 `/botook setup` 完成授权。

**安装方式 2：发给 AI 一句话**
```
帮我安装 botook，按照 https://botook.ai/install 的说明操作。
```

**授权流程**：
1. CLI/AI 打开 `botook.ai/connect` → 用户登录并点确认
2. 页面显示 6 位授权码 → 用户粘贴回 CLI
3. CLI 调 `GET /api/connect?code=XXXXXX` 换取 DATABASE_URL
4. 自动配置 MCP（`claude mcp add botook -e DATABASE_URL=... -- npx social-proxy-mcp`）

**文件结构**：
- `web/public/install-ai-connector.sh` — 安装脚本
- `web/public/skill/SKILL.md` — Agent Skills 标准格式
- `web/public/skill/scripts/setup.sh` — 授权 + 配置脚本
- `web/src/app/install/page.tsx` — AI 可读的安装指南页面（公开）
- `web/src/app/connect/page.tsx` — 浏览器授权页面（需登录）
- `web/src/app/api/connect/route.ts` — 授权码 API

## 注意事项

- **不要加 localhost 或其他域名的 OAuth 回调**：所有 OAuth 回调只用 botook.ai，不要建议用户加任何其他域名
- **Vercel serverless 限制**：函数最长 60 秒（Hobby），不能 fire-and-forget
- **PG 查询是异步的**：所有 DB 操作用 `await query()/queryOne()/exec()`
- **node_modules 不提交**：.gitignore 已配置
- **images/ 不提交**：.gitignore 已配置
- **.env.local 不提交**：敏感信息通过 Vercel 环境变量管理

## TODO

### 高优先级（核心功能）
- [x] 统一多平台数据模型（channels/threads/contact_identities 替代 feishu_* 专属表）
- [x] 飞书发送者姓名：用 open_id 查 contact_identities
- [x] 飞书同步适配新模型：sync adapter 写入 channels → threads → messages
- [x] Web Agent 工具对接 PG：agent.ts 已适配新 schema
- [x] 模型选择：设置页切换 AI 模型（OpenRouter）
- [x] AI Connector 安装流程：install-ai-connector.sh + skill + /connect 授权
- [x] MCP Server 迁移到 Neon：SQLite → Neon，删除所有本地同步代码（-3956 行）
- [x] 设置页数据源重构：每个 channel 一张卡片 + 添加数据源弹窗
- [x] 支持同平台多账户（多个 Gmail、多个飞书）
- [ ] **MCP 补充 send_message 工具**：当前只有查询，缺少发送能力
- [ ] **MCP 补充 search_docs 工具**：搜索文档内容
- [ ] **MCP getUserId 改为只读环境变量**：`SELECT id FROM users LIMIT 1` 在多用户下不安全
- [ ] 飞书 p2p 单聊同步：listChats 不返回单聊，需用搜索 API 发现 chat_id
- [ ] **send/feishu INSERT 缺 thread_id/channel_id**：会报 NOT NULL 错误
- [ ] **Markdown 渲染**：小林回复含 Markdown，前端需要渲染
- [ ] **Draft Card 可靠性**：DeepSeek 的 `<<DRAFT|...|...|...>>` 标记有时被跳过

### 中优先级（数据源）
- [x] Gmail OAuth 全链路修复（凭证存 channels.credentials）
- [ ] Gmail 同步测试验证
- [ ] IMAP 邮件同步
- [ ] 微信导入适配新模型
- [ ] 飞书文档同步：写入 documents 表
- [ ] **通用导入**：任意 IM 的聊天记录文本导入（custom channel）

### 低优先级（体验优化）
- [ ] 对话历史持久化（conversations 表已建，前端未接）
- [ ] 移动端适配
- [ ] 搜索联动（人名 + 消息内容）
- [ ] 聊天记录分页（上滑加载）
- [ ] 时间字段统一为 timestamptz
- [ ] ClawHub 发布 botook skill

<!-- VERCEL BEST PRACTICES START -->
## Vercel 开发最佳实践

- Vercel Functions 是无状态的（不能常驻内存、文件系统）
- 不要用 fire-and-forget 异步（函数响应后进程终止）
- maxDuration 设置超时（Hobby 最长 60s）
- 用 `waitUntil` 做响应后的清理工作
- 环境变量存在 Vercel Env Variables，不要放在代码或 `NEXT_PUBLIC_*` 里
<!-- VERCEL BEST PRACTICES END -->
