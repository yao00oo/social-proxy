// 持久 Shell — 用 child_process.spawn 替代 node-pty（兼容性更好）
import * as os from 'os'
import { spawn, ChildProcess } from 'child_process'

const ANSI_RE = /\x1B(?:\[[0-9;]*[a-zA-Z]|\].*?\x07|\(B)/g
function stripAnsi(s: string): string { return s.replace(ANSI_RE, '') }

export interface PtyShellOptions {
  onFlush: (output: string) => Promise<void>
  onExit?: (code: number, signal: number) => void
}

export class PtyShell {
  private proc: ChildProcess
  private buffer = ''
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private onFlush: (output: string) => Promise<void>
  private onExitCb?: (code: number, signal: number) => void
  private dead = false

  private static IDLE_MS = 500
  private static MAX_MS = 5000
  private static MAX_BUF = 8000

  constructor(opts: PtyShellOptions) {
    this.onFlush = opts.onFlush
    this.onExitCb = opts.onExit

    const shell = process.env.SHELL || '/bin/bash'
    this.proc = spawn(shell, ['-i'], {
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'dumb', PS1: '$ ' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString()
      this.resetIdleTimer()
      if (this.buffer.length >= PtyShell.MAX_BUF) this.flush()
    })

    this.proc.stderr?.on('data', (data: Buffer) => {
      this.buffer += data.toString()
      this.resetIdleTimer()
      if (this.buffer.length >= PtyShell.MAX_BUF) this.flush()
    })

    this.proc.on('exit', (code, signal) => {
      this.dead = true
      this.flush()
      this.onExitCb?.(code ?? 0, typeof signal === 'number' ? signal : 0)
    })
  }

  write(command: string) {
    if (this.dead) return
    this.proc.stdin?.write(command + '\n')

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

    let clean = stripAnsi(raw).trim()
    if (!clean) return
    if (clean.length > 8000) clean = clean.slice(0, 8000) + '\n...(已截断)'

    this.onFlush(clean).catch(() => {})
  }
}
