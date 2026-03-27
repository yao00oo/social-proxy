# Social Proxy — 项目指南

## 项目概述
AI 社交关系管理工具。用户通过 Google 登录 → 连接飞书/Gmail → AI 助手"小林"帮你管理消息、联系人、社交关系。

线上地址：https://botook.ai

## 仓库结构

```
social-proxy/
├── web/                    # Next.js 16 前端（部署到 Vercel）
│   ├── src/app/            # 页面和 API routes
│   │   ├── page.tsx        # 主页（AI 对话 + 联系人侧边栏）
│   │   ├── settings/       # 设置页（数据源配置）
│   │   ├── login/          # 登录页
│   │   └── api/            # API routes（25+）
│   ├── src/lib/            # 共享库
│   │   ├── db.ts           # Neon PostgreSQL 连接（query/queryOne/exec）
│   │   ├── agent.ts        # AI 对话（Vercel AI SDK + OpenRouter）
│   │   ├── feishu.ts       # 飞书 API 封装
│   │   ├── schema.ts       # Drizzle ORM schema
│   │   └── auth-helper.ts  # 认证 helper（getUserId）
│   ├── src/auth.ts         # NextAuth v4 配置（Google 登录）
│   └── src/middleware.ts   # 路由保护（cookie 检查）
├── mcp-server/             # MCP Server（本地 Claude 用，线上不用）
├── relay-worker/           # Cloudflare Worker（OAuth 中继）
└── images/                 # 飞书同步的图片（gitignore）
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
| `/api/feishu-sync` | GET/POST | 飞书消息同步 |
| `/api/settings` | GET/POST | 用户设置 |

所有 API（除 health/auth）都需要登录，通过 `getUserId()` 获取当前用户 ID。

## 飞书同步机制

1. 用户在设置页授权飞书（OAuth，回调走 relay.botook.ai）
2. 点同步 → POST `/api/feishu-sync` → 拉会话列表 → 逐个拉消息
3. 增量同步：每个会话记录 `last_sync_ts`，只拉新消息
4. Vercel 60 秒超时保护：接近超时自动停止，前端自动续传
5. 支持两种模式：环境变量（共享应用）或用户自建应用

## 注意事项

- **不要加 localhost 回调**：所有 OAuth 回调只用 botook.ai
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
