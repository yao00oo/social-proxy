export interface SyncMessage {
  platform: string;           // 'imessage' | 'wechat' | ...
  contact_name: string;
  direction: 'sent' | 'received';
  content: string;
  timestamp: string;          // ISO 8601
  platform_msg_id: string;    // unique ID for dedup
  sender_name?: string;
  thread_name?: string;       // group chat name
}

export interface SyncContact {
  platform: string;
  name: string;
  platform_uid: string;       // phone number or email
  phone?: string;
  email?: string;
}

export interface Adapter {
  name: string;
  checkAccess(): Promise<boolean>;
  exportAll(): Promise<{ messages: SyncMessage[]; contacts: SyncContact[] }>;
  watch(onNewMessages: (msgs: SyncMessage[]) => void): void;
  getLastSyncId(): string | null;
}
