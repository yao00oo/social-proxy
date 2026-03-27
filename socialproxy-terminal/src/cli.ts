#!/usr/bin/env node

// Social Proxy Terminal — 入口
// npx socialproxy-terminal         → 登录 + 启动
// npx socialproxy-terminal send    → 发一条消息（脚本用）
// npx socialproxy-terminal status  → 查看状态
// npx socialproxy-terminal logout  → 断开连接

import { readConfig, clearConfig } from './config'
import { deviceAuth } from './auth'
import { registerTerminal, startREPL, sendMessage } from './terminal'
import { log, success, error, bold, dim } from './logger'

const VERSION = '0.1.0'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  // Header
  console.log('')
  bold(`Social Proxy Terminal v${VERSION}`)
  console.log('')

  switch (command) {
    case 'send':
      await handleSend(args.slice(1))
      break

    case 'status':
      handleStatus()
      break

    case 'logout':
      handleLogout()
      break

    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break

    case 'version':
    case '--version':
    case '-v':
      // already printed
      break

    default:
      await handleStart()
      break
  }
}

// ── 主流程：登录 + 注册终端 + 启动 REPL ──
async function handleStart() {
  let config = readConfig()

  if (config) {
    // 已有本地凭证，直接连接
    success(`${config.email} | ${config.name}`)
    await startREPL(config)
    return
  }

  // 首次使用：device code 授权
  const auth = await deviceAuth()

  // 注册终端
  log('注册终端...')
  config = await registerTerminal(auth.token)
  success(`终端：${config.name}`)

  // 启动 REPL
  await startREPL(config)
}

// ── 发送一条消息（脚本/管道用）──
async function handleSend(args: string[]) {
  const config = readConfig()
  if (!config) {
    error('未连接，请先运行 npx socialproxy-terminal 登录')
    process.exit(1)
  }

  let content: string

  if (args.length > 0) {
    // npx socialproxy-terminal send "消息内容"
    content = args.join(' ')
  } else if (!process.stdin.isTTY) {
    // echo "内容" | npx socialproxy-terminal send
    const chunks: string[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk.toString())
    }
    content = chunks.join('').trim()
  } else {
    error('请提供消息内容：npx socialproxy-terminal send "你的消息"')
    process.exit(1)
  }

  if (!content) {
    error('消息内容为空')
    process.exit(1)
  }

  const ok = await sendMessage(config.token, config.threadId, content)
  if (ok) {
    success('已发送')
  } else {
    error('发送失败')
    process.exit(1)
  }
}

// ── 查看状态 ──
function handleStatus() {
  const config = readConfig()
  if (config) {
    success(`已连接: ${config.email}`)
    log(`终端: ${config.name}`)
    log(`终端 ID: ${config.terminalId}`)
    log(`配置: ~/.socialproxy/terminal.json`)
  } else {
    dim('未连接')
    dim('运行 npx socialproxy-terminal 开始')
  }
}

// ── 断开连接 ──
function handleLogout() {
  const config = readConfig()
  if (!config) {
    dim('未连接')
    return
  }
  clearConfig()
  success(`已断开 (${config.name})`)
}

// ── 帮助 ──
function printHelp() {
  console.log('  用法:')
  console.log('')
  dim('  npx socialproxy-terminal              登录并启动终端')
  dim('  npx socialproxy-terminal send "消息"   发送一条消息')
  dim('  npx socialproxy-terminal status        查看连接状态')
  dim('  npx socialproxy-terminal logout        断开连接')
  console.log('')
  console.log('  管道:')
  dim('  echo "部署完成" | npx socialproxy-terminal send')
  dim('  cat log.txt | npx socialproxy-terminal send')
  console.log('')
  console.log('  REPL 内置命令:')
  dim('  /help     帮助')
  dim('  /status   状态')
  dim('  /logout   断开')
  dim('  /quit     退出')
}

main().catch(err => {
  error(err.message || String(err))
  process.exit(1)
})
