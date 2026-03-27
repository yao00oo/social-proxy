# Social Proxy — 开发计划

## Phase 1：飞书功能完善（当前）

- [ ] 🔴 飞书 p2p 单聊同步（listChats 不返回单聊，需用搜索 API 发现 chat_id）
- [ ] 🔴 飞书同步适配新数据模型（channels/threads/contact_identities 替代旧表）
- [ ] 🟡 Markdown 渲染（小林回复含 Markdown，前端需渲染）
- [ ] 🟡 Draft Card 可靠性（DeepSeek 的草稿标记有时被跳过）
- [x] ✅ 飞书消息同步（增量、续传、进度、限流）
- [x] ✅ 飞书文档同步（递归遍历 + docx 内容提取）
- [x] ✅ 飞书发送者姓名（open_id 查表）
- [x] ✅ 飞书引导式配置教程（6 步）
- [x] ✅ 同步进度显示（主页进度条 + 设置页日志）
- [x] ✅ 同步状态（syncing/paused/error/completed）

## Phase 2：更多数据源

- [ ] 🟡 Gmail 同步（OAuth + 收发件 + 适配新模型）
- [ ] 🟡 微信记录导入（后端已有，需验证 PG 版本）
- [ ] 🟢 IMAP 邮件同步
- [ ] 🟢 通用聊天记录导入（任意 IM 文本文件）
- [ ] 🟢 Google Drive 文档同步

## Phase 3：体验优化

- [ ] 🟡 对话历史持久化（conversations 表已建，前端未接）
- [ ] 🟡 聊天记录分页（上滑加载更多）
- [ ] 🟡 搜索联动（人名 + 消息内容联合搜索）
- [ ] 🟡 未读消息正确标记（点击后消除）
- [ ] 🟢 移动端适配
- [ ] 🟢 AI 模型选择（settings 页切换）
- [ ] 🟢 联系人合并（跨平台同一人合并）

## Phase 4：架构升级

- [ ] 🟢 统一数据模型迁移（旧表 → channels/threads/messages 新架构）
- [ ] 🟢 时间字段统一为 timestamptz
- [ ] 🟢 Vercel Cron 定时同步（替代手动点同步）
- [ ] 🟢 飞书商店应用审核（ISV 模式，用户一键授权）

---

🔴 高优先级 | 🟡 中优先级 | 🟢 低优先级
