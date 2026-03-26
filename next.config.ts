import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // better-sqlite3 是原生 Node.js 模块，需要在服务端运行
  // 防止被打包进客户端 bundle
  serverExternalPackages: ['better-sqlite3'],
}

export default nextConfig
