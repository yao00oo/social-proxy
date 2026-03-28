#!/usr/bin/env node
"use strict";
// Social Proxy Terminal — 入口
// npx socialproxy-terminal         → 登录 + 启动
// npx socialproxy-terminal send    → 发一条消息（脚本用）
// npx socialproxy-terminal status  → 查看状态
// npx socialproxy-terminal logout  → 断开连接
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const auth_1 = require("./auth");
const terminal_1 = require("./terminal");
const logger_1 = require("./logger");
const VERSION = '0.1.0';
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    // Header
    console.log('');
    (0, logger_1.bold)(`Social Proxy Terminal v${VERSION}`);
    console.log('');
    switch (command) {
        case 'send':
            await handleSend(args.slice(1));
            break;
        case 'status':
            handleStatus();
            break;
        case 'logout':
            handleLogout();
            break;
        case 'help':
        case '--help':
        case '-h':
            printHelp();
            break;
        case 'version':
        case '--version':
        case '-v':
            // already printed
            break;
        default:
            await handleStart();
            break;
    }
}
// ── 主流程：登录 + 注册终端 + 启动 REPL ──
async function handleStart() {
    let config = (0, config_1.readConfig)();
    if (config) {
        // 已有本地凭证，直接连接
        (0, logger_1.success)(`${config.email} | ${config.name}`);
        await (0, terminal_1.startREPL)(config);
        return;
    }
    // 首次使用：device code 授权
    const auth = await (0, auth_1.deviceAuth)();
    // 注册终端
    (0, logger_1.log)('注册终端...');
    config = await (0, terminal_1.registerTerminal)(auth.token);
    (0, logger_1.success)(`终端：${config.name}`);
    // 启动 REPL
    await (0, terminal_1.startREPL)(config);
}
// ── 发送一条消息（脚本/管道用）──
async function handleSend(args) {
    const config = (0, config_1.readConfig)();
    if (!config) {
        (0, logger_1.error)('未连接，请先运行 npx socialproxy-terminal 登录');
        process.exit(1);
    }
    let content;
    if (args.length > 0) {
        // npx socialproxy-terminal send "消息内容"
        content = args.join(' ');
    }
    else if (!process.stdin.isTTY) {
        // echo "内容" | npx socialproxy-terminal send
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk.toString());
        }
        content = chunks.join('').trim();
    }
    else {
        (0, logger_1.error)('请提供消息内容：npx socialproxy-terminal send "你的消息"');
        process.exit(1);
    }
    if (!content) {
        (0, logger_1.error)('消息内容为空');
        process.exit(1);
    }
    const ok = await (0, terminal_1.sendMessage)(config.token, config.threadId, content);
    if (ok) {
        (0, logger_1.success)('已发送');
    }
    else {
        (0, logger_1.error)('发送失败');
        process.exit(1);
    }
}
// ── 查看状态 ──
function handleStatus() {
    const config = (0, config_1.readConfig)();
    if (config) {
        (0, logger_1.success)(`已连接: ${config.email}`);
        (0, logger_1.log)(`终端: ${config.name}`);
        (0, logger_1.log)(`终端 ID: ${config.terminalId}`);
        (0, logger_1.log)(`配置: ~/.socialproxy/terminal.json`);
    }
    else {
        (0, logger_1.dim)('未连接');
        (0, logger_1.dim)('运行 npx socialproxy-terminal 开始');
    }
}
// ── 断开连接 ──
function handleLogout() {
    const config = (0, config_1.readConfig)();
    if (!config) {
        (0, logger_1.dim)('未连接');
        return;
    }
    (0, config_1.clearConfig)();
    (0, logger_1.success)(`已断开 (${config.name})`);
}
// ── 帮助 ──
function printHelp() {
    console.log('  用法:');
    console.log('');
    (0, logger_1.dim)('  npx socialproxy-terminal              登录并启动终端');
    (0, logger_1.dim)('  npx socialproxy-terminal send "消息"   发送一条消息');
    (0, logger_1.dim)('  npx socialproxy-terminal status        查看连接状态');
    (0, logger_1.dim)('  npx socialproxy-terminal logout        断开连接');
    console.log('');
    console.log('  管道:');
    (0, logger_1.dim)('  echo "部署完成" | npx socialproxy-terminal send');
    (0, logger_1.dim)('  cat log.txt | npx socialproxy-terminal send');
    console.log('');
    console.log('  REPL 内置命令:');
    (0, logger_1.dim)('  /help     帮助');
    (0, logger_1.dim)('  /status   状态');
    (0, logger_1.dim)('  /logout   断开');
    (0, logger_1.dim)('  /quit     退出');
}
main().catch(err => {
    (0, logger_1.error)(err.message || String(err));
    process.exit(1);
});
