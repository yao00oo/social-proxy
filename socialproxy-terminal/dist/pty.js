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
// 持久 Shell — 用 child_process.spawn 替代 node-pty（兼容性更好）
const os = __importStar(require("os"));
const child_process_1 = require("child_process");
const ANSI_RE = /\x1B(?:\[[0-9;]*[a-zA-Z]|\].*?\x07|\(B)/g;
function stripAnsi(s) { return s.replace(ANSI_RE, ''); }
class PtyShell {
    constructor(opts) {
        this.buffer = '';
        this.flushTimer = null;
        this.maxTimer = null;
        this.dead = false;
        this.onFlush = opts.onFlush;
        this.onExitCb = opts.onExit;
        const shell = process.env.SHELL || '/bin/bash';
        this.proc = (0, child_process_1.spawn)(shell, ['-i'], {
            cwd: os.homedir(),
            env: { ...process.env, TERM: 'dumb', PS1: '$ ' },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc.stdout?.on('data', (data) => {
            this.buffer += data.toString();
            this.resetIdleTimer();
            if (this.buffer.length >= PtyShell.MAX_BUF)
                this.flush();
        });
        this.proc.stderr?.on('data', (data) => {
            this.buffer += data.toString();
            this.resetIdleTimer();
            if (this.buffer.length >= PtyShell.MAX_BUF)
                this.flush();
        });
        this.proc.on('exit', (code, signal) => {
            this.dead = true;
            this.flush();
            this.onExitCb?.(code ?? 0, typeof signal === 'number' ? signal : 0);
        });
    }
    write(command) {
        if (this.dead)
            return;
        this.proc.stdin?.write(command + '\n');
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
        let clean = stripAnsi(raw).trim();
        if (!clean)
            return;
        if (clean.length > 8000)
            clean = clean.slice(0, 8000) + '\n...(已截断)';
        this.onFlush(clean).catch(() => { });
    }
}
exports.PtyShell = PtyShell;
PtyShell.IDLE_MS = 500;
PtyShell.MAX_MS = 5000;
PtyShell.MAX_BUF = 8000;
