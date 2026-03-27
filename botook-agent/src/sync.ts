import { Adapter, SyncMessage, SyncContact } from './adapters/types';
import { imessageAdapter } from './adapters/imessage';
import { uploadMessages, uploadContacts } from './api';
import { info, success, error, warn } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BATCH_SIZE = 500;
const PID_FILE = path.join(os.homedir(), '.botook', 'agent.pid');

const adapters: Adapter[] = [imessageAdapter];

async function uploadInBatches(
  token: string,
  messages: SyncMessage[],
  platform: string
): Promise<void> {
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(messages.length / BATCH_SIZE);

    if (totalBatches > 1) {
      info(`Uploading batch ${batchNum}/${totalBatches} (${batch.length} messages)...`);
    }

    await uploadMessages(token, batch, platform);
  }
}

function writePidFile() {
  const dir = path.dirname(PID_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
}

function removePidFile() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // Ignore cleanup errors
  }
}

export async function startSync(token: string): Promise<void> {
  writePidFile();

  // Clean up PID file on exit
  const cleanup = () => {
    removePidFile();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  info('Starting sync...\n');

  for (const adapter of adapters) {
    // 1. Check access
    info(`Checking ${adapter.name} access...`);
    const hasAccess = await adapter.checkAccess();
    if (!hasAccess) {
      warn(`Skipping ${adapter.name} — no access.`);
      continue;
    }
    success(`${adapter.name} access OK.`);

    // 2. Export messages
    const isFirstSync = adapter.getLastSyncId() === null;
    info(
      isFirstSync
        ? `${adapter.name}: Exporting all messages (first sync)...`
        : `${adapter.name}: Checking for new messages...`
    );

    const { messages, contacts } = await adapter.exportAll();

    // 3. Upload contacts (first sync only)
    if (contacts.length > 0) {
      info(`${adapter.name}: Uploading ${contacts.length} contacts...`);
      await uploadContacts(token, contacts, 'imessage');
      success(`${adapter.name}: ${contacts.length} contacts uploaded.`);
    }

    // 4. Upload messages
    if (messages.length > 0) {
      info(`${adapter.name}: Uploading ${messages.length} messages...`);
      await uploadInBatches(token, messages, 'imessage');
      success(`${adapter.name}: exported ${messages.length.toLocaleString()} messages.`);
    } else {
      info(`${adapter.name}: No new messages to sync.`);
    }

    // 5. Start watching for new messages
    console.log('');
    adapter.watch(async (newMessages) => {
      info(`${adapter.name}: ${newMessages.length} new message(s) detected.`);
      try {
        await uploadInBatches(token, newMessages, 'imessage');
        success(`${adapter.name}: ${newMessages.length} new message(s) synced.`);
      } catch (err: any) {
        error(`${adapter.name}: Failed to sync new messages — ${err.message}`);
      }
    });

    success(`Watching for new messages...`);
  }

  info('Agent is running. Press Ctrl+C to stop.\n');

  // Keep the process alive
  await new Promise(() => {});
}
