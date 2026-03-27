export declare const BASE_URL: string;
export declare function httpGet(path: string, token?: string): Promise<{
    status: number;
    body: string;
}>;
export declare function httpPost(path: string, data: unknown, token?: string): Promise<{
    status: number;
    body: string;
}>;
