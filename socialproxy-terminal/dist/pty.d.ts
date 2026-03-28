export interface PtyShellOptions {
    onFlush: (output: string) => Promise<void>;
    onExit?: (code: number, signal: number) => void;
}
export declare class PtyShell {
    private proc;
    private buffer;
    private flushTimer;
    private maxTimer;
    private onFlush;
    private onExitCb?;
    private dead;
    private static IDLE_MS;
    private static MAX_MS;
    private static MAX_BUF;
    constructor(opts: PtyShellOptions);
    write(command: string): void;
    kill(): void;
    get isAlive(): boolean;
    private resetIdleTimer;
    private clearTimers;
    private flush;
}
