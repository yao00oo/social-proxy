# Social Proxy

把微信聊天数据喂给 AI agent，让 agent 代替用户发邮件的 MCP Server。

## 目录结构

```
social-proxy/
├── mcp-server/          # MCP Server (TypeScript + SQLite)
│   └── src/
│       ├── index.ts     # MCP Server 入口
│       ├── db.ts        # SQLite 初始化
│       ├── import.ts    # 微信记录导入脚本
│       └── tools/       # 三个 MCP Tools
├── config-ui/           # 配置页面 (Next.js 14)
├── social-proxy.db      # SQLite 数据库（自动创建）
└── README.md
```

---

## 快速开始

### 第一步：安装依赖

```bash
# MCP Server
cd mcp-server
npm install

# 配置页面
cd ../config-ui
npm install
```

### 第二步：编译 MCP Server

```bash
cd mcp-server
npm run build
```

### 第三步：导入微信记录

把微信导出的聊天记录保存为 `wechat.txt`，格式如下：
```
2024-01-01 12:00 张三: 你好
2024-01-01 12:01 我: 你好！最近怎么样？
2024-01-01 12:05 张三: 还不错，你呢
```

然后运行导入脚本：
```bash
cd mcp-server
npm run import -- ./wechat.txt
```

输出示例：
```
开始导入: /path/to/wechat.txt
✅ 导入完成: 成功 253 条，跳过 12 条
```

### 第四步：打开配置页面

```bash
cd config-ui
npm run dev
```

访问 http://localhost:3000，完成以下配置：

1. **导入微信记录** — 拖入 .txt 文件，看到导入结果
2. **补充联系人邮箱** — 橙色高亮的行表示邮箱为空，点击填写
3. **配置 SMTP** — 填写邮件服务器信息，选择权限模式
4. **复制安装命令** — 在终端粘贴执行

### 第五步：安装 MCP Server

在配置页面第 04 区块复制安装命令，在终端执行，例如：
```bash
claude mcp add social-proxy node /absolute/path/to/mcp-server/dist/index.js
```

---

## 权限模式说明

| 模式 | 行为 |
|------|------|
| `suggest` (默认) | agent 起草邮件后返回草稿，等你确认再发 |
| `auto` | agent 直接发送，无需确认 |

建议先用 `suggest` 模式跑一段时间，确认 agent 行为符合预期后再切换到 `auto`。

---

## MCP Tools

### `get_contacts`
获取所有联系人，按"最久未联系"降序排列。

**示例问法：** "我该联系谁了？"

### `get_history`
获取某联系人的聊天记录（默认最近 30 条）。

**示例问法：** "帮我看看我跟张三的聊天记录"

### `send_email`
以用户身份给联系人发邮件。

**示例问法：** "帮我给张三发封邮件，问他上次说的项目进展怎么样了"

---

## SMTP 配置参考

### Gmail
- Host: `smtp.gmail.com`
- Port: `587`
- 需要开启"应用专用密码"（App Password）

### QQ 邮箱
- Host: `smtp.qq.com`
- Port: `465` 或 `587`
- 密码填"授权码"而非登录密码

---

## 数据库位置

`social-proxy.db` 在项目根目录，mcp-server 和 config-ui 共用同一个数据库文件。

可通过环境变量自定义路径：
```bash
DB_PATH=/custom/path/social-proxy.db node dist/index.js
```
