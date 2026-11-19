---
name: cjh-self
description: 使用内置工具或 cjh CLI 管理 cjh 自身的对话线程、定时任务、记忆、全局搜索与系统设置。
---

# cjh 自身管理指南 (`cjh-self`)

当用户希望你查询或管理 cjh 工作台自身的线程、定时任务、用量或配置时，优先使用内置工具，必要时在工作区或终端中配合 `cjh` CLI 完成自动化操作。

## 1. 优先使用内置工具
- **定时任务**：
  - 查看已有任务：`cron_list`
  - 创建定时任务：`cron_create`（需用户确认，提供 `name`、`cronExpr` 5 段表达式、`timezone` 如 `Asia/Shanghai`、`prompt`、可选 `threadId` 和 `model`）
  - 删除定时任务：`cron_delete`（需用户确认）
- **用量统计**：调用 `usage_query`（可指定 `days`，默认 30 天）查看主对话与工具模型 Token 消耗明细。
- **记忆管理**：使用 `memory_save` 沉淀用户长期偏好/重要结论，使用 `memory_search` 检索历史记忆。

## 2. 使用 `cjh` CLI（适用于脚本、定时任务或批量操作）
守护进程运行时，免安装目录的 `resources\bin\cjh.cmd`（或打包环境 `bin\cjh.cmd`）会自动读取 `runtime.json` 中的本地端口与鉴权令牌：
- 状态与配置：`cjh status`、`cjh config`、`cjh models`
- 线程管理：`cjh threads`、`cjh new [标题]`、`cjh thread send <threadId> "<消息>"`（等待回复并输出）
- 定时任务：`cjh cron list`、`cjh cron add --name "..." --expr "30 7 * * *" --prompt "..."`、`cjh cron run <id>`、`cjh cron rm <id>`
- 全文检索与记忆：`cjh search "<关键词>"`、`cjh memory add --title "..." --content "..."`、`cjh memory search "<关键词>"`

## 3. 操作原则
- 创建/删除定时任务或执行写操作前，向用户简明说明变更内容，等待权限确认。
- 修改设置或调度任务后，核对返回值确认状态已生效。
