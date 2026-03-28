"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTerminal = registerTerminal;
exports.pollMessages = pollMessages;
exports.sendMessage = sendMessage;
exports.startREPL = startREPL;
// 终端双向通信 — 注册、轮询、发送、交互式 REPL
const os = __importStar(require("os"));
const readline = __importStar(require("readline"));
const http_1 = require("./http");
const config_1 = require("./config");
const logger_1 = require("./logger");
// ── 注册终端 ──
async function registerTerminal(token) {
    const name = `${os.userInfo().username} 的 ${os.hostname().replace('.local', '')}`;
    const { status, body } = await (0, http_1.httpPost)('/api/terminal/connect', {
        name,
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
    }, token);
    if (status !== 200 && status !== 201) {
        throw new Error(`注册终端失败 (${status}): ${body}`);
    }
    const data = JSON.parse(body);
    const config = {
        token,
        email: data.email || '',
        terminalId: data.terminalId || data.terminal_id,
        channelId: data.channelId || data.channel_id,
        threadId: data.threadId || data.thread_id,
        name,
        createdAt: new Date().toISOString(),
    };
    (0, config_1.writeConfig)(config);
    return config;
}
async function pollMessages(token, threadId, lastId) {
    try {
        const { status, body } = await (0, http_1.httpGet)(`/api/terminal/poll?thread_id=${threadId}&after=${lastId}`, token);
        if (status === 200) {
            const data = JSON.parse(body);
            return data.messages || [];
        }
        if (status === 204)
            return []; // no new messages
        return [];
    }
    catch {
        return []; // network error, retry next cycle
    }
}
// ── 发送消息 ──
async function sendMessage(token, threadId, content) {
    try {
        const { status } = await (0, http_1.httpPost)('/api/terminal/send', {
            thread_id: threadId,
            content,
        }, token);
        return status === 200 || status === 201;
    }
    catch {
        return false;
    }
}
// ── 交互式 REPL ──
async function startREPL(config) {
    const { token, threadId, name } = config;
    (0, logger_1.divider)();
    (0, logger_1.dim)('输入消息发给小林 | 远程命令会显示在这里');
    (0, logger_1.dim)('输入 /help 查看命令 | Ctrl+C 退出');
    (0, logger_1.divider)();
    let lastMsgId = 0;
    let running = true;
    // 轮询新消息
    const pollLoop = async () => {
        while (running) {
            try {
                const msgs = await pollMessages(token, threadId, lastMsgId);
                for (const msg of msgs) {
                    if (msg.direction === 'received') {
                        // 这是从 Web/其他端发给终端的消息
                        (0, logger_1.incoming)('远程', msg.content);
                        // 如果是可执行命令，处理它
                        if (msg.msg_type === 'command' || msg.metadata?.executable) {
                            await handleRemoteCommand(token, threadId, msg.content);
                        }
                    }
                    else if (msg.sender_name && msg.sender_name !== name) {
                        // AI 或其他人的回复
                        (0, logger_1.incoming)(msg.sender_name || '小林', msg.content);
                    }
                    lastMsgId = Math.max(lastMsgId, msg.id);
                }
            }
            catch {
                // 静默重试
            }
            await sleep(3000);
        }
    };
    // 启动轮询
    pollLoop();
    // 读取用户输入
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '\n  > ',
    });
    rl.prompt();
    rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            return;
        }
        // 内置命令
        if (input === '/help') {
            console.log('');
            (0, logger_1.dim)('/help     显示帮助');
            (0, logger_1.dim)('/status   查看连接状态');
            (0, logger_1.dim)('/name     修改终端名称');
            (0, logger_1.dim)('/logout   断开连接');
            (0, logger_1.dim)('/quit     退出');
            console.log('');
            (0, logger_1.dim)('直接输入文字 → 发送给小林');
            rl.prompt();
            return;
        }
        if (input === '/status') {
            (0, logger_1.success)(`已连接: ${config.email}`);
            (0, logger_1.log)(`终端: ${config.name}`);
            (0, logger_1.log)(`ID: ${config.terminalId}`);
            rl.prompt();
            return;
        }
        if (input === '/quit' || input === '/exit') {
            running = false;
            rl.close();
            process.exit(0);
        }
        if (input === '/logout') {
            const { clearConfig } = await Promise.resolve().then(() => __importStar(require('./config')));
            clearConfig();
            (0, logger_1.success)('已断开连接');
            running = false;
            rl.close();
            process.exit(0);
        }
        // 发送消息
        const ok = await sendMessage(token, threadId, input);
        if (!ok) {
            (0, logger_1.error)('发送失败，请检查网络');
        }
        rl.prompt();
    });
    rl.on('close', () => {
        running = false;
        process.exit(0);
    });
    // Ctrl+C
    process.on('SIGINT', () => {
        running = false;
        console.log('\n');
        (0, logger_1.dim)('已断开');
        process.exit(0);
    });
}
// ── 处理远程命令 ──
async function handleRemoteCommand(token, threadId, command) {
    // 安全检查
    const dangerous = /rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|:(){ :|&&\s*rm/i;
    if (dangerous.test(command)) {
        (0, logger_1.warn)(`⚠️  危险命令已拒绝: ${command}`);
        await sendMessage(token, threadId, `❌ 终端拒绝执行危险命令: ${command}`);
        return;
    }
    (0, logger_1.dim)(`执行: ${command}`);
    try {
        const { execSync } = await Promise.resolve().then(() => __importStar(require('child_process')));
        const output = execSync(command, {
            encoding: 'utf-8',
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            cwd: os.homedir(),
        }).trim();
        const result = output || '(无输出)';
        // 截断过长输出
        const truncated = result.length > 4000 ? result.slice(0, 4000) + '\n...(已截断)' : result;
        await sendMessage(token, threadId, truncated);
        (0, logger_1.dim)(`→ 结果已回传`);
    }
    catch (err) {
        const errMsg = err.stderr || err.message || '执行失败';
        await sendMessage(token, threadId, `❌ ${errMsg}`);
        (0, logger_1.error)(`执行失败: ${errMsg.slice(0, 100)}`);
    }
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
