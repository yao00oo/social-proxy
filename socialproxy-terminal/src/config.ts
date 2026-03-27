// 本地配置管理 — ~/.socialproxy/terminal.json
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const CONFIG_DIR = path.join(os.homedir(), '.socialproxy')
const CONFIG_FILE = path.join(CONFIG_DIR, 'terminal.json')

export interface TerminalConfig {
  token: string
  email: string
  terminalId: number
  channelId: number
  threadId: number
  name: string
  createdAt: string
}

function ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

export function readConfig(): TerminalConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
  } catch {
    return null
  }
}

export function writeConfig(config: TerminalConfig) {
  ensureDir()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

export function clearConfig() {
  try { fs.unlinkSync(CONFIG_FILE) } catch {}
}
