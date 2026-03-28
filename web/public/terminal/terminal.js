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
exports.sendMessage = sendMessage;
// 终端注册 + 消息发送
const os = __importStar(require("os"));
const http_1 = require("./http");
const config_1 = require("./config");
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
        terminalId: data.terminal_id || data.terminalId,
        channelId: data.channel_id || data.channelId,
        threadId: data.thread_id || data.threadId,
        name,
        createdAt: new Date().toISOString(),
    };
    (0, config_1.writeConfig)(config);
    return config;
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
