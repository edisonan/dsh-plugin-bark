/**
 * dsh-plugin-bark 冒烟测试：合成符合 DSH 真实事件形状的会话流，拦截 fetch
 * （用假 key、不过网），验证：
 *   - 6 种 turn/end reason 的触发时机与默认开关
 *   - token 用量累计（input→output）
 *   - 深链接 + workspace 名
 *   - 去重（同一事件 seq 重复触发只推一次）
 *   - 打断型时机默认关闭（asking-you / waiting-approval）
 *   - 等待回答时机开启后能解析问题文本
 * 需先 `pnpm build`。用法：node smoke.mjs
 */
import { apply } from './lib/index.js';

function makeTest() {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ code: 200 }) };
  };
  let handled = null;
  const ctx = {
    logger: { info: (m) => {}, warn: (m) => {}, debug: (m) => {} },
    on: (event, handler) => { if (event === 'session/event') handled = handler; },
  };
  const emit = (s, ev) => handled(s, ev);
  return { ctx, emit, urls, finish: () => { globalThis.fetch = realFetch; } };
}

let pass = true;
const check = (name, cond) => {
  console.log(cond ? `ok: ${name}` : `FAIL: ${name}`);
  if (!cond) pass = false;
};
const dec = (urls) => urls.map((u) => decodeURIComponent(u));
const has = (urls, pred) => dec(urls).some(pred);

// ---------------------------------------------------------------- case 1:
// completed 回合：token 累计、深链、workspace 名、模板。
{
  const t = makeTest();
  const s = { id: 'sess-A', header: { cwd: '/Users/me/my-project' } };
  apply(t.ctx, { deviceKey: 'K', group: 'g1', titleTemplate: '{status}', bodyTemplate: '{summary}\n{workspace}\n{tokens} · {duration}' });
  t.emit(s, { type: 'turn/start', seq: 1, data: { turn: 1 } });
  t.emit(s, { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '帮我修复登录页 CSS' }] } });
  t.emit(s, { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, usage: { inputTokens: 300, outputTokens: 40 } } });
  t.emit(s, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  await new Promise((r) => setTimeout(r, 120));
  t.finish();
  check('completed 触发推送', has(t.urls, (u) => u.startsWith('https://api.day.app/K/✅ 完成/')));
  check('completed 含任务摘要', has(t.urls, (u) => u.includes('帮我修复登录页 CSS')));
  check('completed 含 token 300→40', has(t.urls, (u) => u.includes('300→40 tokens')));
  check('completed 含深链+分组', has(t.urls, (u) => u.includes('url=dsh://sessions/sess-A') && u.includes('&group=g1')));
  check('completed 含工作目录项目名(workspace)', has(t.urls, (u) => u.includes('my-project')));
}

// ---------------------------------------------------------------- case 2:
// 默认开关：aborted/max-tokens 默认关 → 不推；error/blocked/... 默认开 → 推。
{
  const t = makeTest();
  const s = { id: 'sess-B' };
  apply(t.ctx, { deviceKey: 'K' });
  // blocked
  t.emit(s, { type: 'turn/start', seq: 1, data: {} });
  t.emit(s, { type: 'user/message', seq: 2, data: { content: [{ text: '被阻塞的任务' }] } });
  t.emit(s, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'blocked' } } });
  // aborted（默认关 → 不推）
  t.emit(s, { type: 'turn/start', seq: 4, data: {} });
  t.emit(s, { type: 'user/message', seq: 5, data: { content: [{ text: '取消的任务' }] } });
  t.emit(s, { type: 'turn/end', seq: 6, data: { turn: 2, reason: { kind: 'aborted' } } });
  // error
  t.emit(s, { type: 'turn/start', seq: 7, data: {} });
  t.emit(s, { type: 'user/message', seq: 8, data: { content: [{ text: '出错的任务' }] } });
  t.emit(s, { type: 'turn/end', seq: 9, data: { turn: 3, reason: { kind: 'error', error: { message: '网络超时' } } } });
  await new Promise((r) => setTimeout(r, 120));
  t.finish();
  check('blocked 默认开并推送', has(t.urls, (u) => u.startsWith('https://api.day.app/K/🚫 阻塞/')));
  check('blocked 用任务摘要', has(t.urls, (u) => u.includes('被阻塞的任务')));
  check('error 默认开并推送', has(t.urls, (u) => u.startsWith('https://api.day.app/K/❌ 出错/')));
  check('error 带错误信息(detail)', has(t.urls, (u) => u.includes('网络超时')));
  check('aborted 默认关 → 不推', !has(t.urls, (u) => u.includes('已取消')));
}

// ---------------------------------------------------------------- case 3:
// 去重：同一事件 seq 重复触发只推一次。
{
  const t = makeTest();
  const s = { id: 'sess-C' };
  apply(t.ctx, { deviceKey: 'K' });
  const ev = { type: 'turn/end', seq: 42, data: { turn: 1, reason: { kind: 'completed' } } };
  t.emit(s, { type: 'turn/start', seq: 40, data: {} });
  t.emit(s, { type: 'user/message', seq: 41, data: { content: [{ text: '去重测试' }] } });
  t.emit(s, ev); // 第一次
  t.emit(s, ev); // 重放/重连再来一次
  t.emit(s, ev); // 再来一次
  await new Promise((r) => setTimeout(r, 120));
  t.finish();
  check('去重后只推 1 次', has(t.urls, (u) => u.includes('去重测试')) && dec(t.urls).filter((u) => u.includes('去重测试')).length === 1);
}

// ---------------------------------------------------------------- case 4:
// 打断型时机默认关；开启 asking-you 后能解析问题文本。
{
  // 默认关闭
  {
    const t = makeTest();
    const s = { id: 'sess-D' };
    apply(t.ctx, { deviceKey: 'K' });
    t.emit(s, { type: 'tool/call', seq: 1, data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '要不要继续？' }] }) } });
    await new Promise((r) => setTimeout(r, 120));
    t.finish();
    check('asking-you 默认关 → 不推', t.urls.length === 0);
  }
  // 开启后
  {
    const t = makeTest();
    const s = { id: 'sess-E' };
    apply(t.ctx, { deviceKey: 'K', triggers: { 'asking-you': true } });
    t.emit(s, { type: 'tool/call', seq: 1, data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '要不要继续？' }] }) } });
    await new Promise((r) => setTimeout(r, 120));
    t.finish();
    check('asking-you 开启后推送', has(t.urls, (u) => u.startsWith('https://api.day.app/K/❓ 等你回答/')));
    check('asking-you 含问题文本', has(t.urls, (u) => u.includes('要不要继续')));
  }
}

// ---------------------------------------------------------------- case 5:
// enabled:false 完全禁用。
{
  const t = makeTest();
  const s = { id: 'sess-F' };
  apply(t.ctx, { deviceKey: 'K', enabled: false });
  t.emit(s, { type: 'turn/start', seq: 1, data: {} });
  t.emit(s, { type: 'user/message', seq: 2, data: { content: [{ text: '不应推送' }] } });
  t.emit(s, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } });
  await new Promise((r) => setTimeout(r, 120));
  t.finish();
  check('enabled:false → 完全不推', t.urls.length === 0);
}

console.log(pass ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');
process.exit(pass ? 0 : 1);
