import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import chokidar from 'chokidar';
import { Adapter, SyncMessage, SyncContact } from './types';
import { info, error, warn, success } from '../logger';

const DB_PATH = path.join(os.homedir(), 'Library/Messages/chat.db');
const SYNC_STATE_DIR = path.join(os.homedir(), '.botook');
const SYNC_STATE_FILE = path.join(SYNC_STATE_DIR, 'sync-state.json');

interface SyncState {
  lastMessageRowId: number;
  lastSyncTime: string;
}

function readSyncState(): SyncState | null {
  try {
    if (!fs.existsSync(SYNC_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeSyncState(state: SyncState) {
  if (!fs.existsSync(SYNC_STATE_DIR)) {
    fs.mkdirSync(SYNC_STATE_DIR, { recursive: true });
  }
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Convert Apple Cocoa epoch timestamp (nanoseconds since 2001-01-01) to JS Date.
 */
function cocoaToDate(cocoaTimestamp: number): Date {
  return new Date((cocoaTimestamp / 1e9 + 978307200) * 1000);
}

function openDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

/**
 * Build a lookup of chat ROWID -> display_name for group chats.
 */
function getChatNames(db: Database.Database): Map<number, string> {
  const rows = db
    .prepare('SELECT ROWID, display_name FROM chat WHERE display_name IS NOT NULL AND display_name != ""')
    .all() as { ROWID: number; display_name: string }[];

  const map = new Map<number, string>();
  for (const row of rows) {
    map.set(row.ROWID, row.display_name);
  }
  return map;
}

/**
 * Build a lookup of message ROWID -> chat ROWID.
 */
function getMessageChatMap(db: Database.Database): Map<number, number> {
  const rows = db
    .prepare('SELECT message_id, chat_id FROM chat_message_join')
    .all() as { message_id: number; chat_id: number }[];

  const map = new Map<number, number>();
  for (const row of rows) {
    map.set(row.message_id, row.chat_id);
  }
  return map;
}

function queryMessages(db: Database.Database, sinceRowId?: number): SyncMessage[] {
  const chatNames = getChatNames(db);
  const msgChatMap = getMessageChatMap(db);

  let query = `
    SELECT m.ROWID, m.text, m.date, m.is_from_me, m.handle_id,
           h.id as contact_id, h.service
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
  `;

  if (sinceRowId !== undefined) {
    query += ` WHERE m.ROWID > ?`;
  }

  query += ` ORDER BY m.date ASC`;

  const stmt = db.prepare(query);
  const rows = (sinceRowId !== undefined ? stmt.all(sinceRowId) : stmt.all()) as {
    ROWID: number;
    text: string | null;
    date: number;
    is_from_me: number;
    handle_id: number;
    contact_id: string | null;
    service: string | null;
  }[];

  const messages: SyncMessage[] = [];

  for (const row of rows) {
    if (!row.text) continue; // skip empty messages (reactions, typing indicators, etc.)

    const chatId = msgChatMap.get(row.ROWID);
    const threadName = chatId ? chatNames.get(chatId) : undefined;
    const contactName = row.contact_id || 'Unknown';

    messages.push({
      platform: 'imessage',
      contact_name: contactName,
      direction: row.is_from_me ? 'sent' : 'received',
      content: row.text,
      timestamp: cocoaToDate(row.date).toISOString(),
      platform_msg_id: `imessage-${row.ROWID}`,
      sender_name: row.is_from_me ? 'me' : contactName,
      thread_name: threadName,
    });
  }

  return messages;
}

function queryContacts(db: Database.Database): SyncContact[] {
  const rows = db
    .prepare('SELECT ROWID, id, service FROM handle')
    .all() as { ROWID: number; id: string; service: string }[];

  const contacts: SyncContact[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);

    const isEmail = row.id.includes('@');

    contacts.push({
      platform: 'imessage',
      name: row.id, // We only have the identifier, not the address book name
      platform_uid: row.id,
      phone: isEmail ? undefined : row.id,
      email: isEmail ? row.id : undefined,
    });
  }

  return contacts;
}

export const imessageAdapter: Adapter = {
  name: 'iMessage',

  async checkAccess(): Promise<boolean> {
    try {
      const db = openDb();
      db.close();
      return true;
    } catch (err: any) {
      if (err.code === 'SQLITE_CANTOPEN' || err.message?.includes('permission')) {
        error('Cannot access iMessage database.');
        console.log('\n  To grant access:');
        console.log('  1. Open System Settings > Privacy & Security > Full Disk Access');
        console.log('  2. Click the + button');
        console.log('  3. Add your terminal app (Terminal, iTerm2, etc.)');
        console.log('  4. Restart your terminal and try again.\n');
        return false;
      }
      throw err;
    }
  },

  async exportAll(): Promise<{ messages: SyncMessage[]; contacts: SyncContact[] }> {
    const db = openDb();
    try {
      const syncState = readSyncState();
      const sinceRowId = syncState?.lastMessageRowId;

      const messages = queryMessages(db, sinceRowId);
      const contacts = sinceRowId ? [] : queryContacts(db); // Only export contacts on first sync

      // Update sync state with the highest ROWID we've seen
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        const lastRowId = parseInt(lastMsg.platform_msg_id.replace('imessage-', ''), 10);
        writeSyncState({
          lastMessageRowId: lastRowId,
          lastSyncTime: new Date().toISOString(),
        });
      }

      return { messages, contacts };
    } finally {
      db.close();
    }
  },

  watch(onNewMessages: (msgs: SyncMessage[]) => void): void {
    info('Watching iMessage database for changes...');

    const watcher = chokidar.watch(DB_PATH, {
      persistent: true,
      usePolling: true,        // Required for SQLite WAL mode
      interval: 2000,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 500,
      },
    });

    watcher.on('change', () => {
      try {
        const syncState = readSyncState();
        if (!syncState) return;

        const db = openDb();
        try {
          const newMessages = queryMessages(db, syncState.lastMessageRowId);

          if (newMessages.length > 0) {
            const lastMsg = newMessages[newMessages.length - 1];
            const lastRowId = parseInt(lastMsg.platform_msg_id.replace('imessage-', ''), 10);
            writeSyncState({
              lastMessageRowId: lastRowId,
              lastSyncTime: new Date().toISOString(),
            });

            onNewMessages(newMessages);
          }
        } finally {
          db.close();
        }
      } catch (err: any) {
        warn(`Error reading new messages: ${err.message}`);
      }
    });

    // Handle process exit
    const cleanup = () => {
      watcher.close();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  },

  getLastSyncId(): string | null {
    const state = readSyncState();
    return state ? String(state.lastMessageRowId) : null;
  },
};
