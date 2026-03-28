import { TerminalConfig } from './config';
export declare function startDaemon(config: TerminalConfig): void;
export declare function isDaemonRunning(): {
    running: boolean;
    pid?: number;
};
export declare function stopDaemon(): boolean;
export declare function spawnDaemon(config: TerminalConfig): number | null;
