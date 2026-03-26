import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  // 让 Next.js 编译 mcp-server 下的文件，解决跨目录引用时 node_modules 找不到的问题
  transpilePackages: ['../mcp-server'],
}

export default nextConfig
