# 05 Provider 与 ACP

## 1. 模型的标识方式

全局统一用 **`providerId:modelId`** 这个字符串表示一个模型，例如 `sub2api:gpt-5.5`、`claude-agent-acp:opus`。

- 线程、设置、定时任务、渠道绑定里存的都是这个字符串
- 用户只写了模型名、没带前缀时，服务端在已启用的 provider 里查一遍，自动补上前缀

## 2. API 类 provider

### 拉模型

| 情况 | 做法 |
|---|---|
| OpenAI 兼容（openai / custom / openrouter / deepseek / moonshot / volcengine / azure …） | `GET {baseURL}/models`，带 `Authorization: Bearer <key>`，读返回里的 `data` 或 `models` 数组 |
| Anthropic | 走 Anthropic 的 models 接口 |
| 拉取失败 | 允许用户手动填模型 id |

### 模型能力

- 每个模型要有一份能力标注：`vision`、`reasoning`、`contextWindow`、`maxOutputTokens`、`streaming`、`functionCalling`
- Alma 先从 models.dev 拉一张公共能力表（缓存在本地，有 1.4 万条），30 秒内拉不下来就**按模型名猜**，5 分钟内不再重试
- 用户手动改过的能力项优先于自动探测的结果（`capabilities` 和 `autoDetectedCapabilities` 分开存）

**cjh 建议**：MVP 先不接 models.dev，只按模型名猜，再加上手动修改。你常用的模型就那么几个。

### 接中转站时要支持的开关

这几个开关是专门为各家 API 兼容性问题准备的，你的 sub2api 一定会用到：

- `api_format`：openai-chat / openai-responses / anthropic，决定按哪种协议发请求
- `is_response_api`：强制走 Responses API
- `use_max_completion_tokens`：用 `max_completion_tokens` 代替 `max_tokens`
- `custom_headers`：额外的请求头
- `api_version`：Azure 这类需要传版本号的

## 3. ACP agent

### 3.1 ACP 是什么

一个 agent 程序（比如 Claude Code、Codex）通过 **stdio 上的 JSON-RPC（每行一个 JSON）** 和客户端通信。客户端负责启动它，然后：

```
client → initialize            {protocolVersion:1, clientCapabilities:{fs, terminal}}
agent  ← 返回                   {protocolVersion, agentCapabilities, agentInfo, authMethods}
client → authenticate          （authMethods 不为空时才需要）
client → session/new           {cwd, mcpServers:[...]}
agent  ← 返回                   {sessionId, modes, configOptions:[mode, model, effort, fast, agent…], models?}
client → session/prompt        {sessionId, prompt:[content blocks]}
agent  → session/update 通知    （流式推送，见 3.4）
agent  → session/request_permission   （要执行工具时向客户端申请，客户端返回选中的 optionId）
agent  → fs/read_text_file、fs/write_text_file、terminal/*   （客户端声明支持这些能力时，agent 才会调用）
client → session/cancel
client → session/set_config_option 或 session/set_model     （切换模型、模式）
client → session/load          （恢复以前的会话，agent 支持 loadSession 时才可用）
```

### 3.2 常用 agent

| 名称 | npm 包 | 启动方式 | 备注 |
|---|---|---|---|
| Claude（官方） | `@agentclientprotocol/claude-agent-acp` | `claude-agent-acp` | Zed 团队维护，更新很勤。0.107.3 自带 Claude Code 2.1.325 |
| Claude（Alma 用的 fork） | `acp-extension-claude` | `acp-extension-claude` | 7 月以后没再更新，自带 Claude Code 2.1.197，拿不到新模型 |
| Codex | `@zed-industries/codex-acp` | `codex-acp` | Windows 上会解析出 native 的 `codex-acp.exe` 直接运行 |
| Gemini CLI | `@google/gemini-cli` | `gemini --experimental-acp` | |

### 3.3 启动 agent（Alma 的做法和问题）

Alma 按下面的顺序决定怎么启动 agent：

1. 命令是**绝对路径** → 直接本地运行
2. 是已知的 agent 别名，并且对应命令**在 PATH 里** → 用 PATH 里的那个
3. 是已知别名，但 PATH 里没有 → `npx -y <包名>`，超时 90 秒，失败后清掉 npx 缓存再重试一次
4. 都不是 → 原样执行，超时 15 秒

启动前还会处理环境变量：

- 把常见的 Node 安装目录补进 PATH
- 清空 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_SSE_PORT`，防止 agent 以为自己跑在另一个 Claude Code 里面
- 如果这个 provider 借用了别的 provider 的 key，就注入 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL`，同时清掉 `ANTHROPIC_API_KEY`，防止被它覆盖
- 用 npx 启动时使用独立的 npm 缓存目录

**它选 Claude Code 可执行文件的逻辑**（只对 Claude 适配器生效）：

- 用户设置了 `CLAUDE_CODE_EXECUTABLE` → 直接用
- 否则在 PATH 里找 `claude.exe` / `claude.cmd`。如果是 `.cmd`，就解析出里面指向的真实 exe，再跑 `--version`，跟适配器自带的版本比较，**本机的更新才用本机的**

### 3.4 把 session/update 映射成聊天内容

Alma 把整个 ACP agent 包装成了 AI SDK 的一个 LanguageModel（`provider="acp"`），这样它和普通 API 模型走同一条生成管线。映射关系：

| ACP 通知 | 转成 |
|---|---|
| `agent_message_chunk` | 文本增量 |
| `agent_thought_chunk` | 思考过程（reasoning）增量 |
| `tool_call` | 工具调用开始（toolCallId，工具名取 title，参数取 rawInput） |
| `tool_call_update` | 工具结果（rawOutput 或 content；status 为 failed 时标记为出错） |
| `plan` | 计划或待办列表的展示 |
| `usage_update` | token 用量 |
| `available_commands_update` | 斜杠命令列表 |
| `current_mode_update` / `config_option_update` | 同步当前的模式和模型 |

`session/request_permission` 会交给界面弹窗处理。

⚠ **Alma 有个危险的默认行为**：没有注册弹窗回调时，它**自动选第一个选项**，通常就是“允许”。cjh 一定要改成**默认拒绝**。

Alma 的 client 没有实现文件读写（调用 `fs/*` 会直接报错），文件操作全交给 agent 自己。cjh 可以照做，初始化时 `fs` 能力就不要声明。

### 3.5 把主程序的工具透传给 agent

provider 上配置 `acp_mcp_server_ids`，在 `session/new` 时把这些 MCP server 传给 agent。主程序自己的内置工具，则用一个本地的 MCP 代理（tool proxy）暴露出去。这样 Claude Code 在 agent 里也能调用主程序的记忆、定时任务这些能力。

## 4. 2026-11-17 实测踩过的坑（cjh 必须避开）

| # | 现象 | 原因 | cjh 怎么做 |
|---|---|---|---|
| 1 | 拉模型一直超时，日志报 `'C:\Program' is not recognized` | 通过 `cmd.exe` 调 `C:\Program Files\nodejs\npx.cmd`，路径带空格却没加引号 | **Windows 上绝不手工拼命令字符串**。`.cmd` 用 `spawn(cmd, args, {shell:false})` 不行，就解析 `.cmd` 里指向的 js 或 exe，改用 `spawn(process.execPath 或 node, [js, ...args])`；路径一律当作参数数组传 |
| 2 | 装好命令后还是走 npx | “命令在不在 PATH”的检查结果被缓存到进程退出，不重启永远不会重新检查 | 缓存要设 TTL，或者在用户点“刷新”时清缓存；设置页提供“重新检测” |
| 3 | 本机的 Claude CLI 没有被识别 | `.cmd` 解析只认 npm 生成的那一种格式，用户自己写的包装脚本被直接跳过 | 设置页直接让用户填 **Claude Code 可执行文件路径**，并显示检测到的版本 |
| 4 | 只能用改全局环境变量的方式让 agent 用指定 CLI | provider 上没有 env 字段 | provider 加 `acp_env`，启动 agent 时合并进去 |
| 5 | 设了 CLI 之后模型反而变少 | 模型列表由 Claude Code 版本决定，本机 CLI 比适配器自带的旧 | 模型列表旁边显示“当前用的 Claude Code 版本”，以及它是自带的还是本机的 |
| 6 | 新加的官方 agent 首次拉模型超时 | 本地启动只等 15 秒，但冷启动加上 sdk-initialize 实测要 4 到 8 秒，偶尔会更久 | 超时设 60 秒；启动后先发 initialize，拿到响应再开始计 session/new 的超时 |
| 7 | 日志里有 `Method not found: _auth/status_update` | agent 发了客户端不认识的通知 | **不认识的通知一律忽略**，不要当作错误抛出 |
| 8 | 旧版 Alma 只读 `models` 字段时拿不到模型 | 新版 agent 只在 `configOptions` 里返回模型 | 两种都要解析：优先用 `configOptions` 里 `id==="model"` 那一项的 `options`，没有再读 `models.availableModels` |
| 9 | 别名的含义会随版本变化 | `opus` 在 2.1.197 里是 Opus 4.8，在 2.1.325 里是 Opus 5.5 | 显示时把 `description` 一起展示（里面写了实际对应的版本），不要只显示别名 |

## 5. cjh 的 ACP 模块设计建议

```
AcpAgentManager
  spawnAgent(provider)      解析命令 → spawn（参数数组，不走 shell）→ 合并 acp_env
  discover(provider)        initialize → session/new → 解析模型、模式、命令 → 关闭进程 → 写入缓存
  getSession(threadId)      每个线程一个长连接的 agent 进程（按 provider 和 cwd 复用）
  prompt(threadId, parts)   把 session/update 转成和 API 模型一样的流式事件
  onPermission              推给前端弹窗；超时或拒绝时返回 reject
  cancel / dispose          线程删除、空闲超时、退出应用时清理子进程
```

可以直接用开源的 `@agentclientprotocol/sdk`（client 端）来写。

另外 npm 上有一个开源包 `@mcpc-tech/acp-ai-provider`，做的事情和 Alma 的 ACP 包装一样：把 ACP agent 包装成 AI SDK 的 provider。可以先评估一下能不能直接用，至少可以参考它的映射写法。
