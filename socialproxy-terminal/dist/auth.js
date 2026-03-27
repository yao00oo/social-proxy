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
exports.deviceAuth = deviceAuth;
// Device Code 授权流程 — 终端生成码 → 浏览器授权 → 终端拿到 token
const crypto = __importStar(require("crypto"));
const os = __importStar(require("os"));
const http_1 = require("./http");
const logger_1 = require("./logger");
function getDeviceName() {
    const hostname = os.hostname().replace('.local', '');
    const user = os.userInfo().username;
    return `${user} 的 ${hostname}`;
}
function getDeviceInfo() {
    return {
        name: getDeviceName(),
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        osVersion: os.release(),
    };
}
async function deviceAuth() {
    const deviceCode = crypto.randomBytes(16).toString('hex');
    const device = getDeviceInfo();
    const authUrl = `${http_1.BASE_URL}/auth/device?code=${deviceCode}`;
    (0, logger_1.log)(`打开浏览器登录中...`);
    console.log(`  如果没有自动打开，请访问：`);
    console.log(`  ${authUrl}\n`);
    // 通知服务端有终端等待授权
    await (0, http_1.httpPost)('/api/terminal/auth/start', {
        code: deviceCode,
        device,
    }).catch(() => { }); // 非关键，服务端可能还没这个 API
    // 打开浏览器
    try {
        const open = (await Promise.resolve().then(() => __importStar(require('open')))).default;
        await open(authUrl);
    }
    catch {
        const { exec } = await Promise.resolve().then(() => __importStar(require('child_process')));
        exec(`open "${authUrl}"`);
    }
    // 轮询等待授权
    (0, logger_1.log)('等待授权...');
    const maxAttempts = 150; // 5 分钟
    for (let i = 0; i < maxAttempts; i++) {
        await sleep(2000);
        try {
            const { status, body } = await (0, http_1.httpGet)(`/api/auth/device/poll?code=${deviceCode}`);
            if (status === 200) {
                const data = JSON.parse(body);
                if (data.token) {
                    (0, logger_1.success)(`已登录 (${data.email || 'user'})`);
                    return {
                        token: data.token,
                        email: data.email || '',
                        userId: data.userId || '',
                    };
                }
            }
            if (status === 410) {
                (0, logger_1.error)('授权已过期，请重新运行');
                process.exit(1);
            }
        }
        catch {
            // 网络错误，继续轮询
        }
    }
    (0, logger_1.error)('授权超时，请重新运行');
    process.exit(1);
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
