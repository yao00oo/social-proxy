export interface TerminalConfig {
    token: string;
    email: string;
    terminalId: number;
    channelId: number;
    threadId: number;
    name: string;
    createdAt: string;
}
export declare function readConfig(): TerminalConfig | null;
export declare function writeConfig(config: TerminalConfig): void;
export declare function clearConfig(): void;
