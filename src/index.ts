import type { Context } from '@deepseek-ai/cordis';
import { sendBark } from './sender.js';

/**
 * 通知触发时机。每一项都是一个可独立开关的原因。
 * 默认聚焦“任务结束类”，把“等你回答/授权/确认”这类打断性通知默认关掉，
 * 让小白用户只收最关心的完成提醒，不被刷屏。
 */
export type BarkTrigger =
  | 'turn-end-completed' //    ✅ turn/end 正常完成
  | 'turn-end-blocked' //      🚫 任务被阻塞
  | 'turn-end-max-tokens' //   ⚠️ 达到 token 上限
  | 'turn-end-aborted' //      ⏹ 被打断/取消
  | 'turn-end-interrupted' //  ⏸ 会话异常中断
  | 'turn-end-error' //        ❌ 任务出错
  | 'asking-you' //            ❓ 等你输入回答（ask_user_question）
  | 'waiting-approval' //      🔐 等你授权（approval/asked）
  | 'plan-review' //           📋 等你确认计划（exit_plan_mode）

/** 每个触发时机对应的“状态头”文案与默认开关。 */
const TRIGGER_META: Record<BarkTrigger, { label: string; defaultOn: boolean }> = {
  'turn-end-completed':     { label: '✅ 完成',   defaultOn: true },
  'turn-end-blocked':       { label: '🚫 阻塞',   defaultOn: true },
  'turn-end-max-tokens':    { label: '⚠️ 达到Token上限', defaultOn: false },
  'turn-end-aborted':       { label: '⏹ 已取消',  defaultOn: false },
  'turn-end-interrupted':   { label: '⏸ 中断',   defaultOn: true },
  'turn-end-error':         { label: '❌ 出错',   defaultOn: true },
  'asking-you':             { label: '❓ 等你回答', defaultOn: false },
  'waiting-approval':       { label: '🔐 等你授权', defaultOn: false },
  'plan-review':            { label: '📋 等你确认', defaultOn: false },
};

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

interface TurnGuard {
  firstUserText: string;
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** 模板可用的占位符。 */
const TOKENS = ['{status}', '{summary}', '{detail}', '{tokens}', '{duration}', '{session}', '{workspace}'] as const;

export const name = 'dsh-plugin-bark';

export function apply(ctx: Context, config: BarkSettings = {}) {
  const deviceKey = config.deviceKey || process.env.BARK_DEVICE_KEY || '';

  // 解析触发开关：config.triggers 覆盖，未配置项按各自默认值。
  const triggerEnabled = (t: BarkTrigger): boolean => {
    if (config.enabled === false) return false;
    return config.triggers?.[t] ?? TRIGGER_META[t].defaultOn;
  };

  /** session 句柄 → 进行中的回合（只保留最近一定数量，防内存无限增长）。 */
  const turnsBySession = new Map<string, TurnGuard>();
  const MAX_TRACKED_SESSIONS = 200;

  /** 已推送过的事件账本，用于去重：key = sessionId + ':' + seq。 */
  const delivered = new Set<string>();
  const DELIVERED_LEDGER_CAP = 2000;
  const capLedger = () => {
    if (delivered.size > DELIVERED_LEDGER_CAP) {
      // 超出上限时丢弃最早记录，防止内存无限增长。
      const first = delivered.values().next();
      if (!first.done) delivered.delete(first.value);
    }
  };

  function sessionKey(session: unknown): string {
    if (typeof session === 'string') return session;
    if (session && typeof session === 'object') {
      const s = session as Record<string, unknown>;
      return String((s.id ?? s.sessionId ?? s.session ?? session) ?? 'anon');
    }
    return 'anon';
  }

  /** 从 Session 句柄里尽量取 workspace（cwd 末段），方便通知里定位项目。 */
  function workspaceName(session: unknown): string {
    if (session && typeof session === 'object') {
      const s = session as Record<string, unknown>;
      const header = (s.header as Record<string, unknown> | undefined) ?? {};
      const cwd = typeof header.cwd === 'string' ? header.cwd : '';
      if (cwd) {
        const seg = cwd.split(/[\\/]/).filter(Boolean).pop();
        if (seg) return seg;
      }
    }
    return '';
  }

  function eventType(event: unknown): string {
    if (typeof event === 'string') return event;
    if (event && typeof event === 'object') return String((event as Record<string, unknown>).type ?? '');
    return '';
  }

  function eventSeq(event: unknown): number {
    if (event && typeof event === 'object') {
      const seq = (event as Record<string, unknown>).seq;
      return typeof seq === 'number' ? seq : -1;
    }
    return -1;
  }

  function eventData(event: unknown): Record<string, unknown> {
    if (event && typeof event === 'object') {
      const e = (event as Record<string, unknown>).data;
      if (e && typeof e === 'object') return e as Record<string, unknown>;
    }
    return {};
  }

  /** 从 UserMessage 的内容块数组里提取纯文本摘要。 */
  function extractSummary(payload: unknown, maxLen: number): string {
    const data = (payload && typeof payload === 'object')
      ? (payload as Record<string, unknown>)
      : {};
    const content = data.content;
    let text = '';
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          const b = block as { type?: unknown; text?: unknown };
          if ((b.type === undefined || b.type === 'text') && typeof b.text === 'string') text += b.text;
        } else if (typeof block === 'string') {
          text += block;
        }
      }
    } else if (typeof content === 'string') {
      text = content;
    } else if (typeof data.text === 'string') {
      text = data.text;
    }
    text = text.trim().replace(/\s+/g, ' ').replace(/\n+/g, ' ');
    return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
  }

  /** 把某个结束原因映射到触发时机；未知原因返回 undefined。 */
  function triggerForTurnEnd(kind: string): BarkTrigger | undefined {
    switch (kind) {
      case 'completed': return 'turn-end-completed';
      case 'blocked': return 'turn-end-blocked';
      case 'max-tokens': return 'turn-end-max-tokens';
      case 'aborted': return 'turn-end-aborted';
      case 'interrupted': return 'turn-end-interrupted';
      case 'error': return 'turn-end-error';
      default: return undefined;
    }
  }

  function buildDeepLink(key: string): string | undefined {
    if (config.withDeepLink === false) return undefined;
    const tpl = config.deepLinkTemplate ?? 'dsh://sessions/{session}';
    return tpl.replaceAll('{session}', encodeURIComponent(key));
  }

  // `session/event` 是 DSH host 注入的事件，不在 @deepseek-ai/cordis 基类 Events 类型里，
  // 用强依赖类型手段注册（DSH 官方前台插件同此姿势）。
  (ctx as unknown as {
    on(event: string, handler: (session: unknown, event: unknown) => void): void;
  }).on('session/event', (session: unknown, event: unknown) => {
    const key = sessionKey(session);
    const type = eventType(event);
    const seq = eventSeq(event);
    const data = eventData(event);
    const now = Date.now();

    // —— 回合开始：登记新的回合，记录开始时间，重置 token。
    if (type === 'turn/start') {
      if (turnsBySession.size >= MAX_TRACKED_SESSIONS) turnsBySession.clear();
      turnsBySession.set(key, { firstUserText: '', startedAt: now, inputTokens: 0, outputTokens: 0 });
      return;
    }

    // —— 用户消息：抓首次任务摘要。
    if (type === 'user/message') {
      const guard = turnsBySession.get(key);
      if (guard && !guard.firstUserText) {
        const summary = extractSummary(data, config.summaryMaxLen ?? 60);
        if (summary) guard.firstUserText = summary;
      }
      return;
    }

    // —— 助手消息：累计本回合 token。
    if (type === 'assistant/message') {
      const guard = turnsBySession.get(key);
      if (guard && config.withStats !== false) {
        const usage = (data.usage && typeof data.usage === 'object')
          ? data.usage as Record<string, unknown>
          : {};
        const inp = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
        const out = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
        guard.inputTokens += inp;
        guard.outputTokens += out;
      }
      return;
    }

    let trigger: BarkTrigger | undefined;
    let detail = '';

    // —— 回合结束：判定结束原因。
    if (type === 'turn/end') {
      const reason = (data.reason && typeof data.reason === 'object')
        ? (data.reason as Record<string, unknown>)
        : {};
      const kind = String(reason.kind ?? 'completed');
      trigger = triggerForTurnEnd(kind);
      if (trigger === 'turn-end-error') {
        const err = (reason.error && typeof reason.error === 'object')
          ? (reason.error as Record<string, unknown>)
          : {};
        detail = typeof err.message === 'string' ? err.message : '';
      }
    } else if (type === 'tool/call' && data.name === 'ask_user_question') {
      // 等你回答：把问题文本解析出来放进通知。
      trigger = 'asking-you';
      try {
        const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
        const q = args && Array.isArray(args.questions) && args.questions[0];
        detail = q && typeof q.question === 'string' ? q.question : '';
      } catch {
        detail = '';
      }
    } else if (type === 'approval/asked') {
      trigger = 'waiting-approval';
      const tool = typeof data.toolName === 'string' ? data.toolName : '';
      const msg = typeof data.reason === 'string' ? data.reason : '';
      detail = [tool && `工具 ${tool}`, msg].filter(Boolean).join('：');
    } else if (type === 'tool/call' && data.name === 'exit_plan_mode') {
      trigger = 'plan-review';
      detail = 'Agent 已提交计划，等待你确认';
    }

    if (!trigger) return;                       // 不感兴趣的事件
    if (!triggerEnabled(trigger)) return;        // 该时机被关闭
    if (deviceKey === '') {                       // 未配置 key，静默不推
      ctx.logger.debug(`[bark] 未配置 deviceKey，跳过「${TRIGGER_META[trigger].label}」`);
      return;
    }
    if (seq >= 0) {                               // 去重：重连/回放不重复推同一个事件
      const dedupKey = `${key}:${seq}`;
      if (delivered.has(dedupKey)) return;
      delivered.add(dedupKey);
      capLedger();
    }

    // 取回合数据（turn/end 才有；其余打断型事件没有回合，用假保全值）。
    const guard = turnsBySession.get(key)
      ?? { firstUserText: '', startedAt: now, inputTokens: 0, outputTokens: 0 };
    if (type === 'turn/end') turnsBySession.delete(key);

    const elapsedMs = Math.max(0, now - guard.startedAt);
    const duration = (elapsedMs / 1000).toFixed(1);

    const status = TRIGGER_META[trigger].label;
    let tokensText = '';
    let durationText = `⏱ ${duration}s`;
    if (config.withStats !== false && (guard.inputTokens || guard.outputTokens)) {
      tokensText = `ⓘ ${guard.inputTokens}→${guard.outputTokens} tokens`;
    }

    const summary = guard.firstUserText || '(无文本摘要)';
    const ws = workspaceName(session);
    const render = (tpl: string): string => {
      const detailLine = detail && detail !== summary ? `\n${detail}` : '';
      return tpl
        .replaceAll('{status}', status)
        .replaceAll('{summary}', summary)
        .replaceAll('{detail}', detail || summary)
        .replaceAll('{tokens}', tokensText)
        .replaceAll('{duration}', durationText)
        .replaceAll('{session}', key)
        .replaceAll('{workspace}', ws)
        // 若渲染后 detail 与 summary 重复则去掉多余一行；保留模板里显式写的 {detail}。
        .replaceAll('{detail?}', detailLine)
        .split('\n')
        .filter((line) => line.trim() !== '')
        .join('\n');
    };

    const title = render(config.titleTemplate ?? '{status}');
    const body = render(config.bodyTemplate ?? '{summary}{detail?}\n{tokens} · {duration}');

    // fire-and-forget，绝不阻塞 agent。错误只记日志，且日志/异常内容不含 key。
    sendBark(deviceKey, {
      title,
      body,
      group: config.group,
      url: buildDeepLink(key),
      timeoutMs: config.timeoutMs ?? 5000,
    })
      .then(() => ctx.logger.info(`[bark] 已推送 ${title}`))
      .catch((err: unknown) => ctx.logger.warn(`[bark] 推送失败: ${(err as Error).message}`));
  });
}
