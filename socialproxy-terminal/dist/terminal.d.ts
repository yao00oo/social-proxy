import { TerminalConfig } from './config';
export declare function registerTerminal(token: string): Promise<TerminalConfig>;
export declare function sendMessage(token: string, threadId: number, content: string): Promise<boolean>;
