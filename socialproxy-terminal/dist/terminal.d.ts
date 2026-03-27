import { TerminalConfig } from './config';
export declare function registerTerminal(token: string): Promise<TerminalConfig>;
interface Message {
    id: number;
    content: string;
    sender_name: string;
    direction: string;
    timestamp: string;
    msg_type: string;
    metadata?: any;
}
export declare function pollMessages(token: string, threadId: number, lastId: number): Promise<Message[]>;
export declare function sendMessage(token: string, threadId: number, content: string): Promise<boolean>;
export declare function startREPL(config: TerminalConfig): Promise<void>;
export {};
