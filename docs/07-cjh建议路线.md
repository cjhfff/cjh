# 07 cjh 建议路线

这些是给反重力做设计的建议，不是硬性要求。

## 1. 技术选型

| 层 | 建议 | 理由 |
|---|---|---|
| 桌面壳 | **Electron** | 全部用 TS，Claude Code 写起来最顺。Alma 的数据目录里留着从 Electron 迁移过来的标记，说明它早期很可能也是 Electron |
| 前端 | React + Vite + Tailwind + shadcn/ui（基于 Radix） | 和 Alma 同一套技术栈，组件现成 |
| 前端状态 | Zustand + TanStack Query | Query 管 REST 缓存，Zustand 管 WS 推过来的实时状态 |
| 本地服务 | 放在 Electron 主进程里，或者单独起一个 Node 子进程；用 Hono 提供 HTTP，`ws` 提供 WebSocket | 单独的子进程更好调试，也方便以后像 Alma 那样做不带界面的运行模式 |
| 数据库 | better-sqlite3 + drizzle-orm，开 WAL 模式 | 和 Alma 一样，经过了验证 |
| 模型调用 | Vercel AI SDK（`ai` + `@ai-sdk/openai` + `@ai-sdk/anthropic` + `@ai-sdk/openai-compatible`） | 消息格式直接用 UIMessage |
| ACP | `@agentclientprotocol/sdk`，可以先评估 `@mcpc-tech/acp-ai-provider` | 见 05 |
| MCP | `@modelcontextprotocol/sdk` | |
| 校验 | zod | 设置、provider 配置、WS 消息都要校验 |
| 打包和更新 | electron-builder + electron-updater，更新源用自建的 generic 服务器 | 更新源可以放在 HK 或 US 的 nginx 上 |
| CLI | `cjh` 命令，调本地 HTTP API | 让技能和外部 agent 能操作主程序 |

## 2. 里程碑

### M0：骨架（1 到 2 天）

- Electron + React + 本地服务跑起来，有托盘
- SQLite 和迁移机制，设置的读写
- 一个随机 token 保护本地 API

### M1：能聊天（2 到 3 天）

- provider 管理：OpenAI 兼容、Anthropic 两种类型，加上所有兼容开关，支持拉模型、测试连接
- **第一个 provider 就是你的 sub2api（`yangyue99.store`）**
- 线程列表、流式对话、停止、重新生成、版本切换、附件
- 工具模型自动生成标题
- 用量记录

### M2：ACP（2 天）

- ACP provider：填命令、参数、环境变量，拉模型
- 每个线程一个 agent 会话，流式显示文本、思考、工具调用
- 权限请求弹窗（默认拒绝）
- 内置预设：Claude Agent（官方适配器）、Codex

**验收标准**：在 cjh 里选 Claude Agent 的 Fable 5.2，能让它改一个本地项目里的文件。

### M3：MCP + 技能 + 打包（2 到 3 天）

- MCP server 管理（stdio 和 HTTP）
- 扫描技能目录，支持开关，注入系统提示词
- 出安装包，接上自动更新

### M4 之后（按需求排）

- 定时任务（先做 sub2api 日报）
- 飞书机器人桥接
- 终端和工作区
- 记忆
- 全文搜索
- 快速对话窗口

## 3. 从一开始就要定好的几件事

1. **模型 ID 统一用 `providerId:modelId`**
2. **消息统一用 UIMessage 格式**，以 JSON 整条存储，不要拆成多张表
3. **所有入口都走 WS 的 `generate_response`**，包括 GUI、定时任务、渠道、CLI
4. **只在 Windows 上开发也要按跨平台的方式启动子进程**：参数数组、不走 shell、路径带空格要能处理
5. **日志按 tag 区分**（`[ACP]`、`[MCP]`、`[Bridge:feishu]`…），统一写到一个按天切分的文件里，设置页能一键打开日志目录
6. **所有文案用 i18n key**，哪怕现在只有中文
7. **本地 API 要带 token**

## 4. 不要做的

- 不要拷贝 Alma 的代码、文案、图标、产品名
- 不要第一版就做多 agent 协作、记忆睡眠、活动记录、团队这类功能。Alma 的功能面已经很宽，大部分你不一定用得上
- 不要把 Go 和 Node 混着用。Alma 正在把生成链路迁到 Go，那是规模上去之后的优化
