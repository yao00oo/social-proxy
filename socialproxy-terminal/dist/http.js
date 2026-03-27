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
exports.BASE_URL = void 0;
exports.httpGet = httpGet;
exports.httpPost = httpPost;
// HTTP 工具 — 和 botook.ai 通信
const https = __importStar(require("https"));
const http = __importStar(require("http"));
exports.BASE_URL = process.env.SOCIALPROXY_URL || 'https://botook.ai';
function httpGet(path, token) {
    const url = path.startsWith('http') ? path : `${exports.BASE_URL}${path}`;
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            timeout: 35000,
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')); });
    });
}
function httpPost(path, data, token) {
    const url = path.startsWith('http') ? path : `${exports.BASE_URL}${path}`;
    const bodyStr = JSON.stringify(data);
    const parsed = new URL(url);
    return new Promise((resolve, reject) => {
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                'User-Agent': 'socialproxy-terminal/0.1.0',
            },
            timeout: 15000,
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')); });
        req.write(bodyStr);
        req.end();
    });
}
