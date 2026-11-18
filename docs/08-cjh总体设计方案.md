# 08 cjh 总体系统与界面设计方案

本文档基于 `01`～`07` 的拆解资料与实际使用场景（主力 `sub2api` 中转 + Claude Code / Codex ACP 编码 Agent + 后续飞书与定时任务扩展），给出 **cjh** 第一阶段（M0～M3）可直接进入编码落地的完整设计定稿。

---

## 1. 核心架构决策（针对痛点的工程收敛）

### 1.1 单仓多入口结构（规避 `better-sqlite3` 打包坑）
采用 **`electron-vite` 单 `package.json` 多入口架构**，不拆 pnpm 多包 workspace（避免符号链接导致 `electron-builder` 打包 `.asar` 时丢失 `better-sqlite3` 原生 `.node` 绑定）：

```text
cjh/
├─ src/
│  ├─ main/                 # Electron 主进程：窗口、托盘、safeStorage(DPAPI)、自动更新、拉起 server
│  ├─ preload/              # 极薄桥接：仅暴露连接凭证获取、原生文件/目录选择框、打开外部路径
│  ├─ server/               # 核心守护进程（utilityProcess.fork 运行）：Hono + ws + SQLite + AI/ACP/MCP
│  │  ├─ db/                # Drizzle schema、迁移器、WAL 初始化
│  │  ├─ crypto/            # 接收主进程解封的 MasterKey，用 AES-256-GCM 加解密 api_key
│  │  ├─ engine/            # 统一生成管线（activeGenerations 锁、消息树装配、工具模型标题生成）
│  │  ├─ providers/         # Vercel AI SDK 工厂（OpenAI Chat / Responses / Anthropic 兼容开关）
│  │  ├─ acp/               # AcpAgentManager、会话池、Fail-Closed 权限门禁
│  │  ├─ mcp/               # McpHub（stdio + Streamable HTTP）
│  │  ├─ skills/            # 文件系统 SKILL.md 扫描与渐进式系统提示词注入
│  │  ├─ proc/              # Windows 安全的 ProcessSpawner（无 shell 参数数组、.cmd 解析）
│  │  └─ logger/            # 按日切分 + [Tag] 聚合日志
│  ├─ renderer/             # React 19 + Tailwind + shadcn/ui(Radix) + Zustand + TanStack Query + i18next
│  ├─ cli/                  # 零原生依赖的 `cjh` CLI，读取 runtime.json 调本地 HTTP/WS
│  └─ shared/               # 前后端与 CLI 共用的 Zod Schema、WS 事件契约、UIMessage 扩展类型
├─ resources/               # 托盘图标、内置默认配置、cjh.cmd 包装器
├─ docs/                    # 设计与参考文档
└─ electron.vite.config.ts
```

### 1.2 进程模型：`Electron Main` + `utilityProcess Server`
- **为什么用 `utilityProcess.fork` 跑 `src/server`**：
  1. 复用 Electron 自带的 Node 运行时，**与主进程共享完全一致的 Node ABI**，`better-sqlite3` 只需编译一份，也不依赖用户机器是否安装了 Node。
  2. 运行在独立 OS 子进程中，SQLite 同步读写与高频流式 delta 解析**零阻塞 GUI 渲染与窗口拖拽**。
  3. `src/server` 代码不耦合任何 Electron API，未来在 HK / US 服务器上可直接用 `node out/server/index.mjs` 无头运行。

### 1.3 本地 API 鉴权与 CLI 服务发现（`runtime.json`）
- 每次启动主进程生成 32 字节随机十六进制 `token`，`server` 绑定 `127.0.0.1:0`（操作系统随机分配空闲端口）。
- 所有 `/api/*` 请求校验 `Authorization: Bearer <token>`，WebSocket 握手校验 `?token=<token>`（同时校验 `Origin` 防止浏览器跨站 WebSocket 劫持）。
- 主进程启动成功后写入 `%APPDATA%\cjh\runtime.json`（仅当前 Windows 用户 ACL 可读，退出时自动删除）：
  ```json
  { "port": 54812, "token": "6f9c...", "pid": 18420, "startedAt": "2026-11-17T22:40:00+08:00" }
  ```
- 前端通过 `preload` 直接读取内存凭证；`cjh` CLI 读取 `runtime.json`；`server` 启动 ACP / MCP 子进程时自动注入 `CJH_API_URL` 与 `CJH_API_TOKEN` 环境变量。

### 1.4 密钥安全存储：DPAPI 信封加密（Envelope Encryption）
Electron 的 `safeStorage` 只存在于主进程，而数据库读写都在 `server` 子进程。采用**主密钥信封机制**：
1. 首次启动：主进程生成随机 32 字节 `masterKey`，调用 `safeStorage.encryptString`（Windows 底层走 DPAPI）写入 `%APPDATA%\cjh\master.key`。
2. 每次启动：主进程用 `safeStorage.decryptString` 解出 `masterKey`，通过进程间 IPC 私密通道传给 `server` 内存（绝不落盘、不走命令行参数）。
3. `server` 内部用 `AES-256-GCM` 对 `providers.api_key_enc` 加解密（密文格式 `enc:v1:<iv>:<authTag>:<cipher>`），兼顾零 IPC 延迟与系统级安全。

---

## 2. 数据库 Schema 定稿（SQLite WAL + Drizzle）

存储路径：`%APPDATA%\cjh\cjh.db`（开启 `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`）。

MVP 共设 **8 张表**（在 `03` 建议的 7 张表基础上，把附件二进制与消息表解耦防止大体积 Base64 拖慢查询，并用 `category + purpose` 在 `usage_records` 一张表内同时覆盖主对话与工具模型杂活用量）：

### 2.1 `providers`（模型与 ACP 来源）
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | 如 `sub2api`、`claude-acp`、`codex-acp`（构成 `providerId:modelId` 前缀） |
| `name` | `TEXT NOT NULL` | 显示名称 |
| `type` | `TEXT NOT NULL` | `'openai-compatible' \| 'openai' \| 'anthropic' \| 'acp'` |
| `api_format` | `TEXT NOT NULL` | `'openai-chat' \| 'openai-responses' \| 'anthropic'`（默认 `'openai-chat'`） |
| `is_response_api` | `INTEGER NOT NULL` | `0/1`，强制走 Responses API |
| `use_max_completion_tokens` | `INTEGER NOT NULL` | `0/1`，发送 `max_completion_tokens` 替代 `max_tokens` |
| `api_version` | `TEXT` | 可选 API 版本号 |
| `base_url` | `TEXT` | 中转或官方接口地址 |
| `api_key_enc` | `TEXT` | `AES-256-GCM` 密文 |
| `custom_headers` | `TEXT(JSON)` | `Record<string, string>` 额外请求头 |
| `models` | `TEXT(JSON)` | 已启用模型数组及用户覆盖能力（vision/reasoning/contextWindow/maxOutputTokens/functionCalling/description） |
| `available_models` | `TEXT(JSON)` | 远端或 ACP `discover` 拉取的原始缓存列表 |
| `acp_preset` | `TEXT` | `'claude' \| 'codex' \| 'gemini' \| 'custom' \| null` |
| `acp_command` | `TEXT` | 启动命令或别名（如 `claude-agent-acp`、`codex-acp`） |
| `acp_executable_path` | `TEXT` | 用户显式指定的底层 CLI 绝对路径（如 `C:\...\claude.exe`） |
| `acp_args` | `TEXT(JSON)` | `string[]` 启动参数 |
| `acp_env` | `TEXT(JSON)` | `Record<string, string>` 专属环境变量 |
| `acp_api_provider_id` | `TEXT` | 可选：借用另一个 Provider（如 `sub2api`）的 Key 与 Base URL |
| `acp_mcp_server_ids` | `TEXT(JSON)` | `string[]` 透传给该 ACP Agent 的 MCP ID 列表 |
| `enabled` | `INTEGER NOT NULL` | `0/1` |
| `sort_order` | `INTEGER NOT NULL` | 排序权重 |
| `created_at` / `updated_at` | `INTEGER` | 毫秒时间戳 |

### 2.2 `threads`（会话线程）
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | `nanoid()` |
| `title` | `TEXT NOT NULL` | 线程标题 |
| `title_source` | `TEXT NOT NULL` | `'default' \| 'auto' \| 'manual'`（手动改名后工具模型不再覆盖） |
| `model` | `TEXT` | `providerId:modelId` |
| `reasoning_effort` | `TEXT` | `'low' \| 'medium' \| 'high' \| null` |
| `fast_mode` | `INTEGER NOT NULL` | `0/1` |
| `active_leaf_id` | `TEXT` | 当前选中的消息树叶子节点 `messages.id` |
| `workspace_path` | `TEXT` | 绑定的本地工作目录（ACP `session/new` 的 `cwd`） |
| `enabled_mcp_ids` | `TEXT(JSON)` | `string[] \| null`（`null` 表示跟随全局已启用 MCP） |
| `skill_ids` | `TEXT(JSON)` | `string[] \| null` |
| `is_pinned` | `INTEGER NOT NULL` | `0/1` |
| `archived_at` | `INTEGER` | 归档时间 |
| `metadata` | `TEXT(JSON)` | 扩展字段（如 `acpSessionId`、渠道来源标记等） |
| `created_at` / `updated_at` | `INTEGER` | 毫秒时间戳（索引：`updated_at DESC`） |

### 2.3 `messages`（树形 UIMessage 存储）
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | 消息 ID |
| `thread_id` | `TEXT NOT NULL` | 外键关联 `threads.id ON DELETE CASCADE` |
| `parent_id` | `TEXT` | 父消息 ID（根节点为 `null`） |
| `slot_id` | `TEXT NOT NULL` | 同一轮重试/编辑的多个兄弟版本共享同一个 `slot_id` |
| `role` | `TEXT NOT NULL` | `'user' \| 'assistant' \| 'system'` |
| `message` | `TEXT(JSON) NOT NULL` | 完整 AI SDK `UIMessage`（`{ id, role, parts }`） |
| `metadata` | `TEXT(JSON)` | `{ providerId, model, latencyMs, finishReason, usage, error }` |
| `created_at` | `INTEGER NOT NULL` | 毫秒时间戳；复合索引 `(thread_id, parent_id)`、`(thread_id, slot_id)` |

### 2.4 `attachments`（本地附件索引，避免污染 SQLite 行大小）
| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `TEXT PK` | 附件 ID（在 `UIMessage.parts` 中引用为 `cjh-file://<id>`） |
| `thread_id` | `TEXT` | 关联线程（清理线程时可同步回收磁盘文件） |
| `file_name` | `TEXT NOT NULL` | 原始文件名 |
| `mime_type` | `TEXT NOT NULL` | MIME 类型 |
| `byte_size` | `INTEGER NOT NULL` | 字节大小 |
| `rel_path` | `TEXT NOT NULL` | 相对 `%APPDATA%\cjh\attachments\` 的存储路径 |
| `created_at` | `INTEGER NOT NULL` | 毫秒时间戳 |

### 2.5 `mcp_servers`、`usage_records`、`settings`、`schema_migrations`
- **`mcp_servers`**：`id`, `name`, `transport` (`'stdio' | 'streamable-http'`), `config` (JSON: `{ command, args, env }` 或 `{ url, headers }`), `enabled`, `created_at`, `updated_at`。（运行期连接状态与暴露工具列表缓存在内存并通过 WS 推送）。
- **`usage_records`**：`id`, `thread_id`, `message_id`, `category` (`'chat' | 'aux'`), `purpose` (`'reply' | 'title' | 'compact' | 'memory'`), `provider_id`, `model`, `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens`, `total_tokens`, `latency_ms`, `created_at`。
- **`settings`**：单行 `id = 1`，`data` (JSON，经由 `SettingsSchema` 校验：含 `general.theme`、`general.language`、`chat.defaultModel`、`toolModel.model`、`update.feedUrl`、`acp.permissionTimeoutSec`)，`updated_at`。

---

## 3. 统一生成引擎与 ACP 避坑设计

### 3.1 统一事件流抽象
无论底层是 `sub2api`（OpenAI Responses / Chat / Anthropic）还是 `claude-agent-acp` / `codex-acp`，统一转换为内部流事件，再经由 `GenerationEngine` 驱动 WebSocket 广播与落库：

```text
Entry (GUI / CLI / 后续 Cron / 后续飞书)
  ──► WS: generate_response
        ──► GenerationEngine (按 threadId 加锁)
              ├─ API Provider  ──► Vercel AI SDK streamText() ──┐
              └─ ACP Provider  ──► AcpAgentManager.prompt()   ──┼──► 统一 TurnEvent 流
                                                                ▼
                  实时推送 message_delta / tool_use / permission_requested
                                                                ▼
                  流结束落库 messages + usage_records ──► 推送 message_updated + generation_completed
                                                                ▼
                  若 title_source === 'default' ──► 异步调用 toolModel 生成标题 ──► title_generated
```

### 3.2 Windows 子进程与 ACP 9 大痛点逐一闭环（`ProcessSpawner` + `AcpAgentManager`）

| 痛点来源 | cjh 根治方案 |
|---|---|
| 1. `C:\Program Files\nodejs\npx.cmd` 空格断字报错 | 封装 `spawnSafe(cmd, args, env)`：**全程 `shell: false` + 参数数组**。遇到 `.cmd` 时优先解析 npm shim 提取真实 `node.exe` 与 `.js` 入口脚本直接运行；对无法静态提取的批处理使用 `ComSpec /d /s /c` 严格包裹双引号 |
| 2. PATH 检测永久缓存 | 命令路径探测缓存 **TTL = 30 秒**，且设置页提供 `[清缓存重新检测]` 按钮（`POST /api/providers/:id/redetect`） |
| 3. 自定义包装脚本漏识别 Claude CLI | Provider 配置直接提供 **`acp_executable_path`（文件选择器）**，并自动执行 `--version` 展示版本号 |
| 4. 被迫改系统全局环境变量 | `providers` 表原生支持 **`acp_env` 键值对** + **`acp_api_provider_id`（一键借用 `sub2api` 的 Key 和 Base URL）**，自动净化 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`ANTHROPIC_API_KEY` |
| 5. 本机旧版 CLI 导致模型变少 | 设置页与对话头部直观对比显示：`本机 CLI vX.Y.Z` vs `适配器内置 vA.B.C`，默认仅在本机版本 ≥ 内置版本（或用户强制指定路径）时选用本机 |
| 6. 首次拉取模型 15s 超时 | 拆分为两段独立超时：进程启动 + `initialize` 60 秒；拿到响应后 `session/new` 再给 60 秒 |
| 7. `_auth/status_update` 未知通知报错 | JSON-RPC 分发器对未注册的 notification 方法仅打 `[ACP:debug]` 日志，**静默忽略，绝不抛异常断流** |
| 8. 新旧协议模型列表字段不一致 | 优先解析 `configOptions.find(o => o.id === 'model')?.options`，若为空则回退读取 `models?.availableModels` |
| 9. `opus` 别名掩盖真实模型代数 | 模型选择器与消息头同时展示 `id` 与完整 `description`（如 `claude-acp:opus · Claude Opus 5.5`） |
| 安全红线：未弹窗默认放行权限 | **Fail-Closed 门禁**：无活跃监听客户端、窗口关闭、用户按 Esc 或 60 秒倒计时归零，**一律自动返回拒绝选项（`reject`）** |

---

## 4. 接口与 WebSocket 契约（精简定稿）

### 4.1 REST 路由（`/api/*`，全部带 Bearer Token）
- **系统与配置**：`GET /api/health`、`GET|PUT /api/settings`、`GET /api/usage/stats?range=7d`、`GET /api/data/export`、`POST /api/data/import`、`POST /api/logs/open-dir`、`GET /api/update/status`、`POST /api/update/check|download|install`
- **Providers & 模型**：`GET|POST /api/providers`、`PUT|DELETE /api/providers/:id`、`POST /api/providers/:id/test`、`POST /api/providers/:id/redetect`、`POST /api/providers/:id/models/fetch`、`GET /api/models`
- **线程与消息树**：`GET|POST /api/threads`、`GET|PUT|DELETE /api/threads/:id`、`POST /api/threads/batch-delete`、`GET /api/threads/:id/messages`（返回当前活跃分支路径 + 每个多版本 slot 的 `{ currentIndex, total, siblingIds }`）、`POST /api/messages/:id/switch-version`、`POST /api/messages/:id/rollback`、`POST /api/threads/:id/regenerate-title`、`GET /api/threads/:id/acp-commands`
- **附件与权限**：`POST /api/attachments`（multipart 上传）、`GET /api/attachments/:id`、`POST /api/permissions/:requestId/respond`
- **MCP 与技能（M3）**：`GET|POST /api/mcp-servers`、`PUT|DELETE /api/mcp-servers/:id`、`POST /api/mcp-servers/:id/reconnect`、`GET /api/mcp-servers/runtime`、`GET /api/skills`、`PUT /api/skills/:id`、`POST /api/skills/refresh`

### 4.2 WebSocket 消息契约
- **Client → Server**：
  1. `generate_response`：`{ threadId, userMessage?, model?, reasoningEffort?, enabledMCPServerIds?, retryOfMessageId?, replaceMessageId?, ephemeralContext?, source }`
  2. `stop_generation`：`{ threadId }`
  3. `permission_response`：`{ requestId, optionId }`（与 REST 双通道等价，方便纯 WS 客户端如后续飞书桥接也能审批权限！）
- **Server → Client**：
  - 生成态：`thread_status_changed`（`idle | generating | waiting_permission`）、`message_start`、`message_delta`、`tool_call_start`、`tool_call_update`、`permission_requested`、`permission_resolved`、`generation_completed`、`generation_error`
  - 数据同步：`message_added`、`message_updated`、`thread_created`、`thread_updated`、`thread_deleted`、`title_generated`、`settings_updated`、`provider_updated`、`mcp_status_changed`

---

## 5. 界面与交互规范（Clean-Room 独立视觉）

1. **三区单窗架构**：
   - **左侧栏（272px）**：顶部 `新建线程 (Ctrl+N)` + 搜索；第一分组固定为 **「需要关注」动态队列**（处于 `waiting_permission` 的线程带琥珀色呼吸边框置顶，`generating` 带运行指示灯），其下为「置顶」与「最近线程」；底部常驻 MCP 健康状态灯、今日 Token 速览与设置入口。
   - **中央对话舞台（最大阅读宽度 840px）**：
     - 顶部栏展示可编辑标题、工具模型生成标识、当前绑定的 `cwd` 工作目录胶囊（点击可切换目录，供 ACP Agent 使用）。
     - 消息流按 `UIMessage.parts` 渲染：折叠式推理思考卡片、带语法高亮/Diff 预览的工具调用卡片、**内联琥珀色权限审批门禁卡（含 60s 自动拒绝倒计时与快捷键提示）**、消息底部 `< 版本 m / n >` 切换器与 Token 遥测栏。
   - **底部 Composer 舱**：支持多行输入、`/` 斜杠命令补全、拖拽附件预览条、分组模型选择器（带视觉/推理/工具图标及真实版本描述）、推理强度切换、单线程 MCP 开关。
2. **设置与控制视图**（在同一窗口主区域内切换，不弹零散子窗口）：
   - 分为 **模型来源（Providers & ACP）**、**MCP 与技能扩展**、**用量与系统诊断** 三大面板，交互布局详见可交互原型。
3. **国际化与主题**：
   - 所有界面文案统一走 `i18next` key（首版内置 `zh-CN.json`），样式全量基于语义化 CSS 变量（天然支持深色 / 浅色一键切换）。

---

## 6. 分阶段实施里程碑（M0 → M3）

- **M0：工程骨架与安全底座（Day 1–2）**
  - 初始化 `electron-vite` + React + Tailwind + Radix + Drizzle (`better-sqlite3` WAL) + Hono + `ws`
  - 打通 `utilityProcess` 服务启动、`runtime.json` Bearer Token 鉴权、DPAPI `masterKey` 信封加解密、系统托盘、按日 `[Tag]` 日志与设置读写
- **M1：核心流式对话与 `sub2api` 闭环（Day 3–5）**
  - 完成 `providers` 管理页（OpenAI Chat / Responses / Anthropic 协议切换、`is_response_api`、`use_max_completion_tokens`、`custom_headers`、连接测试、拉取模型与能力手工覆盖）
  - 完成树形消息引擎（流式输出、停止生成、重新生成、`slot_id` 多版本切换、回滚、本地附件上传、`toolModel` 自动标题、`usage_records` 统计）
- **M2：ACP 编码 Agent 深度接入（Day 6–7）**
  - 实现 `ProcessSpawner`（Windows 无 shell 安全启动 + `.cmd` 解析 + CLI 版本检测对比）与 `AcpAgentManager`（`@agentclientprotocol/sdk`）
  - 支持内置预设（Claude 官方适配器、Codex、Gemini CLI）、`acp_env`、借用 `sub2api` 凭证、流式思考/工具卡片渲染、Fail-Closed 权限审批门禁
  - **里程碑验收**：在 `cjh` 中选择 Claude Agent 模型并绑定本地目录，成功审批权限并修改本地项目文件
- **M3：MCP + Skills + `cjh` CLI + 自动更新打包（Day 8–10）**
  - 接入 `@modelcontextprotocol/sdk`（`stdio` + `Streamable HTTP`），支持线程级勾选与状态重连
  - 实现技能目录扫描（含 `~/.claude/skills` 兼容读取）与系统提示词摘要注入
  - 构建 `cjh` CLI 与 `electron-builder` Windows 安装包，打通指向自建 Nginx 的 `electron-updater` 自动更新与全量数据导出
