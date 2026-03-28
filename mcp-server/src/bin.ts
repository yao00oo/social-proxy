#!/usr/bin/env node
// Social Proxy MCP Server — CLI 入口
// npx social-proxy-mcp        → 启动 MCP Server
// npx social-proxy-mcp setup  → 运行设置向导

if (process.argv[2] === 'setup') {
  const { runSetup } = require('./cli-setup')
  runSetup()
    .then(() => process.exit(0))
    .catch((err: any) => {
      console.error('设置失败:', err)
      process.exit(1)
    })
} else {
  require('./index')
}
