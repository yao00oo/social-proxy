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
exports.startDaemon = startDaemon;
exports.isDaemonRunning = isDaemonRunning;
exports.stopDaemon = stopDaemon;
exports.spawnDaemon = spawnDaemon;
// 后台 daemon — 轮询消息 + PTY 执行 + 回传结果
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const http_1 = require("./http");
const pty_1 = require("./pty");
const PID_FILE = path.join(os.homedir(), '.socialproxy', 'daemon.pid');
const LOG_FILE = path.join(os.homedir(), '.socialproxy', 'daemon.log');
const POLL_INTERVAL = 3000;
// ── 安全检查 ──
const BLOCKED_PATTERNS = [
    /rm\s+-rf\s+\//,
    /mkfs/,
    /dd\s+if=/,
    /:()\s*\{/,
    />\s*\/dev\/sd/,
];
function isSafe(cmd) {
    return !BLOCKED_PATTERNS.some(p => p.test(cmd));
}
// ── 日志 ──
function daemonLog(msg) {
    const line = `[${new Date().toISOString().slice(0, 19)}] ${msg}\n`;
    try {
        fs.appendFileSync(LOG_FILE, line);
    }
    catch { }
}
// ── 轮询 + PTY 循环 ──
async function pollLoop(config) {
    // 启动时先获取当前最新消息 ID，跳过所有历史消息
    let lastId = 0;
    try {
        const { status, body } = await (0, http_1.httpGet)(`/api/terminal/poll?thread_id=${config.threadId}&after=0`, config.token);
        if (status === 200) {
            const msgs = JSON.parse(body).messages || [];
            if (msgs.length > 0) {
                lastId = Math.max(...msgs.map((m) => m.id));
            }
        }
    }
    catch { }
    // 创建持久 PTY shell
    const sendOutput = async (output) => {
        const truncated = output.length > 8000
            ? output.slice(0, 8000) + '\n...(输出已截断，共 ' + output.length + ' 字符)'
            : output;
        try {
            await (0, http_1.httpPost)('/api/terminal/send', {
                thread_id: config.threadId,
                content: truncated,
                from: 'terminal',
            }, config.token);
        }
        catch (err) {
            daemonLog(`send error: ${err.message}`);
        }
    };
    let ptyShell = new pty_1.PtyShell({
        onFlush: sendOutput,
        onExit: (code) => {
            daemonLog(`PTY exited (code=${code}), respawning...`);
            // 重新创建 PTY
            ptyShell = new pty_1.PtyShell({ onFlush: sendOutput, onExit: arguments.callee });
        },
    });
    daemonLog(`daemon started with PTY, thread=${config.threadId}, lastId=${lastId}`);
    while (true) {
        try {
            const { status, body } = await (0, http_1.httpGet)(`/api/terminal/poll?thread_id=${config.threadId}&after=${lastId}`, config.token);
            if (status === 200) {
                const data = JSON.parse(body);
                const messages = data.messages || [];
                for (const msg of messages) {
                    lastId = Math.max(lastId, msg.id);
                    // 只处理"收到的"消息（从 Web 端发给终端的），跳过自己发的
                    if (msg.direction !== 'received') {
                        continue;
                    }
                    const content = msg.content?.trim();
                    if (!content)
                        continue;
                    daemonLog(`recv: ${content}`);
                    // 安全检查
                    if (!isSafe(content)) {
                        await sendOutput(`❌ 危险命令已拒绝: ${content}`);
                        continue;
                    }
                    // 写入 PTY stdin
                    if (!ptyShell.isAlive) {
                        ptyShell = new pty_1.PtyShell({ onFlush: sendOutput });
                    }
                    ptyShell.write(content);
                }
            }
        }
        catch (err) {
            daemonLog(`poll error: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
}
// ── 启动 daemon ──
function startDaemon(config) {
    // 写 PID 文件
    const dir = path.dirname(PID_FILE);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
    // 清理
    const cleanup = () => {
        try {
            fs.unlinkSync(PID_FILE);
        }
        catch { }
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    // 开始轮询
    pollLoop(config).catch(err => {
        daemonLog(`fatal: ${err.message}`);
        cleanup();
    });
}
// ── 检查 daemon 状态 ──
function isDaemonRunning() {
    if (!fs.existsSync(PID_FILE))
        return { running: false };
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim());
    try {
        process.kill(pid, 0);
        return { running: true, pid };
    }
    catch {
        // 进程不存在，清理 stale PID 文件
        try {
            fs.unlinkSync(PID_FILE);
        }
        catch { }
        return { running: false };
    }
}
// ── 停止 daemon ──
function stopDaemon() {
    const { running, pid } = isDaemonRunning();
    if (!running || !pid)
        return false;
    try {
        process.kill(pid, 'SIGTERM');
        try {
            fs.unlinkSync(PID_FILE);
        }
        catch { }
        return true;
    }
    catch {
        return false;
    }
}
// ── 以 detached 子进程启动 daemon ──
function spawnDaemon(config) {
    const { spawn } = require('child_process');
    const cliPath = path.join(__dirname, 'cli.js');
    const child = spawn(process.execPath, [cliPath, '_daemon'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
    });
    child.unref();
    return child.pid || null;
}
