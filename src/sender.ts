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

function joinSegments(...segments: Array<string | undefined>): string {
  return segments
    .filter((s): s is string => !!s)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export async function sendBark(
  deviceKey: string,
  payload: BarkPayload,
): Promise<Record<string, unknown>> {
  if (!deviceKey) {
    throw new Error(
      '[dsh-plugin-bark] deviceKey 未配置，跳过推送。（去 https://api.day.app 获取你的 key，或设置环境变量 BARK_DEVICE_KEY）',
    );
  }

  const base = `https://api.day.app/${encodeURIComponent(deviceKey)}`;
  const path = joinSegments(payload.title, payload.body);

  const params = new URLSearchParams();
  if (payload.url) params.set('url', payload.url);
  if (payload.group) params.set('group', payload.group);
  if (payload.level) params.set('level', payload.level);

  const query = params.toString();
  const endpoint = query ? `${base}/${path}?${query}` : `${base}/${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), payload.timeoutMs ?? 5000);

  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`[dsh-plugin-bark] HTTP ${res.status}: ${JSON.stringify(json)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}
