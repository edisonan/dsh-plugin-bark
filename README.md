# dsh-plugin-bark

**DSH（DeepSeek Harness）插件：任务结束时用 Bark 把结果推到你 iPhone 上。**

- 回合**完成 / 阻塞 / 出错 / 中断 / 达 Token 上限**都会推送
- 通知里带**任务摘要、token 用量（输入→输出）、耗时、可点击跳回会话的链接、以及项目名**
- **可选**：任务在「等你回答 / 等你授权 / 等你确认计划」时也能提醒你（默认关闭，避免刷屏）
- **关键（安全性差异）：推送 key 只在本机配置，永远不上传、不进浏览器、不出现在日志里**

> 本插件是 **纯 Host（服务端）实现**。它做的所有事都发生在 DSH 进程内，浏览器关没关都不影响推送。
> 面向小白的 **Web 设置面板** 正在规划中（见下方 [Roadmap](#roadmap)），当前版本通过 profile 配置文件或环境变量配置，同样简单。

---

## 它解决什么

当你把 DSH 丢在后台跑一个任务，经常切走干别的事，想知道任务到底结束了没、出了错还是被中断了。这个插件在**回合结束的瞬间**给你 iPhone 推一条通知，让你不用一直盯着页面。

每条通知默认长这样：

```
✅ 完成
帮我修复登录页的 CSS bug
ⓘ 300→40 tokens · ⏱ 42.3s
```

标题是状态（✅ 完成 / 🚫 阻塞 / ❌ 出错 …），正文第一行是任务摘要，第二行是 token 用量和耗时。点击通知（如果有配置深链）能跳回对应会话。

---

## 安装（web / headless 通用）

```bash
# 从仓库克隆或放在本地，先进目录编译
cd dsh-plugin-bark
pnpm install && pnpm build

# 把它链进 profile（web 或 headless，按需）
dsh plugin --profile web add link:$(pwd)
dsh plugin --profile headless add link:$(pwd)
```

`dsh plugin add` 会自动检测到本包声明了 `dsh.bundle`，把它追加进该 profile 的 `dsh.profile.bundles` 并挂载补丁层。

装完**重启 `dsh web`**，验证是否挂载：

```bash
dsh --profile web --dump-config   # 应能看到 "# == dsh-plugin-bark" 层
```

### 远程 / 版本安装（无需本地编译）

如果发布到了 npm 或 Git 仓库，也可以直接：

```bash
dsh plugin --profile web add <你的包名或仓库地址>
```

---

## 配置你自己的推送 key（二选一）

**方式 A：写在自己的 profile 层（推荐）**

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-plugin-bark
  config:
    deviceKey: "<你的key>"
    group: "dsh"
```

**方式 B：环境变量**

```bash
export BARK_DEVICE_KEY="<你的key>"; dsh web
# Windows: setx BARK_DEVICE_KEY "<你的key>"
```

> ✅ key 只存在 `$DSH_HOME` 或环境变量里，**从不进入浏览器、从不写进共享的 bundle 补丁、从不写进日志**。

**怎么拿 key：** iPhone 装 Bark App → 用 Safari 打开 <https://api.day.app/profile> → 顶部 URL 里 `api.day.app/<key>/…` 的 `<key>` 就是你的。

---

## 完整配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `deviceKey` | 空（或环境变量 `BARK_DEVICE_KEY`） | Bark 推送 key |
| `group` | `dsh` | 通知分组（iOS 里折叠到一起） |
| `enabled` | `true` | 总开关；false = 完全禁用 |
| `triggers` | 见下 | 每个触发时机单独开关 |
| `withStats` | `true` | 在正文带 token 用量与耗时 |
| `withDeepLink` | `true` | 附带点击跳回会话的链接 |
| `titleTemplate` | `{status}` | 标题模板 |
| `bodyTemplate` | `{summary}{detail?}⏎{tokens} · {duration}` | 正文模板 |
| `summaryMaxLen` | `60` | 任务摘要最大字符数 |
| `deepLinkTemplate` | `dsh://sessions/{session}` | 点击跳转链接模板 |
| `timeoutMs` | `5000` | 推送 HTTP 超时（ms） |

### 触发时机（`triggers`）

默认只开「任务结束类」，把「等你 X」这类打断性通知默认关掉——**对小白友好，不刷屏**。

| 触发时机 | 状态头 | 默认 |
|---|---|---|
| `turn-end-completed` | ✅ 完成 | 开 |
| `turn-end-blocked` | 🚫 阻塞 | 开 |
| `turn-end-error` | ❌ 出错 | 开 |
| `turn-end-interrupted` | ⏸ 中断 | 开 |
| `turn-end-max-tokens` | ⚠️ 达Token上限 | 关 |
| `turn-end-aborted` | ⏹ 已取消 | 关 |
| `asking-you` | ❓ 等你回答 | 关 |
| `waiting-approval` | 🔐 等你授权 | 关 |
| `plan-review` | 📋 等你确认 | 关 |

示例：想额外在「等你授权」时也提醒：

```yaml
- id: dsh-plugin-bark
  config:
    deviceKey: "<你的key>"
    triggers:
      waiting-approval: true
```

### 模板占位符

`titleTemplate` / `bodyTemplate` 可用：

| 占位符 | 含义 |
|---|---|
| `{status}` | 状态头（✅ 完成 …） |
| `{summary}` | 任务摘要（用户输入文本） |
| `{detail}` | 事件细节（错误信息 / 等待授权的内容等） |
| `{detail?}` | 仅在 detail 与 summary 不同、非空时输出一行 |
| `{tokens}` | token 用量 `300→40` |
| `{duration}` | 耗时 `42.3s` |
| `{session}` | 会话 id |
| `{workspace}` | 工作目录名（路径末段） |

---

## 工作原理（事件模型）

插件订阅 DSH 的 `session/event` 流（`ctx.on('session/event', (session, event) => …)`）。`event` 的 envelope 为 `{ type, seq, time, data }`：

| 事件 | 关键 data | 用途 |
|---|---|---|
| `turn/start` | `{ turn }` | 记回合开始时间 |
| `user/message` | `UserMessage.content: ContentBlock[]` | 抓首次任务摘要 |
| `assistant/message` | `{ turn, step, message, usage? }` | 按回合累计 token |
| `turn/end` | `{ turn, reason: { kind } }` | 判定结束原因并推送 |
| `tool/call`(`ask_user_question`) / `approval/asked` / `exit_plan_mode` | — | 「等你 X」类提醒 |

**触发判定完全依据 `data.reason.kind`**（`completed` / `blocked` / `max-tokens` / `aborted` / `interrupted` / `error`），不靠猜事件名。

---

## 工程设计与健壮性

这是本插件与简单脚本的区别，也是「架构更完善」的地方：

- **事件去重**：以 `sessionId + event.seq` 记账，进程重连 / 会话回放**不会把同一条通知重复推给你**。账本有上限，防止内存无限增长。
- **key 绝不外泄**：错误信息、日志、生成的 URL 里都**不包含 key 本身**。
- **fire-and-forget**：推送是异步的，失败只记日志，**绝不阻塞或拖慢 agent**。
- **全程容错**：所有事件访问都带 `?.` / `typeof` 判空，任何异常事件形状都不会让插件崩溃。
- **可观测**：成功/失败都有清晰的 `[bark]` 级别日志。
- **资源有界**：并发跟踪的 session 数、去重账本容量都设了上限。

---

## 冒烟测试（不联网也能验证逻辑）

```bash
node smoke.mjs
```

用合成的事件流（假 key + 拦截 fetch）覆盖：completed / blocked / error / aborted 的默认开关、token 累计、深链 + 分组 + workspace、去重只推一次、asking-you 默认关 / 开启后解析问题、`enabled:false` 全禁用。共 **15 项断言**。

---

## Roadmap

- [x] 纯 Host 端：事件监听 / 去重 / token 累计 / 模板 / 深链
- [ ] **Web 设置面板**：在 DSH 设置页里可视化配置 key 与各开关（面向小白；key 通过 RPC 且掩码展示，仍不进浏览器）
- [ ] 更多通知通道（Telegram / 桌面通知 / 企业微信等），做成可插拔
- [ ] `dsh-routines` 定时任务结束后的结果摘要推送

---

## 声明

本插件为**独立开发**，架构与实现为原创。仅依赖 DSH 官方公开的事件模型与插件加载机制，遵循 DSH 官方的 bundle/profiffle 约定（`dsh.bundle`、`- insert:`、`dsh.profile.bundles`）。事件类型定义引用 DSH 官方 `@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-llm`。

## 参考

- DSH：`deepseek-ai/deepseek-harness`
- 官方发布教程：`docs/user/develop/basic/publish.md`
- 事件类型：`@deepseek-ai/dsh-session/lib/types/types.d.ts`、`@deepseek-ai/dsh-llm/lib/types/types.d.ts`
- Bark：<https://github.com/Finb/Bark>
