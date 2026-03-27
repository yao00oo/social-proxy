import * as https from 'https';
import { SyncMessage, SyncContact } from './adapters/types';
import { error, warn } from './logger';

const BASE_URL = 'https://botook.ai';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

interface SyncPayload {
  type: 'messages' | 'contacts';
  platform: string;
  data: SyncMessage[] | SyncContact[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpPost(
  url: string,
  token: string,
  body: unknown
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${token}`,
          'User-Agent': 'botook-agent/1.0',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function postWithRetry(
  url: string,
  token: string,
  payload: unknown
): Promise<{ status: number; body: string }> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await httpPost(url, token, payload);

      // Rate limited — wait and retry
      if (result.status === 429) {
        const retryAfter = parseInt(result.body, 10) || RETRY_DELAY_MS * (attempt + 1);
        warn(`Rate limited. Retrying in ${Math.ceil(retryAfter / 1000)}s...`);
        await sleep(retryAfter);
        continue;
      }

      // Server error — retry
      if (result.status >= 500) {
        warn(`Server error (${result.status}). Retrying...`);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }

      return result;
    } catch (err) {
      lastError = err as Error;
      warn(`Request failed: ${lastError.message}. Retrying...`);
      await sleep(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError || new Error('Request failed after retries');
}

export async function uploadMessages(
  token: string,
  messages: SyncMessage[],
  platform: string = 'imessage'
): Promise<void> {
  const payload: SyncPayload = {
    type: 'messages',
    platform,
    data: messages,
  };

  const result = await postWithRetry(`${BASE_URL}/api/agent-sync`, token, payload);

  if (result.status === 401) {
    error('Authentication failed. Please run `botook-agent login` again.');
    process.exit(1);
  }

  if (result.status !== 200) {
    throw new Error(`Upload failed with status ${result.status}: ${result.body}`);
  }
}

export async function uploadContacts(
  token: string,
  contacts: SyncContact[],
  platform: string = 'imessage'
): Promise<void> {
  const payload: SyncPayload = {
    type: 'contacts',
    platform,
    data: contacts,
  };

  const result = await postWithRetry(`${BASE_URL}/api/agent-sync`, token, payload);

  if (result.status === 401) {
    error('Authentication failed. Please run `botook-agent login` again.');
    process.exit(1);
  }

  if (result.status !== 200) {
    throw new Error(`Upload failed with status ${result.status}: ${result.body}`);
  }
}
