// 终端注册 + 消息发送
import * as os from 'os'
import { httpGet, httpPost } from './http'
import { TerminalConfig, writeConfig } from './config'

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
    terminalId: data.terminal_id || data.terminalId,
    channelId: data.channel_id || data.channelId,
    threadId: data.thread_id || data.threadId,
    name,
    createdAt: new Date().toISOString(),
  }

  writeConfig(config)
  return config
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
