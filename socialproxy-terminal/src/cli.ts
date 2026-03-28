#!/usr/bin/env node

// Social Proxy Terminal
//
// socialproxy-terminal              → 登录 + 注册 + 启动后台 daemon
// socialproxy-terminal send "消息"  → 发一条消息到 Web 端
// socialproxy-terminal status       → 查看连接状态
// socialproxy-terminal stop         → 停止 daemon
// socialproxy-terminal logout       → 停止 + 清除凭证
// socialproxy-terminal _daemon      → 内部：daemon 进程入口

import { readConfig, clearConfig } from './config'
import { deviceAuth } from './auth'
import { registerTerminal, sendMessage } from './terminal'
import { isDaemonRunning, stopDaemon, spawnDaemon, startDaemon } from './daemon'
import { log, success, error, bold, dim } from './logger'

const VERSION = '0.1.0'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  // 内部命令：daemon 进程入口（不打印 header）
  if (command === '_daemon') {
    const config = readConfig()
    if (!config) process.exit(1)
    startDaemon(config)
    return
  }

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
    case 'stop':
      handleStop()
      break
    case 'logout':
      handleLogout()
      break
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      await handleStart()
      break
  }
}

// ── 主流程：登录 + 注册 + 启动 daemon ──
async function handleStart() {
  let config = readConfig()

  if (!config) {
    // 首次：授权 + 注册
    const auth = await deviceAuth()
    log('注册终端...')
    config = await registerTerminal(auth.token)
    success(`终端：${config.name}`)
  } else {
    // 每次启动都重新注册，确保拿到最新 thread_id
    config = await registerTerminal(config.token)
    success(`${config.email} | ${config.name}`)
  }

  // 如果 daemon 已在运行，先停掉再重启（确保用最新 config）
  const { running } = isDaemonRunning()
  if (running) {
    stopDaemon()
  }

  // 启动 daemon
  const daemonPid = spawnDaemon(config)
  if (daemonPid) {
    success(`daemon 已启动 (PID ${daemonPid})`)
  } else {
    error('daemon 启动失败')
    process.exit(1)
  }

  console.log('')
  success('终端已连接！你可以正常使用终端。')
  console.log('')
  dim('Web 端发来的命令会在后台自动执行，结果回传到 Web。')
  console.log('')
  dim(`发消息给 Web:  socialproxy-terminal send "部署完成"`)
  dim(`管道发送:      echo "告警" | socialproxy-terminal send`)
  dim(`查看状态:      socialproxy-terminal status`)
  dim(`停止连接:      socialproxy-terminal stop`)
  console.log('')
}

// ── 发送消息 ──
async function handleSend(args: string[]) {
  const config = readConfig()
  if (!config) {
    error('未连接，请先运行 socialproxy-terminal')
    process.exit(1)
  }

  let content: string

  if (args.length > 0) {
    content = args.join(' ')
  } else if (!process.stdin.isTTY) {
    const chunks: string[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk.toString())
    }
    content = chunks.join('').trim()
  } else {
    error('用法: socialproxy-terminal send "消息内容"')
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

// ── 状态 ──
function handleStatus() {
  const config = readConfig()
  if (!config) {
    dim('未连接。运行 socialproxy-terminal 开始。')
    return
  }

  success(`已连接: ${config.email}`)
  log(`终端: ${config.name}`)

  const { running, pid } = isDaemonRunning()
  if (running) {
    success(`daemon 运行中 (PID ${pid})`)
  } else {
    dim('daemon 未运行。运行 socialproxy-terminal 启动。')
  }
}

// ── 停止 ──
function handleStop() {
  if (stopDaemon()) {
    success('daemon 已停止')
  } else {
    dim('daemon 未在运行')
  }
}

// ── 登出 ──
function handleLogout() {
  stopDaemon()
  const config = readConfig()
  if (config) {
    clearConfig()
    success(`已断开 (${config.name})`)
  } else {
    dim('未连接')
  }
}

// ── 帮助 ──
function printHelp() {
  console.log('  用法:')
  console.log('')
  dim('  socialproxy-terminal              连接终端（首次需授权，之后自动启动 daemon）')
  dim('  socialproxy-terminal send "消息"   发送消息到 Web 端')
  dim('  socialproxy-terminal status        查看连接状态')
  dim('  socialproxy-terminal stop          停止后台 daemon')
  dim('  socialproxy-terminal logout        断开连接并清除凭证')
  console.log('')
  console.log('  管道:')
  dim('  echo "部署完成" | socialproxy-terminal send')
  dim('  cat log.txt | socialproxy-terminal send')
  console.log('')
  console.log('  Web 端发给终端的消息会被当作命令执行，结果自动回传。')
}

main().catch(err => {
  error(err.message || String(err))
  process.exit(1)
})
