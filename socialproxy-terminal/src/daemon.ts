// 后台 daemon — 轮询消息 + 执行命令 + 回传结果
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { httpGet, httpPost } from './http'
import { TerminalConfig } from './config'

const PID_FILE = path.join(os.homedir(), '.socialproxy', 'daemon.pid')
const LOG_FILE = path.join(os.homedir(), '.socialproxy', 'daemon.log')
const POLL_INTERVAL = 3000

// ── 安全检查 ──
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /mkfs/,
  /dd\s+if=/,
  /:()\s*\{/,
  />\s*\/dev\/sd/,
]

function isSafe(cmd: string): boolean {
  return !BLOCKED_PATTERNS.some(p => p.test(cmd))
}

// ── 日志 ──
function daemonLog(msg: string) {
  const line = `[${new Date().toISOString().slice(0, 19)}] ${msg}\n`
  try { fs.appendFileSync(LOG_FILE, line) } catch {}
}

// ── 执行命令 ──
function executeCommand(cmd: string): string {
  if (!isSafe(cmd)) {
    return `❌ 危险命令已拒绝: ${cmd}`
  }

  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'dumb' },
    }).trim()
    return output || '(无输出)'
  } catch (err: any) {
    return `❌ ${err.stderr?.trim() || err.message || '执行失败'}`
  }
}

// ── 轮询 + 执行循环 ──
async function pollLoop(config: TerminalConfig) {
  // 启动时先获取当前最新消息 ID，跳过所有历史消息
  let lastId = 0
  try {
    const { status, body } = await httpGet(
      `/api/terminal/poll?thread_id=${config.threadId}&after=0`,
      config.token,
    )
    if (status === 200) {
      const msgs = JSON.parse(body).messages || []
      if (msgs.length > 0) {
        lastId = Math.max(...msgs.map((m: any) => m.id))
      }
    }
  } catch {}
  daemonLog(`daemon started, thread=${config.threadId}, lastId=${lastId}`)

  while (true) {
    try {
      const { status, body } = await httpGet(
        `/api/terminal/poll?thread_id=${config.threadId}&after=${lastId}`,
        config.token,
      )

      if (status === 200) {
        const data = JSON.parse(body)
        const messages = data.messages || []

        for (const msg of messages) {
          lastId = Math.max(lastId, msg.id)

          // 只处理"收到的"消息（从 Web 端发给终端的），跳过自己发的
          if (msg.direction !== 'received') {
            lastId = Math.max(lastId, msg.id)
            continue
          }

          const content = msg.content?.trim()
          if (!content) continue

          daemonLog(`recv: ${content}`)

          // 执行命令
          const result = executeCommand(content)
          daemonLog(`exec result: ${result.slice(0, 200)}`)

          // 回传结果（截断过长输出）
          const truncated = result.length > 8000
            ? result.slice(0, 8000) + '\n...(输出已截断，共 ' + result.length + ' 字符)'
            : result

          await httpPost('/api/terminal/send', {
            thread_id: config.threadId,
            content: truncated,
            from: 'terminal',
          }, config.token)
        }
      }
    } catch (err: any) {
      daemonLog(`poll error: ${err.message}`)
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }
}

// ── 启动 daemon ──
export function startDaemon(config: TerminalConfig) {
  // 写 PID 文件
  const dir = path.dirname(PID_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(PID_FILE, String(process.pid))

  // 清理
  const cleanup = () => {
    try { fs.unlinkSync(PID_FILE) } catch {}
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  // 开始轮询
  pollLoop(config).catch(err => {
    daemonLog(`fatal: ${err.message}`)
    cleanup()
  })
}

// ── 检查 daemon 状态 ──
export function isDaemonRunning(): { running: boolean; pid?: number } {
  if (!fs.existsSync(PID_FILE)) return { running: false }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim())
  try {
    process.kill(pid, 0)
    return { running: true, pid }
  } catch {
    // 进程不存在，清理 stale PID 文件
    try { fs.unlinkSync(PID_FILE) } catch {}
    return { running: false }
  }
}

// ── 停止 daemon ──
export function stopDaemon(): boolean {
  const { running, pid } = isDaemonRunning()
  if (!running || !pid) return false

  try {
    process.kill(pid, 'SIGTERM')
    try { fs.unlinkSync(PID_FILE) } catch {}
    return true
  } catch {
    return false
  }
}

// ── 以 detached 子进程启动 daemon ──
export function spawnDaemon(config: TerminalConfig): number | null {
  const { spawn } = require('child_process')
  const cliPath = path.join(__dirname, 'cli.js')

  const child = spawn(process.execPath, [cliPath, '_daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  })

  child.unref()
  return child.pid || null
}
