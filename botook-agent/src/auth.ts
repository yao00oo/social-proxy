import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as https from 'https';
import { info, success, error } from './logger';

const CONFIG_DIR = path.join(os.homedir(), '.botook');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const BASE_URL = 'https://botook.ai';

interface Config {
  token: string;
  email?: string;
  deviceCode?: string;
  createdAt: string;
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readConfig(): Config | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as Config;
  } catch {
    return null;
  }
}

function writeConfig(config: Config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export async function getToken(): Promise<string | null> {
  const config = readConfig();
  return config?.token ?? null;
}

export async function isLoggedIn(): Promise<boolean> {
  const token = await getToken();
  return token !== null;
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function httpPost(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Length': '0' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function login(): Promise<void> {
  // Create device code on server
  const createRes = await httpPost(`${BASE_URL}/api/auth/device`);
  if (createRes.status !== 200) {
    error(`Failed to create device code: ${createRes.body}`);
    return;
  }
  const { code: deviceCode } = JSON.parse(createRes.body);
  const authUrl = `${BASE_URL}/auth/device?code=${deviceCode}`;

  info('Opening browser for login...');
  console.log(`\n  If the browser doesn't open, visit:\n  ${authUrl}\n`);

  // Open browser
  try {
    const open = (await import('open')).default;
    await open(authUrl);
  } catch {
    // If 'open' package is unavailable, try platform command
    const { exec } = await import('child_process');
    exec(`open "${authUrl}"`);
  }

  info('Waiting for login...');

  // Poll for token
  const pollUrl = `${BASE_URL}/api/auth/device/poll?code=${deviceCode}`;
  const maxAttempts = 150; // 5 minutes at 2s interval

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000);

    try {
      const { status, body } = await httpGet(pollUrl);

      if (status === 200) {
        const data = JSON.parse(body);
        if (data.token) {
          writeConfig({
            token: data.token,
            email: data.email,
            deviceCode,
            createdAt: new Date().toISOString(),
          });
          success(`Logged in as ${data.email || 'user'}`);
          return;
        }
      }

      if (status === 404 || status === 202) {
        // Still waiting — continue polling
        continue;
      }

      if (status === 410) {
        error('Login expired. Please try again.');
        process.exit(1);
      }
    } catch {
      // Network error — retry
      continue;
    }
  }

  error('Login timed out. Please try again.');
  process.exit(1);
}
