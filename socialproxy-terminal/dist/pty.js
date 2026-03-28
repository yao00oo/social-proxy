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
exports.PtyShell = void 0;
// PTY Shell 管理器 — 持久伪终端，缓冲输出
const os = __importStar(require("os"));
const pty = __importStar(require("node-pty"));
// ANSI 转义码正则
const ANSI_RE = /\x1B(?:\[[0-9;]*[a-zA-Z]|\].*?\x07|\(B)/g;
function stripAnsi(s) {
    return s.replace(ANSI_RE, '');
}
class PtyShell {
    constructor(opts) {
        this.buffer = '';
        this.flushTimer = null;
        this.maxTimer = null;
        this.dead = false;
        this.onFlush = opts.onFlush;
        this.onExitCb = opts.onExit;
        const shell = os.platform() === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
        this.proc = pty.spawn(shell, [], {
            name: 'dumb', // TERM=dumb，减少 ANSI 转义
            cols: 120,
            rows: 30,
            cwd: os.homedir(),
            env: { ...process.env, TERM: 'dumb' },
        });
        this.proc.onData((data) => {
            this.buffer += data;
            this.resetIdleTimer();
            // 缓冲超限立即 flush
            if (this.buffer.length >= PtyShell.MAX_BUF) {
                this.flush();
            }
        });
        this.proc.onExit(({ exitCode, signal }) => {
            this.dead = true;
            this.flush(); // flush 残余
            this.onExitCb?.(exitCode ?? 0, signal ?? 0);
        });
    }
    write(command) {
        if (this.dead)
            return;
        this.proc.write(command + '\r');
        // 启动 max timer（命令开始后最长 5 秒必须 flush 一次）
        if (!this.maxTimer) {
            this.maxTimer = setTimeout(() => {
                this.maxTimer = null;
                if (this.buffer.length > 0)
                    this.flush();
            }, PtyShell.MAX_MS);
        }
    }
    kill() {
        this.dead = true;
        this.clearTimers();
        this.flush();
        try {
            this.proc.kill();
        }
        catch { }
    }
    get isAlive() { return !this.dead; }
    resetIdleTimer() {
        if (this.flushTimer)
            clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, PtyShell.IDLE_MS);
    }
    clearTimers() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.maxTimer) {
            clearTimeout(this.maxTimer);
            this.maxTimer = null;
        }
    }
    flush() {
        this.clearTimers();
        if (this.buffer.length === 0)
            return;
        const raw = this.buffer;
        this.buffer = '';
        // 清理 ANSI 转义码，截断过长输出
        let clean = stripAnsi(raw).trim();
        if (!clean)
            return;
        if (clean.length > 8000) {
            clean = clean.slice(0, 8000) + '\n...(输出已截断)';
        }
        this.onFlush(clean).catch(() => { });
    }
}
exports.PtyShell = PtyShell;
// 缓冲参数
PtyShell.IDLE_MS = 300; // 无新输出 300ms 后 flush
PtyShell.MAX_MS = 5000; // 最长 5 秒必须 flush
PtyShell.MAX_BUF = 8000; // 缓冲超过 8KB 立即 flush
