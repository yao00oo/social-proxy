// 终端日志输出
const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'

export function log(msg: string) { console.log(`  ${msg}`) }
export function success(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`) }
export function error(msg: string) { console.error(`  ${RED}✗${RESET} ${msg}`) }
export function warn(msg: string) { console.log(`  ${YELLOW}!${RESET} ${msg}`) }
export function dim(msg: string) { console.log(`  ${DIM}${msg}${RESET}`) }
export function bold(msg: string) { console.log(`  ${BOLD}${msg}${RESET}`) }
export function incoming(from: string, content: string) {
  console.log(`\n  ${CYAN}[${from}]${RESET} ${content}`)
}
export function divider() {
  console.log(`\n  ${'━'.repeat(40)}`)
}
