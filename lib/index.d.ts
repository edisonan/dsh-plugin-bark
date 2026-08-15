import type { Context } from '@deepseek-ai/cordis';
/**
 * 通知触发时机。每一项都是一个可独立开关的原因。
 * 默认聚焦“任务结束类”，把“等你回答/授权/确认”这类打断性通知默认关掉，
 * 让小白用户只收最关心的完成提醒，不被刷屏。
 */
export type BarkTrigger = 'turn-end-completed' | 'turn-end-blocked' | 'turn-end-max-tokens' | 'turn-end-aborted' | 'turn-end-interrupted' | 'turn-end-error' | 'asking-you' | 'waiting-approval' | 'plan-review';
export interface BarkSettings {
    /** Bark 设备 key。配置顺序：config.deviceKey > 环境变量 BARK_DEVICE_KEY > 空（不推）。 */
    deviceKey?: string;
    /** 通知分组（iOS 折叠到一起）。 */
    group?: string;
    /** 关闭所有触发。false = 完全禁用本插件（更省心）。 */
    enabled?: boolean;
    /** 单独开/关各自的触发时机；未列出的用上面的 defaultOn。 */
    triggers?: Partial<Record<BarkTrigger, boolean>>;
    /** 是否在正文带 token 用量与耗时。 */
    withStats?: boolean;
    /** 是否附带点击跳回会话的深链。 */
    withDeepLink?: boolean;
    /** 标题模板。 */
    titleTemplate?: string;
    /** 正文模板。 */
    bodyTemplate?: string;
    /** 摘要最大字符数（超长截断加 …）。 */
    summaryMaxLen?: number;
    /** 深链接模板，`{session}` 占位为会话 id。 */
    deepLinkTemplate?: string;
    /** 单次推送 HTTP 超时（ms）。 */
    timeoutMs?: number;
}
export declare const name = "dsh-plugin-bark";
export declare function apply(ctx: Context, config?: BarkSettings): void;
