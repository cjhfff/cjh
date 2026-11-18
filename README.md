# cjh — 本地优先 AI 与 ACP 编码工作台（免安装绿色版）

基于 Electron + React 19 + Hono + WebSocket + 内置 `node:sqlite` (WAL) 构建的本地多模型与 ACP Agent 统一工作台。

## 核心特性

1. **纯免安装绿色分发（解压即用）**
   - 解压即可双击 `cjh.exe` 秒开，无注册表污染、不弹 UAC、无单文件 `%TEMP%` 解压延迟。
   - **双模数据目录**：若在 `cjh.exe` 同级目录新建 `data/` 文件夹，数据库（`cjh.db`）、密钥、附件、日志与 `runtime.json` 将全部保存在 `./data/` 中（整包拷走即迁移）；否则默认存放在 `%APPDATA%\cjh\`。
2. **中转站深度兼容（原生适配 `sub2api`）**
   - 支持 `openai-chat`、`openai-responses`、`anthropic` 三种协议切换。
   - 支持 `is_response_api`、`use_max_completion_tokens`、`custom_headers`、`api_version`，API Key 采用 Windows DPAPI（`safeStorage`）+ `AES-256-GCM` 信封加密存储。
3. **ACP 编码 Agent 无坑接入（Claude Agent / Codex / Gemini CLI）**
   - 全程 `shell: false` 参数数组启动，自动解析 Windows `.cmd` 垫片，彻底规避 `C:\Program Files\nodejs\` 空格路径断字问题。
   - 支持显式指定 CLI 可执行文件、一键清缓存重测、独立 `acp_env` 环境变量，以及**直接借用 `sub2api` 的 Key 与 Base URL**。
   - **Fail-Closed 安全权限门禁**：Agent 请求执行工具时置顶提醒并开启 60s 倒计时，超时、关闭或断连一律**默认拒绝**。
4. **树形多版本对话、工具模型杂活分离、MCP & Skills & `cjh` CLI**
   - 基于 `parent_id + slot_id` 支持重新生成、多版本 `< m / n >` 切换与任意节点回滚。
   - 独立配置轻量 `toolModel` 自动生成标题，用量在 `usage_records` 中按 `chat` / `aux` 分账统计。
   - 原生支持 `stdio` / `Streamable HTTP` MCP 服务、兼容扫描 `~/.claude/skills`，并随包附带 `resources\bin\cjh.cmd` 命令行工具。

---

## 常用命令

```powershell
# 本地开发热重载启动
npm run dev

# 类型检查与核心单元测试
npm run typecheck
npm test

# 生成免安装绿色目录版 -> dist-portable/win-unpacked/cjh.exe
npm run pack:dir

# 生成免安装绿色压缩包（用于分发或放到 Nginx 自更新源）
npm run pack:zip
```

## 免安装绿色版自更新配置（Nginx 静态目录）

在你的 HK / US Nginx 静态目录（例如 `https://hk.example.com/cjh-updates/`）放置 `npm run pack:zip` 产出的 `.zip` 包和一份 `latest.json`：

```json
{
  "version": "0.1.1",
  "url": "https://hk.example.com/cjh-updates/cjh-0.1.1-portable-x64.zip",
  "sha256": "<zip文件的sha256值>",
  "notes": "日常优化与修复"
}
```

在「用量与系统」页填入该更新源地址即可一键检查、校验下载并在重启瞬间自动原子替换程序文件（自动跳过并完整保留同级 `data/` 便携数据目录）。
