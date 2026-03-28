// PTY Shell 管理器 — 持久伪终端，缓冲输出
import * as os from 'os'
import * as pty from 'node-pty'

// ANSI 转义码正则
const ANSI_RE = /\x1B(?:\[[0-9;]*[a-zA-Z]|\].*?\x07|\(B)/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export interface PtyShellOptions {
  onFlush: (output: string) => Promise<void>
  onExit?: (code: number, signal: number) => void
}

export class PtyShell {
  private proc: pty.IPty
  private buffer = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private onFlush: (output: string) => Promise<void>
  private onExitCb?: (code: number, signal: number) => void
  private dead = false

  // 缓冲参数
  private static IDLE_MS = 300    // 无新输出 300ms 后 flush
  private static MAX_MS = 5000    // 最长 5 秒必须 flush
  private static MAX_BUF = 8000   // 缓冲超过 8KB 立即 flush

  constructor(opts: PtyShellOptions) {
    this.onFlush = opts.onFlush
    this.onExitCb = opts.onExit

    const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
    this.proc = pty.spawn(shell, [], {
      name: 'dumb',     // TERM=dumb，减少 ANSI 转义
      cols: 120,
      rows: 30,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'dumb' } as { [key: string]: string },
    })

    this.proc.onData((data: string) => {
      this.buffer += data
      this.resetIdleTimer()

      // 缓冲超限立即 flush
      if (this.buffer.length >= PtyShell.MAX_BUF) {
        this.flush()
      }
    })

    this.proc.onExit(({ exitCode, signal }) => {
      this.dead = true
      this.flush() // flush 残余
      this.onExitCb?.(exitCode ?? 0, signal ?? 0)
    })
  }

  write(command: string) {
    if (this.dead) return
    this.proc.write(command + '\r')

    // 启动 max timer（命令开始后最长 5 秒必须 flush 一次）
    if (!this.maxTimer) {
      this.maxTimer = setTimeout(() => {
        this.maxTimer = null
        if (this.buffer.length > 0) this.flush()
      }, PtyShell.MAX_MS)
    }
  }

  kill() {
    this.dead = true
    this.clearTimers()
    this.flush()
    try { this.proc.kill() } catch {}
  }

  get isAlive() { return !this.dead }

  private resetIdleTimer() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, PtyShell.IDLE_MS)
  }

  private clearTimers() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null }
  }

  private flush() {
    this.clearTimers()
    if (this.buffer.length === 0) return

    const raw = this.buffer
    this.buffer = ''

    // 清理 ANSI 转义码，截断过长输出
    let clean = stripAnsi(raw).trim()
    if (!clean) return

    if (clean.length > 8000) {
      clean = clean.slice(0, 8000) + '\n...(输出已截断)'
    }

    this.onFlush(clean).catch(() => {})
  }
}
