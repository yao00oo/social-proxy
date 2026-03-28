#!/usr/bin/env node
// Social Proxy MCP Server — CLI Setup
// 独立脚本：检测平台、浏览器授权获取 DATABASE_URL、自动配置 MCP

import { execSync, exec } from 'child_process'
import * as https from 'https'
import * as readline from 'readline'
import * as crypto from 'crypto'

// ── 工具函数 ──────────────────────────────────────────

function print(msg: string) {
  process.stdout.write(msg + '\n')
}

function printError(msg: string) {
  process.stderr.write(msg + '\n')
}

function question(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function openBrowser(url: string) {
  try {
    if (process.platform === 'darwin') {
      exec(`open "${url}"`)
    } else if (process.platform === 'win32') {
      exec(`start "${url}"`)
    } else {
      exec(`xdg-open "${url}"`)
    }
  } catch {
    print(`  请手动打开浏览器访问: ${url}`)
  }
}

function httpsGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function testDatabaseUrl(databaseUrl: string): Promise<boolean> {
  // 简单测试：尝试用 neon serverless 连接
  // 由于不想引入额外依赖，我们用 https 请求 neon 的 SQL-over-HTTP 接口
  const url = new URL(databaseUrl)
  const host = url.hostname

  return new Promise((resolve) => {
    const postData = JSON.stringify({ query: 'SELECT 1 as ok', params: [] })
    const req = https.request(
      {
        hostname: host,
        path: '/sql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Neon-Connection-String': databaseUrl,
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          resolve(res.statusCode === 200)
        })
      }
    )
    req.on('error', () => resolve(false))
    req.write(postData)
    req.end()
  })
}

// ── 平台检测 ──────────────────────────────────────────

type Platform = 'claude-code' | 'openclaw' | 'cursor' | 'other'

async function detectPlatform(): Promise<Platform> {
  print('\n🔍 检测运行环境...')

  if (commandExists('claude')) {
    print('  ✅ 检测到 Claude Code')
    return 'claude-code'
  }

  if (commandExists('openclaw')) {
    print('  ✅ 检测到 OpenClaw')
    return 'openclaw'
  }

  print('  未自动检测到已知平台。')
  print('  支持的平台:')
  print('    1) Claude Code')
  print('    2) OpenClaw')
  print('    3) Cursor')
  print('    4) 其他')

  const choice = await question('  请选择 (1-4): ')
  switch (choice) {
    case '1': return 'claude-code'
    case '2': return 'openclaw'
    case '3': return 'cursor'
    default: return 'other'
  }
}

// ── 获取 DATABASE_URL ────────────────────────────────

async function getDatabaseUrl(): Promise<string> {
  print('\n🔑 获取数据库连接...')
  print('  将打开浏览器进行授权，请在 botook.ai 上登录并确认。\n')

  const sessionId = crypto.randomBytes(16).toString('hex')
  const connectUrl = `https://botook.ai/connect?cli=1&session=${sessionId}`

  print(`  正在打开浏览器...`)
  openBrowser(connectUrl)
  print(`  如果浏览器没有自动打开，请手动访问:`)
  print(`  ${connectUrl}\n`)

  const code = await question('  请在浏览器中点击确认，然后输入显示的授权码: ')

  if (!code || code.length < 4) {
    print('\n  ⚠️  授权码格式不正确。')
    return await manualDatabaseUrl()
  }

  print('  正在验证授权码...')

  try {
    const res = await httpsGet(`https://botook.ai/api/connect?code=${encodeURIComponent(code)}&session=${sessionId}`)

    if (res.status === 200) {
      const data = JSON.parse(res.body)
      if (data.database_url) {
        print('  ✅ 授权成功！')
        return data.database_url
      }
    }

    print(`\n  ❌ 授权失败（HTTP ${res.status}）`)
  } catch (e: any) {
    print(`\n  ❌ 网络错误: ${e.message}`)
  }

  return await manualDatabaseUrl()
}

async function manualDatabaseUrl(): Promise<string> {
  print('\n  请手动输入 DATABASE_URL:')
  print('  （可在 https://botook.ai/settings 页面的"开发者"部分找到）\n')

  const url = await question('  DATABASE_URL: ')
  if (!url) {
    print('  ❌ 未提供 DATABASE_URL，退出。')
    process.exit(1)
  }
  return url
}

// ── 配置平台 ──────────────────────────────────────────

async function configurePlatform(platform: Platform, databaseUrl: string) {
  print('\n⚙️  配置 MCP Server...')

  switch (platform) {
    case 'claude-code': {
      try {
        // 先尝试移除已有的（忽略错误）
        try {
          execSync('claude mcp remove social-proxy', { stdio: 'ignore' })
        } catch {}

        const cmd = `claude mcp add social-proxy -e DATABASE_URL=${databaseUrl} -- npx social-proxy-mcp`
        execSync(cmd, { stdio: 'inherit' })
        print('\n  ✅ 已添加到 Claude Code！')
        print('  重启 Claude Code 后即可使用 social-proxy 工具。')
      } catch (e: any) {
        print(`\n  ❌ 自动配置失败: ${e.message}`)
        printManualInstructions(databaseUrl)
      }
      break
    }

    case 'openclaw': {
      try {
        try {
          execSync('openclaw mcp remove social-proxy', { stdio: 'ignore' })
        } catch {}

        const cmd = `openclaw mcp add social-proxy -e DATABASE_URL=${databaseUrl} -- npx social-proxy-mcp`
        execSync(cmd, { stdio: 'inherit' })
        print('\n  ✅ 已添加到 OpenClaw！')
        print('  重启 OpenClaw 后即可使用 social-proxy 工具。')
      } catch (e: any) {
        print(`\n  ❌ 自动配置失败: ${e.message}`)
        printManualInstructions(databaseUrl)
      }
      break
    }

    case 'cursor': {
      print('\n  Cursor 需要手动配置 MCP Server。')
      print('  请在 Cursor Settings → MCP 中添加以下配置:\n')
      print('  ┌─────────────────────────────────────────┐')
      print('  │ Name:    social-proxy                    │')
      print('  │ Command: npx social-proxy-mcp            │')
      print('  │ Env:     DATABASE_URL=' + databaseUrl.slice(0, 30) + '...')
      print('  └─────────────────────────────────────────┘')
      print('\n  或在 .cursor/mcp.json 中添加:')
      print(JSON.stringify({
        mcpServers: {
          'social-proxy': {
            command: 'npx',
            args: ['social-proxy-mcp'],
            env: { DATABASE_URL: databaseUrl },
          },
        },
      }, null, 2))
      break
    }

    default: {
      printManualInstructions(databaseUrl)
      break
    }
  }
}

function printManualInstructions(databaseUrl: string) {
  print('\n  请在你的 AI 编辑器中手动配置 MCP Server:')
  print('\n  配置信息:')
  print(`    命令:        npx social-proxy-mcp`)
  print(`    环境变量:    DATABASE_URL=${databaseUrl}`)
  print('\n  JSON 配置（适用于大多数工具）:')
  print(JSON.stringify({
    'social-proxy': {
      command: 'npx',
      args: ['social-proxy-mcp'],
      env: { DATABASE_URL: databaseUrl },
    },
  }, null, 2))
}

// ── 验证连接 ──────────────────────────────────────────

async function verifyConnection(databaseUrl: string): Promise<boolean> {
  print('\n🔗 验证数据库连接...')

  try {
    const ok = await testDatabaseUrl(databaseUrl)
    if (ok) {
      print('  ✅ 数据库连接成功！')
      return true
    } else {
      print('  ⚠️  无法验证连接（可能是网络原因），但配置已保存。')
      print('  启动 MCP Server 时会再次尝试连接。')
      return false
    }
  } catch (e: any) {
    print(`  ⚠️  连接测试出错: ${e.message}`)
    print('  配置已保存，启动时会再次尝试。')
    return false
  }
}

// ── 主流程 ──────────────────────────────────────────

export async function runSetup() {
  print('╔══════════════════════════════════════════╗')
  print('║   Social Proxy MCP Server — 初始设置     ║')
  print('╚══════════════════════════════════════════╝')

  // 1. 检测平台
  const platform = await detectPlatform()

  // 2. 获取 DATABASE_URL
  const databaseUrl = await getDatabaseUrl()

  // 3. 验证连接
  await verifyConnection(databaseUrl)

  // 4. 配置平台
  await configurePlatform(platform, databaseUrl)

  print('\n────────────────────────────────────────────')
  print('🎉 设置完成！')
  print('')
  print('可用的工具:')
  print('  • get_contacts    — 获取联系人列表')
  print('  • get_history     — 获取聊天记录')
  print('  • get_summaries   — 获取会话摘要')
  print('  • search_messages — 搜索消息')
  print('  • send_email      — 发送邮件')
  print('  • get_new_messages — 获取新消息')
  print('  ...等更多工具')
  print('')
  print('如需重新配置，请运行: npx social-proxy-mcp setup')
  print('────────────────────────────────────────────\n')
}

// 当直接运行此文件时
if (require.main === module) {
  runSetup().catch((err) => {
    printError(`设置失败: ${err.message}`)
    process.exit(1)
  })
}
