export interface AuthResult {
    token: string;
    email: string;
    userId: string;
}
export declare function deviceAuth(): Promise<AuthResult>;
