#!/usr/bin/env node
"use strict";
// Social Proxy Terminal
//
// socialproxy-terminal              → 登录 + 注册 + 启动后台 daemon
// socialproxy-terminal send "消息"  → 发一条消息到 Web 端
// socialproxy-terminal status       → 查看连接状态
// socialproxy-terminal stop         → 停止 daemon
// socialproxy-terminal logout       → 停止 + 清除凭证
// socialproxy-terminal _daemon      → 内部：daemon 进程入口
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const auth_1 = require("./auth");
const terminal_1 = require("./terminal");
const daemon_1 = require("./daemon");
const logger_1 = require("./logger");
const VERSION = '0.1.0';
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    // 内部命令：daemon 进程入口（不打印 header）
    if (command === '_daemon') {
        const config = (0, config_1.readConfig)();
        if (!config)
            process.exit(1);
        (0, daemon_1.startDaemon)(config);
        return;
    }
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
        case 'stop':
            handleStop();
            break;
        case 'logout':
            handleLogout();
            break;
        case 'help':
        case '--help':
        case '-h':
            printHelp();
            break;
        default:
            await handleStart();
            break;
    }
}
// ── 主流程：登录 + 注册 + 启动 daemon ──
async function handleStart() {
    let config = (0, config_1.readConfig)();
    if (!config) {
        // 首次：授权 + 注册
        const auth = await (0, auth_1.deviceAuth)();
        (0, logger_1.log)('注册终端...');
        config = await (0, terminal_1.registerTerminal)(auth.token);
        (0, logger_1.success)(`终端：${config.name}`);
    }
    else {
        (0, logger_1.success)(`${config.email} | ${config.name}`);
    }
    // 检查 daemon 是否已在运行
    const { running, pid } = (0, daemon_1.isDaemonRunning)();
    if (running) {
        (0, logger_1.success)(`daemon 已在运行 (PID ${pid})`);
        console.log('');
        (0, logger_1.dim)('终端已连接，你可以正常使用终端。');
        (0, logger_1.dim)('Web 端发来的命令会自动执行。');
        console.log('');
        (0, logger_1.dim)(`发消息: socialproxy-terminal send "内容"`);
        (0, logger_1.dim)(`状  态: socialproxy-terminal status`);
        (0, logger_1.dim)(`停  止: socialproxy-terminal stop`);
        return;
    }
    // 启动 daemon
    const daemonPid = (0, daemon_1.spawnDaemon)(config);
    if (daemonPid) {
        (0, logger_1.success)(`daemon 已启动 (PID ${daemonPid})`);
    }
    else {
        (0, logger_1.error)('daemon 启动失败');
        process.exit(1);
    }
    console.log('');
    (0, logger_1.success)('终端已连接！你可以正常使用终端。');
    console.log('');
    (0, logger_1.dim)('Web 端发来的命令会在后台自动执行，结果回传到 Web。');
    console.log('');
    (0, logger_1.dim)(`发消息给 Web:  socialproxy-terminal send "部署完成"`);
    (0, logger_1.dim)(`管道发送:      echo "告警" | socialproxy-terminal send`);
    (0, logger_1.dim)(`查看状态:      socialproxy-terminal status`);
    (0, logger_1.dim)(`停止连接:      socialproxy-terminal stop`);
    console.log('');
}
// ── 发送消息 ──
async function handleSend(args) {
    const config = (0, config_1.readConfig)();
    if (!config) {
        (0, logger_1.error)('未连接，请先运行 socialproxy-terminal');
        process.exit(1);
    }
    let content;
    if (args.length > 0) {
        content = args.join(' ');
    }
    else if (!process.stdin.isTTY) {
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk.toString());
        }
        content = chunks.join('').trim();
    }
    else {
        (0, logger_1.error)('用法: socialproxy-terminal send "消息内容"');
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
// ── 状态 ──
function handleStatus() {
    const config = (0, config_1.readConfig)();
    if (!config) {
        (0, logger_1.dim)('未连接。运行 socialproxy-terminal 开始。');
        return;
    }
    (0, logger_1.success)(`已连接: ${config.email}`);
    (0, logger_1.log)(`终端: ${config.name}`);
    const { running, pid } = (0, daemon_1.isDaemonRunning)();
    if (running) {
        (0, logger_1.success)(`daemon 运行中 (PID ${pid})`);
    }
    else {
        (0, logger_1.dim)('daemon 未运行。运行 socialproxy-terminal 启动。');
    }
}
// ── 停止 ──
function handleStop() {
    if ((0, daemon_1.stopDaemon)()) {
        (0, logger_1.success)('daemon 已停止');
    }
    else {
        (0, logger_1.dim)('daemon 未在运行');
    }
}
// ── 登出 ──
function handleLogout() {
    (0, daemon_1.stopDaemon)();
    const config = (0, config_1.readConfig)();
    if (config) {
        (0, config_1.clearConfig)();
        (0, logger_1.success)(`已断开 (${config.name})`);
    }
    else {
        (0, logger_1.dim)('未连接');
    }
}
// ── 帮助 ──
function printHelp() {
    console.log('  用法:');
    console.log('');
    (0, logger_1.dim)('  socialproxy-terminal              连接终端（首次需授权，之后自动启动 daemon）');
    (0, logger_1.dim)('  socialproxy-terminal send "消息"   发送消息到 Web 端');
    (0, logger_1.dim)('  socialproxy-terminal status        查看连接状态');
    (0, logger_1.dim)('  socialproxy-terminal stop          停止后台 daemon');
    (0, logger_1.dim)('  socialproxy-terminal logout        断开连接并清除凭证');
    console.log('');
    console.log('  管道:');
    (0, logger_1.dim)('  echo "部署完成" | socialproxy-terminal send');
    (0, logger_1.dim)('  cat log.txt | socialproxy-terminal send');
    console.log('');
    console.log('  Web 端发给终端的消息会被当作命令执行，结果自动回传。');
}
main().catch(err => {
    (0, logger_1.error)(err.message || String(err));
    process.exit(1);
});
