"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
exports.success = success;
exports.error = error;
exports.warn = warn;
exports.dim = dim;
exports.bold = bold;
exports.incoming = incoming;
exports.divider = divider;
// 终端日志输出
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
function log(msg) { console.log(`  ${msg}`); }
function success(msg) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function error(msg) { console.error(`  ${RED}✗${RESET} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW}!${RESET} ${msg}`); }
function dim(msg) { console.log(`  ${DIM}${msg}${RESET}`); }
function bold(msg) { console.log(`  ${BOLD}${msg}${RESET}`); }
function incoming(from, content) {
    console.log(`\n  ${CYAN}[${from}]${RESET} ${content}`);
}
function divider() {
    console.log(`\n  ${'━'.repeat(40)}`);
}
