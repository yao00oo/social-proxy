// 终端双向通信 — 注册、轮询、发送、交互式 REPL
import * as os from 'os'
import * as readline from 'readline'
import { httpGet, httpPost } from './http'
import { TerminalConfig, writeConfig, readConfig } from './config'
import { log, success, error, incoming, divider, dim, warn } from './logger'

// ── 注册终端 ──
export async function registerTerminal(token: string): Promise<TerminalConfig> {
  const name = `${os.userInfo().username} 的 ${os.hostname().replace('.local', '')}`

  const { status, body } = await httpPost('/api/terminal/connect', {
    name,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
  }, token)

  if (status !== 200 && status !== 201) {
    throw new Error(`注册终端失败 (${status}): ${body}`)
  }

  const data = JSON.parse(body)
  const config: TerminalConfig = {
    token,
    email: data.email || '',
    terminalId: data.terminalId || data.terminal_id,
    channelId: data.channelId || data.channel_id,
    threadId: data.threadId || data.thread_id,
    name,
    createdAt: new Date().toISOString(),
  }

  writeConfig(config)
  return config
}

// ── 消息轮询 ──
interface Message {
  id: number
  content: string
  sender_name: string
  direction: string
  timestamp: string
  msg_type: string
  metadata?: any
}

export async function pollMessages(token: string, threadId: number, lastId: number): Promise<Message[]> {
  try {
    const { status, body } = await httpGet(
      `/api/terminal/poll?thread_id=${threadId}&after=${lastId}`,
      token,
    )
    if (status === 200) {
      const data = JSON.parse(body)
      return data.messages || []
    }
    if (status === 204) return [] // no new messages
    return []
  } catch {
    return [] // network error, retry next cycle
  }
}

// ── 发送消息 ──
export async function sendMessage(token: string, threadId: number, content: string): Promise<boolean> {
  try {
    const { status } = await httpPost('/api/terminal/send', {
      thread_id: threadId,
      content,
    }, token)
    return status === 200 || status === 201
  } catch {
    return false
  }
}

// ── 交互式 REPL ──
export async function startREPL(config: TerminalConfig) {
  const { token, threadId, name } = config

  divider()
  dim('输入消息发给小林 | 远程命令会显示在这里')
  dim('输入 /help 查看命令 | Ctrl+C 退出')
  divider()

  let lastMsgId = 0
  let running = true

  // 轮询新消息
  const pollLoop = async () => {
    while (running) {
      try {
        const msgs = await pollMessages(token, threadId, lastMsgId)
        for (const msg of msgs) {
          if (msg.direction === 'received') {
            // 这是从 Web/其他端发给终端的消息
            incoming('远程', msg.content)

            // 如果是可执行命令，处理它
            if (msg.msg_type === 'command' || msg.metadata?.executable) {
              await handleRemoteCommand(token, threadId, msg.content)
            }
          } else if (msg.sender_name && msg.sender_name !== name) {
            // AI 或其他人的回复
            incoming(msg.sender_name || '小林', msg.content)
          }
          lastMsgId = Math.max(lastMsgId, msg.id)
        }
      } catch {
        // 静默重试
      }
      await sleep(3000)
    }
  }

  // 启动轮询
  pollLoop()

  // 读取用户输入
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n  > ',
  })

  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) { rl.prompt(); return }

    // 内置命令
    if (input === '/help') {
      console.log('')
      dim('/help     显示帮助')
      dim('/status   查看连接状态')
      dim('/name     修改终端名称')
      dim('/logout   断开连接')
      dim('/quit     退出')
      console.log('')
      dim('直接输入文字 → 发送给小林')
      rl.prompt()
      return
    }

    if (input === '/status') {
      success(`已连接: ${config.email}`)
      log(`终端: ${config.name}`)
      log(`ID: ${config.terminalId}`)
      rl.prompt()
      return
    }

    if (input === '/quit' || input === '/exit') {
      running = false
      rl.close()
      process.exit(0)
    }

    if (input === '/logout') {
      const { clearConfig } = await import('./config')
      clearConfig()
      success('已断开连接')
      running = false
      rl.close()
      process.exit(0)
    }

    // 发送消息
    const ok = await sendMessage(token, threadId, input)
    if (!ok) {
      error('发送失败，请检查网络')
    }

    rl.prompt()
  })

  rl.on('close', () => {
    running = false
    process.exit(0)
  })

  // Ctrl+C
  process.on('SIGINT', () => {
    running = false
    console.log('\n')
    dim('已断开')
    process.exit(0)
  })
}

// ── 处理远程命令 ──
async function handleRemoteCommand(token: string, threadId: number, command: string) {
  // 安全检查
  const dangerous = /rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|:(){ :|&&\s*rm/i
  if (dangerous.test(command)) {
    warn(`⚠️  危险命令已拒绝: ${command}`)
    await sendMessage(token, threadId, `❌ 终端拒绝执行危险命令: ${command}`)
    return
  }

  dim(`执行: ${command}`)
  try {
    const { execSync } = await import('child_process')
    const output = execSync(command, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      cwd: os.homedir(),
    }).trim()

    const result = output || '(无输出)'
    // 截断过长输出
    const truncated = result.length > 4000 ? result.slice(0, 4000) + '\n...(已截断)' : result
    await sendMessage(token, threadId, truncated)
    dim(`→ 结果已回传`)
  } catch (err: any) {
    const errMsg = err.stderr || err.message || '执行失败'
    await sendMessage(token, threadId, `❌ ${errMsg}`)
    error(`执行失败: ${errMsg.slice(0, 100)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
