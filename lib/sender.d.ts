/**
 * Bark 官方推送发送器。
 * 只依赖 Node 内置的 fetch（Node >= 22），零外部依赖。
 * URL 格式：https://api.day.app/<deviceKey>/<title>/<body>?<query>
 * query：url（点击打开的链接）、group（通知分组）、level（中断级别）
 * 文档：https://github.com/Finb/Bark
 */
export interface BarkPayload {
    title: string;
    body: string;
    url?: string;
    group?: string;
    level?: 'active' | 'timeSensitive' | 'passive';
    timeoutMs?: number;
}
export declare function sendBark(deviceKey: string, payload: BarkPayload): Promise<Record<string, unknown>>;
