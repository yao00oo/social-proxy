---
name: botook
description: 统一收件箱 — 查看飞书/Gmail/微信消息、搜索聊天记录、通过 AI 回复消息。当用户提到 botook、看消息、联系人、社交管理时使用。
---

# Botook — 你的统一收件箱

Botook 把飞书、Gmail、微信等所有平台的消息整合在一起，让你在一个地方管理所有社交关系。

## 首次使用

如果用户还没连接过 botook，运行 setup 脚本完成授权：

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/setup.sh
```

这会打开浏览器让用户授权，然后自动配置数据库连接。

## 连接后可以做的事

连接后，你可以直接用 MCP 工具：

- **查看消息**：调用 `get_new_messages` 获取最新消息
- **查看联系人**：调用 `get_contacts` 获取联系人列表
- **搜索记录**：调用 `search_messages` 搜索聊天记录
- **查看历史**：调用 `get_history` 获取某个联系人的聊天记录
- **发送消息**：调用 `send_message` 通过飞书或邮件发送消息

## 注意

- 所有数据存在云端（Neon PostgreSQL），不需要本地数据库
- 需要先在 botook.ai 连接数据源（飞书/Gmail）才有数据
- DATABASE_URL 是用户的私有凭证，不要泄露
