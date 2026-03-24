import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Social Proxy 配置',
  description: '配置微信数据导入、联系人邮箱、SMTP 和 agent 安装',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
