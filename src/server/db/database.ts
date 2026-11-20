import { DatabaseSync } from 'node:sqlite'
import { nanoid } from 'nanoid'
import {
  AcpModeOption,
  AppSettings,
  AppSettingsPatch,
  ChannelMappingDto,
  CompositeModelOption,
  CronJobDto,
  CronJobUpsertInput,
  CronRunDto,
  ExecutionTraceDto,
  ExecutionTraceToolCallItem,
  McpServerUpsertInput,
  MessageMetadata,
  ModelCapabilities,
  ModelDefinition,
  PromptTemplateDto,
  PromptTemplateUpsertInput,
  ProviderDto,
  ProviderUpsertInput,
  SearchMessageHitDto,
  SearchResponseDto,
  SettingsSchema,
  StoredMessageDto,
  ThreadDto,
  ThreadRuntimeStatus,
  UIMessage
} from '@shared/schemas'
import { SecretVault } from '../crypto/vault'

const INITIAL_MIGRATION_ID = '001_initial_schema'
const MIGRATION_002_ID = '002_acp_permission_mode'
const MIGRATION_003_ID = '003_cron_jobs'
const MIGRATION_004_ID = '004_messages_fts'
const MIGRATION_005_ID = '005_prompts'
const MIGRATION_006_ID = '006_thread_branching'
const MIGRATION_007_ID = '007_traces'
const MIGRATION_008_ID = '008_r1_tools_and_secrets'
const MIGRATION_009_ID = '009_r2_preset_prompts'
const MIGRATION_010_ID = '010_r4_memories'
const MIGRATION_011_ID = '011_r3_feishu_bridge'

export type ProviderDbUpsertInput = Omit<
  ProviderUpsertInput,
  'acpPermissionMode' | 'acpAvailableModes' | 'acpLastModeId'
> &
  Partial<Pick<ProviderUpsertInput, 'acpPermissionMode' | 'acpAvailableModes' | 'acpLastModeId'>>

const INITIAL_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  api_format TEXT NOT NULL DEFAULT 'openai-chat',
  is_response_api INTEGER NOT NULL DEFAULT 0,
  use_max_completion_tokens INTEGER NOT NULL DEFAULT 0,
  api_version TEXT,
  base_url TEXT,
  api_key_enc TEXT,
  custom_headers TEXT NOT NULL DEFAULT '{}',
  models TEXT NOT NULL DEFAULT '[]',
  available_models TEXT NOT NULL DEFAULT '[]',
  acp_preset TEXT,
  acp_command TEXT,
  acp_executable_path TEXT,
  acp_args TEXT NOT NULL DEFAULT '[]',
  acp_env TEXT NOT NULL DEFAULT '{}',
  acp_api_provider_id TEXT,
  acp_mcp_server_ids TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_source TEXT NOT NULL DEFAULT 'default',
  model TEXT,
  reasoning_effort TEXT,
  fast_mode INTEGER NOT NULL DEFAULT 0,
  active_leaf_id TEXT,
  workspace_path TEXT,
  enabled_mcp_ids TEXT,
  skill_ids TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id TEXT,
  slot_id TEXT NOT NULL,
  role TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread_parent ON messages(thread_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_slot ON messages(thread_id, slot_id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills_state (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  message_id TEXT,
  category TEXT NOT NULL DEFAULT 'chat',
  purpose TEXT NOT NULL DEFAULT 'reply',
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage_records(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export function guessModelCapabilities(modelId: string): ModelCapabilities {
  const lower = modelId.toLowerCase()
  const isReasoning =
    /o1|o3|o4|reasoner|r1|thinking|opus|gpt-5|claude-3-7|claude-4|sonnet-4|gemini-2\.5|gemini-3/i.test(
      lower
    )
  const isVision =
    /gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-4|opus|sonnet|haiku|gemini|vl|vision|o4|o3/i.test(
      lower
    )
  return {
    vision: isVision,
    reasoning: isReasoning,
    streaming: true,
    functionCalling: true
  }
}

export class AppDatabase {
  public readonly sqlite: DatabaseSync
  private vault: SecretVault

  constructor(dbPath: string, vault: SecretVault) {
    this.sqlite = new DatabaseSync(dbPath)
    this.vault = vault
    this.init()
  }

  private init(): void {
    this.sqlite.exec('PRAGMA journal_mode = WAL;')
    this.sqlite.exec('PRAGMA synchronous = NORMAL;')
    this.sqlite.exec('PRAGMA foreign_keys = ON;')
    this.sqlite.exec('PRAGMA busy_timeout = 5000;')
    this.sqlite.exec(INITIAL_SQL)

    const applied = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(INITIAL_MIGRATION_ID)
    if (!applied) {
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(INITIAL_MIGRATION_ID, Date.now())
    }

    this.applyMigrations()

    const provCountRow = this.sqlite
      .prepare('SELECT COUNT(*) as cnt FROM providers')
      .get() as { cnt: number } | undefined
    const hasExistingProviders = Number(provCountRow?.cnt || 0) > 0

    const settingsRow = this.sqlite.prepare('SELECT data FROM settings WHERE id = 1').get() as
      | { data: string }
      | undefined
    if (!settingsRow) {
      const defaults = SettingsSchema.parse({
        general: { onboardingCompleted: hasExistingProviders }
      })
      this.sqlite
        .prepare('INSERT INTO settings (id, data, updated_at) VALUES (1, ?, ?)')
        .run(JSON.stringify(defaults), Date.now())
    } else if (hasExistingProviders) {
      try {
        const rawObj = JSON.parse(settingsRow.data) || {}
        if (
          !rawObj.general ||
          typeof rawObj.general !== 'object' ||
          rawObj.general.onboardingCompleted === undefined
        ) {
          const upgraded = SettingsSchema.parse({
            ...rawObj,
            general: {
              ...(rawObj.general && typeof rawObj.general === 'object' ? rawObj.general : {}),
              onboardingCompleted: true
            }
          })
          this.sqlite
            .prepare('UPDATE settings SET data = ?, updated_at = ? WHERE id = 1')
            .run(JSON.stringify(upgraded), Date.now())
        }
      } catch {
        // Ignore malformed settings JSON
      }
    }
  }

  private applyMigrations(): void {
    const applied002 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_002_ID)
    if (!applied002) {
      const cols = this.sqlite.prepare('PRAGMA table_info(providers)').all() as Array<{
        name: string
      }>
      const colNames = new Set(cols.map(c => c.name))
      if (!colNames.has('acp_permission_mode')) {
        this.sqlite.exec(
          "ALTER TABLE providers ADD COLUMN acp_permission_mode TEXT NOT NULL DEFAULT 'default';"
        )
      }
      if (!colNames.has('acp_available_modes')) {
        this.sqlite.exec(
          "ALTER TABLE providers ADD COLUMN acp_available_modes TEXT NOT NULL DEFAULT '[]';"
        )
      }
      if (!colNames.has('acp_last_mode_id')) {
        this.sqlite.exec('ALTER TABLE providers ADD COLUMN acp_last_mode_id TEXT;')
      }
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_002_ID, Date.now())
    }

    const applied003 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_003_ID)
    if (!applied003) {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS cron_jobs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          cron_expr TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
          thread_id TEXT,
          prompt TEXT NOT NULL,
          model TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          last_run_at INTEGER,
          next_run_at INTEGER,
          last_status TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cron_runs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
          thread_id TEXT,
          message_id TEXT,
          trigger_type TEXT NOT NULL DEFAULT 'schedule',
          status TEXT NOT NULL,
          error TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started ON cron_runs(job_id, started_at DESC);
      `)
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_003_ID, Date.now())
    }

    const applied004 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_004_ID)
    if (!applied004) {
      this.sqlite.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          message_id UNINDEXED,
          thread_id UNINDEXED,
          role UNINDEXED,
          content,
          tokenize='trigram'
        );
      `)
      const existingMsgs = this.sqlite
        .prepare('SELECT id, thread_id, role, message FROM messages')
        .all() as Array<{ id: string; thread_id: string; role: string; message: string }>
      const ins = this.sqlite.prepare(
        'INSERT INTO messages_fts (message_id, thread_id, role, content) VALUES (?, ?, ?, ?)'
      )
      for (const row of existingMsgs) {
        try {
          const parsed = JSON.parse(row.message) as UIMessage
          const text = this.extractSearchableContent(parsed)
          if (text) {
            ins.run(row.id, row.thread_id, row.role, text)
          }
        } catch {
          // Ignore malformed message row
        }
      }
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_004_ID, Date.now())
    }

    const applied005 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_005_ID)
    if (!applied005) {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS prompts (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          shortcut TEXT,
          content TEXT NOT NULL,
          category TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_005_ID, Date.now())
    }

    const applied006 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_006_ID)
    if (!applied006) {
      const cols = this.sqlite.prepare('PRAGMA table_info(threads)').all() as Array<{
        name: string
      }>
      const colNames = new Set(cols.map(c => c.name))
      if (!colNames.has('parent_thread_id')) {
        this.sqlite.exec('ALTER TABLE threads ADD COLUMN parent_thread_id TEXT;')
      }
      if (!colNames.has('branch_from_message_id')) {
        this.sqlite.exec('ALTER TABLE threads ADD COLUMN branch_from_message_id TEXT;')
      }
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_006_ID, Date.now())
    }

    const applied007 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_007_ID)
    if (!applied007) {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS traces (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'gui',
          status TEXT NOT NULL,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cached_input_tokens INTEGER NOT NULL DEFAULT 0,
          reasoning_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          tool_calls TEXT NOT NULL DEFAULT '[]',
          error TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_traces_message_id ON traces(message_id);
        CREATE INDEX IF NOT EXISTS idx_traces_thread_started ON traces(thread_id, started_at DESC);
      `)
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_007_ID, Date.now())
    }

    const applied008 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_008_ID)
    if (!applied008) {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS app_secrets (
          key TEXT PRIMARY KEY,
          value_enc TEXT,
          updated_at INTEGER NOT NULL
        );
      `)
      const cols = this.sqlite.prepare('PRAGMA table_info(threads)').all() as Array<{
        name: string
      }>
      const colNames = new Set(cols.map(c => c.name))
      if (!colNames.has('builtin_tools_enabled')) {
        this.sqlite.exec(
          'ALTER TABLE threads ADD COLUMN builtin_tools_enabled INTEGER NOT NULL DEFAULT 1;'
        )
      }
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_008_ID, Date.now())
    }

    const applied009 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_009_ID)
    if (!applied009) {
      const now = Date.now()
      const presets = [
        {
          id: 'preset-summarize',
          title: '总结要点',
          shortcut: 'summarize',
          category: '效率',
          content:
            '请对以下内容进行结构化总结：\n1. 一句话核心结论\n2. 关键要点（3~5 条）\n3. 后续待办或风险提示\n\n原文如下：\n'
        },
        {
          id: 'preset-translate',
          title: '中英精准翻译',
          shortcut: 'translate',
          category: '写作',
          content:
            '请将以下内容翻译为自然流畅的目标语言（中文翻英文 / 英文翻中文），准确保留专有名词与技术术语：\n\n'
        },
        {
          id: 'preset-polish',
          title: '专业文本润色',
          shortcut: 'polish',
          category: '写作',
          content:
            '请润色以下文本，在不改变原意的前提下提升逻辑清晰度、简洁度与专业表达，并简要说明主要修改点：\n\n'
        },
        {
          id: 'preset-explain-code',
          title: '解释代码逻辑',
          shortcut: 'explain',
          category: '研发',
          content:
            '请逐段解释以下代码的核心职责、输入输出、关键状态流转，以及可能存在的边界条件或潜在隐患：\n\n'
        },
        {
          id: 'preset-commit-msg',
          title: '生成提交信息',
          shortcut: 'commit',
          category: '研发',
          content:
            '请根据当前改动或以下 diff 生成符合 Conventional Commits 规范的 git commit message（包含简洁标题与要点说明）：\n\n'
        }
      ]
      const stmt = this.sqlite.prepare(
        'INSERT OR IGNORE INTO prompts (id, title, shortcut, content, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const p of presets) {
        stmt.run(p.id, p.title, p.shortcut, p.content, p.category, now, now)
      }
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_009_ID, Date.now())
    }

    const applied010 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_010_ID)
    if (!applied010) {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          tags TEXT NOT NULL DEFAULT '[]',
          source_thread_id TEXT,
          file_name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          memory_id UNINDEXED,
          title,
          tags,
          content,
          tokenize='trigram'
        );
      `)
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_010_ID, Date.now())
    }

    const applied011 = this.sqlite
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get(MIGRATION_011_ID)
    if (!applied011) {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS channel_mappings (
          id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          external_chat_id TEXT NOT NULL,
          external_user_id TEXT NOT NULL,
          chat_type TEXT NOT NULL DEFAULT 'p2p',
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(platform, external_chat_id, external_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_channel_mappings_thread ON channel_mappings(thread_id);
      `)
      const cronCols = this.sqlite.prepare('PRAGMA table_info(cron_jobs)').all() as Array<{
        name: string
      }>
      if (!cronCols.some(c => c.name === 'feishu_chat_id')) {
        this.sqlite.exec('ALTER TABLE cron_jobs ADD COLUMN feishu_chat_id TEXT;')
      }
      this.sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(MIGRATION_011_ID, Date.now())
    }
  }

  close(): void {
    this.sqlite.close()
  }

  // ==================== App Secrets & Settings ====================

  getSecret(key: string): string | null {
    try {
      const row = this.sqlite
        .prepare('SELECT value_enc FROM app_secrets WHERE key = ?')
        .get(key) as { value_enc: string | null } | undefined
      if (!row || !row.value_enc) return null
      return this.vault.decrypt(row.value_enc)
    } catch {
      return null
    }
  }

  setSecret(key: string, plainValue: string | null): void {
    if (!plainValue || !plainValue.trim()) {
      this.sqlite.prepare('DELETE FROM app_secrets WHERE key = ?').run(key)
      return
    }
    const enc = this.vault.encrypt(plainValue.trim())
    this.sqlite
      .prepare(
        'INSERT INTO app_secrets (key, value_enc, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at'
      )
      .run(key, enc, Date.now())
  }

  getSettings(): AppSettings {
    const row = this.sqlite.prepare('SELECT data FROM settings WHERE id = 1').get() as
      | { data: string }
      | undefined
    const tavilyPlain = this.getSecret('web_search.tavily_api_key')
    const bravePlain = this.getSecret('web_search.brave_api_key')
    const feishuSecretPlain = this.getSecret('channels.feishu.app_secret')

    let rawObj: Record<string, unknown> = {}
    if (row) {
      try {
        rawObj = JSON.parse(row.data) || {}
      } catch {
        rawObj = {}
      }
    }

    const base = SettingsSchema.parse(rawObj)
    return SettingsSchema.parse({
      ...base,
      tools: {
        ...base.tools,
        webSearch: {
          ...base.tools.webSearch,
          hasTavilyApiKey: Boolean(tavilyPlain),
          tavilyApiKeyPreview: SecretVault.mask(tavilyPlain),
          hasBraveApiKey: Boolean(bravePlain),
          braveApiKeyPreview: SecretVault.mask(bravePlain)
        }
      },
      channels: {
        ...base.channels,
        feishu: {
          ...base.channels.feishu,
          hasAppSecret: Boolean(feishuSecretPlain),
          appSecretPreview: SecretVault.mask(feishuSecretPlain)
        }
      }
    })
  }

  updateSettings(patch: AppSettingsPatch): AppSettings {
    if (patch.tools?.webSearch?.tavilyApiKey !== undefined) {
      this.setSecret('web_search.tavily_api_key', patch.tools.webSearch.tavilyApiKey)
    }
    if (patch.tools?.webSearch?.braveApiKey !== undefined) {
      this.setSecret('web_search.brave_api_key', patch.tools.webSearch.braveApiKey)
    }
    if (patch.channels?.feishu?.appSecret !== undefined) {
      this.setSecret('channels.feishu.app_secret', patch.channels.feishu.appSecret)
    }

    const current = this.getSettings()
    const nextWebSearch = {
      ...current.tools.webSearch,
      ...(patch.tools?.webSearch?.backend !== undefined
        ? { backend: patch.tools.webSearch.backend }
        : {}),
      ...(patch.tools?.webSearch?.searxngUrl !== undefined
        ? { searxngUrl: patch.tools.webSearch.searxngUrl }
        : {})
    }
    const nextFeishu = {
      ...current.channels.feishu,
      ...(patch.channels?.feishu?.enabled !== undefined
        ? { enabled: patch.channels.feishu.enabled }
        : {}),
      ...(patch.channels?.feishu?.appId !== undefined
        ? { appId: patch.channels.feishu.appId }
        : {}),
      ...(patch.channels?.feishu?.domain !== undefined
        ? { domain: patch.channels.feishu.domain }
        : {}),
      ...(patch.channels?.feishu?.notifyChatId !== undefined
        ? { notifyChatId: patch.channels.feishu.notifyChatId }
        : {})
    }
    const nextHerdr = {
      ...current.herdr,
      ...(patch.herdr?.execPath !== undefined ? { execPath: patch.herdr.execPath } : {}),
      ...(patch.herdr?.agentCommands !== undefined
        ? { agentCommands: patch.herdr.agentCommands }
        : {}),
      ...(patch.herdr?.mutedTerminals !== undefined
        ? { mutedTerminals: patch.herdr.mutedTerminals }
        : {}),
      ...(patch.herdr?.desktopNotifications !== undefined
        ? { desktopNotifications: patch.herdr.desktopNotifications }
        : {})
    }
    const merged = SettingsSchema.parse({
      general: { ...current.general, ...(patch.general || {}) },
      chat: { ...current.chat, ...(patch.chat || {}) },
      toolModel: { ...current.toolModel, ...(patch.toolModel || {}) },
      acp: { ...current.acp, ...(patch.acp || {}) },
      tools: {
        ...current.tools,
        ...(patch.tools?.autoApproveReadOnly !== undefined
          ? { autoApproveReadOnly: patch.tools.autoApproveReadOnly }
          : {}),
        ...(patch.tools?.maxSteps !== undefined ? { maxSteps: patch.tools.maxSteps } : {}),
        ...(patch.tools?.shellTimeoutSec !== undefined
          ? { shellTimeoutSec: patch.tools.shellTimeoutSec }
          : {}),
        ...(patch.tools?.memoryAutoInject !== undefined
          ? { memoryAutoInject: patch.tools.memoryAutoInject }
          : {}),
        webSearch: nextWebSearch
      },
      channels: {
        feishu: nextFeishu
      },
      herdr: nextHerdr,
      update: { ...current.update, ...(patch.update || {}) }
    })
    this.sqlite
      .prepare('UPDATE settings SET data = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(merged), Date.now())
    return this.getSettings()
  }

  // ==================== Providers ====================

  private mapProviderRow(row: Record<string, unknown>): ProviderDto {
    const enc = (row.api_key_enc as string | null) ?? null
    const plain = this.vault.decrypt(enc)
    return {
      id: String(row.id),
      name: String(row.name),
      type: row.type as ProviderDto['type'],
      apiFormat: (row.api_format as ProviderDto['apiFormat']) || 'openai-chat',
      isResponseApi: Boolean(row.is_response_api),
      useMaxCompletionTokens: Boolean(row.use_max_completion_tokens),
      apiVersion: (row.api_version as string | null) ?? null,
      baseUrl: (row.base_url as string | null) ?? null,
      hasApiKey: Boolean(plain),
      apiKeyPreview: SecretVault.mask(plain),
      customHeaders: JSON.parse(String(row.custom_headers || '{}')),
      models: JSON.parse(String(row.models || '[]')),
      availableModels: JSON.parse(String(row.available_models || '[]')),
      acpPreset: (row.acp_preset as ProviderDto['acpPreset']) ?? null,
      acpCommand: (row.acp_command as string | null) ?? null,
      acpExecutablePath: (row.acp_executable_path as string | null) ?? null,
      acpArgs: JSON.parse(String(row.acp_args || '[]')),
      acpEnv: JSON.parse(String(row.acp_env || '{}')),
      acpApiProviderId: (row.acp_api_provider_id as string | null) ?? null,
      acpMcpServerIds: JSON.parse(String(row.acp_mcp_server_ids || '[]')),
      acpPermissionMode: String(row.acp_permission_mode || 'default'),
      acpAvailableModes: JSON.parse(String(row.acp_available_modes || '[]')),
      acpLastModeId: (row.acp_last_mode_id as string | null) ?? null,
      enabled: Boolean(row.enabled),
      sortOrder: Number(row.sort_order ?? 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  listProviders(): ProviderDto[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM providers ORDER BY sort_order ASC, created_at ASC')
      .all() as Array<Record<string, unknown>>
    return rows.map(r => this.mapProviderRow(r))
  }

  getProvider(id: string): ProviderDto | null {
    const row = this.sqlite.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapProviderRow(row) : null
  }

  getProviderSecretKey(id: string): string | null {
    const row = this.sqlite
      .prepare('SELECT api_key_enc FROM providers WHERE id = ?')
      .get(id) as { api_key_enc: string | null } | undefined
    if (!row) return null
    return this.vault.decrypt(row.api_key_enc)
  }

  upsertProvider(input: ProviderDbUpsertInput, explicitId?: string): ProviderDto {
    const id = explicitId || input.id || nanoid(10)
    const existing = this.sqlite.prepare('SELECT * FROM providers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    const now = Date.now()

    let apiKeyEnc: string | null = existing ? (existing.api_key_enc as string | null) : null
    if (input.apiKey !== undefined) {
      apiKeyEnc = input.apiKey ? this.vault.encrypt(input.apiKey.trim()) : null
    }

    const acpPermissionMode =
      input.acpPermissionMode ??
      (existing ? (existing.acp_permission_mode as string | null) : null) ??
      'default'
    const acpAvailableModesJson =
      input.acpAvailableModes !== undefined
        ? JSON.stringify(input.acpAvailableModes)
        : existing
          ? String(existing.acp_available_modes || '[]')
          : '[]'
    const acpLastModeId =
      input.acpLastModeId !== undefined
        ? (input.acpLastModeId ?? null)
        : existing
          ? ((existing.acp_last_mode_id as string | null) ?? null)
          : null

    if (!existing) {
      this.sqlite
        .prepare(
          `INSERT INTO providers (
            id, name, type, api_format, is_response_api, use_max_completion_tokens,
            api_version, base_url, api_key_enc, custom_headers, models, available_models,
            acp_preset, acp_command, acp_executable_path, acp_args, acp_env,
            acp_api_provider_id, acp_mcp_server_ids, acp_permission_mode,
            acp_available_modes, acp_last_mode_id, enabled, sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.name,
          input.type,
          input.apiFormat,
          input.isResponseApi ? 1 : 0,
          input.useMaxCompletionTokens ? 1 : 0,
          input.apiVersion ?? null,
          input.baseUrl ?? null,
          apiKeyEnc,
          JSON.stringify(input.customHeaders || {}),
          JSON.stringify(input.models || []),
          JSON.stringify(input.availableModels || []),
          input.acpPreset ?? null,
          input.acpCommand ?? null,
          input.acpExecutablePath ?? null,
          JSON.stringify(input.acpArgs || []),
          JSON.stringify(input.acpEnv || {}),
          input.acpApiProviderId ?? null,
          JSON.stringify(input.acpMcpServerIds || []),
          acpPermissionMode,
          acpAvailableModesJson,
          acpLastModeId,
          input.enabled ? 1 : 0,
          input.sortOrder ?? 0,
          now,
          now
        )
    } else {
      this.sqlite
        .prepare(
          `UPDATE providers SET
            name = ?, type = ?, api_format = ?, is_response_api = ?, use_max_completion_tokens = ?,
            api_version = ?, base_url = ?, api_key_enc = ?, custom_headers = ?, models = ?, available_models = ?,
            acp_preset = ?, acp_command = ?, acp_executable_path = ?, acp_args = ?, acp_env = ?,
            acp_api_provider_id = ?, acp_mcp_server_ids = ?, acp_permission_mode = ?,
            acp_available_modes = ?, acp_last_mode_id = ?, enabled = ?, sort_order = ?, updated_at = ?
          WHERE id = ?`
        )
        .run(
          input.name,
          input.type,
          input.apiFormat,
          input.isResponseApi ? 1 : 0,
          input.useMaxCompletionTokens ? 1 : 0,
          input.apiVersion ?? null,
          input.baseUrl ?? null,
          apiKeyEnc,
          JSON.stringify(input.customHeaders || {}),
          JSON.stringify(input.models || []),
          JSON.stringify(input.availableModels || []),
          input.acpPreset ?? null,
          input.acpCommand ?? null,
          input.acpExecutablePath ?? null,
          JSON.stringify(input.acpArgs || []),
          JSON.stringify(input.acpEnv || {}),
          input.acpApiProviderId ?? null,
          JSON.stringify(input.acpMcpServerIds || []),
          acpPermissionMode,
          acpAvailableModesJson,
          acpLastModeId,
          input.enabled ? 1 : 0,
          input.sortOrder ?? Number(existing.sort_order ?? 0),
          now,
          id
        )
    }
    return this.getProvider(id)!
  }

  updateProviderAcpModeInfo(
    id: string,
    availableModes: AcpModeOption[],
    lastModeId?: string | null
  ): ProviderDto | null {
    const existing = this.getProvider(id)
    if (!existing) return null
    const nextModes = availableModes.length ? availableModes : existing.acpAvailableModes
    const nextLastModeId = lastModeId !== undefined ? lastModeId : existing.acpLastModeId
    this.sqlite
      .prepare(
        'UPDATE providers SET acp_available_modes = ?, acp_last_mode_id = ?, updated_at = ? WHERE id = ?'
      )
      .run(JSON.stringify(nextModes), nextLastModeId ?? null, Date.now(), id)
    return this.getProvider(id)
  }

  updateProviderModels(
    id: string,
    models: ModelDefinition[],
    availableModels?: ModelDefinition[]
  ): ProviderDto | null {
    const existing = this.getProvider(id)
    if (!existing) return null
    this.sqlite
      .prepare('UPDATE providers SET models = ?, available_models = ?, updated_at = ? WHERE id = ?')
      .run(
        JSON.stringify(models),
        JSON.stringify(availableModels ?? existing.availableModels),
        Date.now(),
        id
      )
    return this.getProvider(id)
  }

  deleteProvider(id: string): boolean {
    const res = this.sqlite.prepare('DELETE FROM providers WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  listCompositeModels(): CompositeModelOption[] {
    const providers = this.listProviders().filter(p => p.enabled)
    const out: CompositeModelOption[] = []
    for (const p of providers) {
      for (const m of p.models) {
        if (!m.enabled) continue
        out.push({
          compositeId: `${p.id}:${m.id}`,
          providerId: p.id,
          providerName: p.name,
          providerType: p.type,
          modelId: m.id,
          modelName: m.name || m.id,
          description: m.description,
          capabilities: m.capabilities || guessModelCapabilities(m.id)
        })
      }
    }
    return out
  }

  resolveModelString(rawModel?: string | null): { provider: ProviderDto; modelId: string } | null {
    const enabledProviders = this.listProviders().filter(p => p.enabled)
    if (!enabledProviders.length) return null

    const candidate = (rawModel || '').trim()
    if (candidate.includes(':')) {
      const idx = candidate.indexOf(':')
      const providerId = candidate.slice(0, idx)
      const modelId = candidate.slice(idx + 1)
      const provider = enabledProviders.find(p => p.id === providerId)
      if (provider && modelId) return { provider, modelId }
    }

    if (candidate) {
      for (const p of enabledProviders) {
        if (p.models.some(m => m.id === candidate && m.enabled)) {
          return { provider: p, modelId: candidate }
        }
      }
    }

    const settings = this.getSettings()
    if (settings.chat.defaultModel && settings.chat.defaultModel !== rawModel) {
      return this.resolveModelString(settings.chat.defaultModel)
    }

    for (const p of enabledProviders) {
      const first = p.models.find(m => m.enabled)
      if (first) return { provider: p, modelId: first.id }
    }
    return null
  }

  // ==================== Threads ====================

  private mapThreadRow(
    row: Record<string, unknown>,
    statusLookup?: (threadId: string) => ThreadRuntimeStatus
  ): ThreadDto {
    const id = String(row.id)
    return {
      id,
      title: String(row.title),
      titleSource: (row.title_source as ThreadDto['titleSource']) || 'default',
      model: (row.model as string | null) ?? null,
      reasoningEffort: (row.reasoning_effort as ThreadDto['reasoningEffort']) ?? null,
      fastMode: Boolean(row.fast_mode),
      activeLeafId: (row.active_leaf_id as string | null) ?? null,
      parentThreadId: (row.parent_thread_id as string | null) ?? null,
      branchFromMessageId: (row.branch_from_message_id as string | null) ?? null,
      workspacePath: (row.workspace_path as string | null) ?? null,
      enabledMcpIds: row.enabled_mcp_ids ? JSON.parse(String(row.enabled_mcp_ids)) : null,
      builtinToolsEnabled:
        row.builtin_tools_enabled === undefined ? true : Boolean(row.builtin_tools_enabled),
      skillIds: row.skill_ids ? JSON.parse(String(row.skill_ids)) : null,
      isPinned: Boolean(row.is_pinned),
      archivedAt: row.archived_at ? Number(row.archived_at) : null,
      runtimeStatus: statusLookup ? statusLookup(id) : 'idle',
      metadata: JSON.parse(String(row.metadata || '{}')),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  listThreads(
    statusLookup?: (threadId: string) => ThreadRuntimeStatus,
    includeArchived = false
  ): ThreadDto[] {
    const sql = includeArchived
      ? 'SELECT * FROM threads ORDER BY is_pinned DESC, updated_at DESC'
      : 'SELECT * FROM threads WHERE archived_at IS NULL ORDER BY is_pinned DESC, updated_at DESC'
    const rows = this.sqlite.prepare(sql).all() as Array<Record<string, unknown>>
    return rows.map(r => this.mapThreadRow(r, statusLookup))
  }

  getThread(
    id: string,
    statusLookup?: (threadId: string) => ThreadRuntimeStatus
  ): ThreadDto | null {
    const row = this.sqlite.prepare('SELECT * FROM threads WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapThreadRow(row, statusLookup) : null
  }

  createThread(input: {
    title?: string
    model?: string | null
    reasoningEffort?: 'low' | 'medium' | 'high' | null
    workspacePath?: string | null
    enabledMcpIds?: string[] | null
    builtinToolsEnabled?: boolean
  }): ThreadDto {
    const id = nanoid(12)
    const now = Date.now()
    const title = input.title?.trim() || '新对话'
    const titleSource = input.title?.trim() ? 'manual' : 'default'
    this.sqlite
      .prepare(
        `INSERT INTO threads (
          id, title, title_source, model, reasoning_effort, fast_mode,
          active_leaf_id, workspace_path, enabled_mcp_ids, builtin_tools_enabled, skill_ids,
          is_pinned, archived_at, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, NULL, 0, NULL, '{}', ?, ?)`
      )
      .run(
        id,
        title,
        titleSource,
        input.model ?? null,
        input.reasoningEffort ?? null,
        input.workspacePath ?? null,
        input.enabledMcpIds ? JSON.stringify(input.enabledMcpIds) : null,
        input.builtinToolsEnabled === false ? 0 : 1,
        now,
        now
      )
    return this.getThread(id)!
  }

  updateThread(
    id: string,
    patch: {
      title?: string
      titleSource?: 'default' | 'auto' | 'manual'
      model?: string | null
      reasoningEffort?: 'low' | 'medium' | 'high' | null
      fastMode?: boolean
      activeLeafId?: string | null
      workspacePath?: string | null
      enabledMcpIds?: string[] | null
      builtinToolsEnabled?: boolean
      skillIds?: string[] | null
      isPinned?: boolean
      archived?: boolean
      metadata?: Record<string, unknown>
    },
    statusLookup?: (threadId: string) => ThreadRuntimeStatus
  ): ThreadDto | null {
    const cur = this.getThread(id)
    if (!cur) return null
    const nextTitle = patch.title !== undefined ? patch.title : cur.title
    const nextTitleSource =
      patch.titleSource !== undefined
        ? patch.titleSource
        : patch.title !== undefined
          ? 'manual'
          : cur.titleSource

    this.sqlite
      .prepare(
        `UPDATE threads SET
          title = ?, title_source = ?, model = ?, reasoning_effort = ?, fast_mode = ?,
          active_leaf_id = ?, workspace_path = ?, enabled_mcp_ids = ?, builtin_tools_enabled = ?, skill_ids = ?,
          is_pinned = ?, archived_at = ?, metadata = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        nextTitle,
        nextTitleSource,
        patch.model !== undefined ? patch.model : cur.model,
        patch.reasoningEffort !== undefined ? patch.reasoningEffort : cur.reasoningEffort,
        (patch.fastMode !== undefined ? patch.fastMode : cur.fastMode) ? 1 : 0,
        patch.activeLeafId !== undefined ? patch.activeLeafId : cur.activeLeafId,
        patch.workspacePath !== undefined ? patch.workspacePath : cur.workspacePath,
        (patch.enabledMcpIds !== undefined ? patch.enabledMcpIds : cur.enabledMcpIds)
          ? JSON.stringify(
              patch.enabledMcpIds !== undefined ? patch.enabledMcpIds : cur.enabledMcpIds
            )
          : null,
        (patch.builtinToolsEnabled !== undefined
          ? patch.builtinToolsEnabled
          : cur.builtinToolsEnabled)
          ? 1
          : 0,
        (patch.skillIds !== undefined ? patch.skillIds : cur.skillIds)
          ? JSON.stringify(patch.skillIds !== undefined ? patch.skillIds : cur.skillIds)
          : null,
        (patch.isPinned !== undefined ? patch.isPinned : cur.isPinned) ? 1 : 0,
        patch.archived !== undefined ? (patch.archived ? Date.now() : null) : cur.archivedAt,
        JSON.stringify(patch.metadata !== undefined ? patch.metadata : cur.metadata),
        Date.now(),
        id
      )
    return this.getThread(id, statusLookup)
  }

  updateThreadMetadata(
    id: string,
    patch: Record<string, unknown>,
    statusLookup?: (threadId: string) => ThreadRuntimeStatus
  ): ThreadDto | null {
    const cur = this.getThread(id, statusLookup)
    if (!cur) return null
    const nextMeta = { ...cur.metadata }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) {
        delete nextMeta[k]
      } else {
        nextMeta[k] = v
      }
    }
    this.sqlite
      .prepare('UPDATE threads SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(nextMeta), Date.now(), id)
    return this.getThread(id, statusLookup)
  }

  addThreadAllowedBuiltinTool(
    id: string,
    toolName: string,
    statusLookup?: (threadId: string) => ThreadRuntimeStatus
  ): ThreadDto | null {
    const cur = this.getThread(id, statusLookup)
    if (!cur) return null
    const prev = Array.isArray(cur.metadata?.allowedBuiltinTools)
      ? cur.metadata.allowedBuiltinTools.filter((x): x is string => typeof x === 'string')
      : []
    if (prev.includes(toolName)) return cur
    return this.updateThreadMetadata(
      id,
      { allowedBuiltinTools: [...prev, toolName] },
      statusLookup
    )
  }

  deleteThread(id: string): boolean {
    this.sqlite.prepare('DELETE FROM messages_fts WHERE thread_id = ?').run(id)
    const res = this.sqlite.prepare('DELETE FROM threads WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  branchThread(
    sourceThreadId: string,
    upToMessageId?: string | null,
    customTitle?: string
  ): { thread: ThreadDto; messages: StoredMessageDto[] } | null {
    const source = this.getThread(sourceThreadId)
    if (!source) return null

    const targetLeafId = upToMessageId || source.activeLeafId
    const branchMessages = targetLeafId
      ? this.getActiveBranchMessages(sourceThreadId, targetLeafId)
      : []
    const resolvedBranchMsgId =
      upToMessageId || branchMessages[branchMessages.length - 1]?.id || null

    const newId = nanoid(12)
    const now = Date.now()
    const newTitle = customTitle?.trim() || `${source.title} (分支)`

    this.sqlite
      .prepare(
        `INSERT INTO threads (
          id, title, title_source, model, reasoning_effort, fast_mode,
          active_leaf_id, parent_thread_id, branch_from_message_id,
          workspace_path, enabled_mcp_ids, builtin_tools_enabled, skill_ids,
          is_pinned, archived_at, metadata, created_at, updated_at
        ) VALUES (?, ?, 'manual', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, NULL, '{}', ?, ?)`
      )
      .run(
        newId,
        newTitle,
        source.model,
        source.reasoningEffort,
        source.fastMode ? 1 : 0,
        sourceThreadId,
        resolvedBranchMsgId,
        source.workspacePath,
        source.enabledMcpIds ? JSON.stringify(source.enabledMcpIds) : null,
        source.builtinToolsEnabled ? 1 : 0,
        source.skillIds ? JSON.stringify(source.skillIds) : null,
        now,
        now
      )

    let prevClonedId: string | null = null
    for (const msg of branchMessages) {
      const clonedId = nanoid(12)
      const clonedUi: UIMessage = { ...msg.message, id: clonedId }
      this.insertMessage({
        id: clonedId,
        threadId: newId,
        parentId: prevClonedId,
        role: msg.role,
        message: clonedUi,
        metadata: msg.metadata,
        setActiveLeaf: true
      })
      prevClonedId = clonedId
    }

    return {
      thread: this.getThread(newId)!,
      messages: this.getActiveBranchMessages(newId)
    }
  }

  batchDeleteThreads(ids: string[]): number {
    let deleted = 0
    for (const id of ids) {
      if (this.deleteThread(id)) deleted++
    }
    return deleted
  }

  // ==================== Messages (Tree + Slots) ====================

  private extractSearchableContent(message: UIMessage): string {
    const chunks: string[] = []
    for (const p of message.parts || []) {
      if (p.type === 'text' && p.text) chunks.push(p.text)
      else if (p.type === 'reasoning' && p.text) chunks.push(p.text)
      else if (p.type === 'file' && p.fileName) chunks.push(p.fileName)
      else if (p.type === 'tool-call') {
        if (p.title) chunks.push(p.title)
        else if (p.toolName) chunks.push(p.toolName)
      }
    }
    return chunks.join('\n').trim()
  }

  private syncMessageFts(messageId: string, threadId: string, role: string, message: UIMessage): void {
    this.sqlite.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(messageId)
    const text = this.extractSearchableContent(message)
    if (text) {
      this.sqlite
        .prepare('INSERT INTO messages_fts (message_id, thread_id, role, content) VALUES (?, ?, ?, ?)')
        .run(messageId, threadId, role, text)
    }
  }

  insertMessage(params: {
    id?: string
    threadId: string
    parentId: string | null
    slotId?: string
    role: 'user' | 'assistant' | 'system'
    message: UIMessage
    metadata?: MessageMetadata
    setActiveLeaf?: boolean
  }): StoredMessageDto {
    const id = params.id || params.message.id || nanoid(12)
    const slotId = params.slotId || nanoid(10)
    const now = Date.now()
    const uiMsg: UIMessage = { ...params.message, id }

    this.sqlite
      .prepare(
        `INSERT INTO messages (id, thread_id, parent_id, slot_id, role, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.threadId,
        params.parentId,
        slotId,
        params.role,
        JSON.stringify(uiMsg),
        JSON.stringify(params.metadata || {}),
        now
      )

    this.syncMessageFts(id, params.threadId, params.role, uiMsg)

    if (params.setActiveLeaf !== false) {
      this.sqlite
        .prepare('UPDATE threads SET active_leaf_id = ?, updated_at = ? WHERE id = ?')
        .run(id, now, params.threadId)
    }

    return this.getMessageById(id)!
  }

  updateMessageContent(
    id: string,
    message: UIMessage,
    metadata?: MessageMetadata
  ): StoredMessageDto | null {
    const existing = this.getMessageById(id)
    if (!existing) return null
    const mergedMeta = metadata ? { ...existing.metadata, ...metadata } : existing.metadata
    const nextUiMsg: UIMessage = { ...message, id }
    this.sqlite
      .prepare('UPDATE messages SET message = ?, metadata = ? WHERE id = ?')
      .run(JSON.stringify(nextUiMsg), JSON.stringify(mergedMeta), id)
    this.syncMessageFts(id, existing.threadId, existing.role, nextUiMsg)
    return this.getMessageById(id)
  }

  getMessageById(id: string): StoredMessageDto | null {
    const row = this.sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    const siblings = this.sqlite
      .prepare('SELECT id FROM messages WHERE thread_id = ? AND slot_id = ? ORDER BY created_at ASC')
      .all(String(row.thread_id), String(row.slot_id)) as Array<{ id: string }>
    const siblingIds = siblings.map(s => s.id)
    const idx = Math.max(0, siblingIds.indexOf(String(row.id)))
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      parentId: (row.parent_id as string | null) ?? null,
      slotId: String(row.slot_id),
      role: row.role as StoredMessageDto['role'],
      message: JSON.parse(String(row.message)),
      metadata: JSON.parse(String(row.metadata || '{}')),
      createdAt: Number(row.created_at),
      versionInfo: {
        index: idx + 1,
        total: Math.max(1, siblingIds.length),
        siblingIds
      }
    }
  }

  getActiveBranchMessages(threadId: string, upToMessageId?: string | null): StoredMessageDto[] {
    const thread = this.getThread(threadId)
    if (!thread) return []

    const allRows = this.sqlite
      .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC')
      .all(threadId) as Array<Record<string, unknown>>
    if (!allRows.length) return []

    const byId = new Map<string, Record<string, unknown>>()
    const bySlot = new Map<string, string[]>()
    for (const r of allRows) {
      const id = String(r.id)
      const slot = String(r.slot_id)
      byId.set(id, r)
      const list = bySlot.get(slot) || []
      list.push(id)
      bySlot.set(slot, list)
    }

    let cursorId = upToMessageId ?? thread.activeLeafId ?? String(allRows[allRows.length - 1].id)
    if (!byId.has(cursorId)) {
      cursorId = String(allRows[allRows.length - 1].id)
    }

    const chain: StoredMessageDto[] = []
    const visited = new Set<string>()
    while (cursorId && byId.has(cursorId) && !visited.has(cursorId)) {
      visited.add(cursorId)
      const r = byId.get(cursorId)!
      const id = String(r.id)
      const slotId = String(r.slot_id)
      const siblingIds = bySlot.get(slotId) || [id]
      const idx = Math.max(0, siblingIds.indexOf(id))
      chain.push({
        id,
        threadId,
        parentId: (r.parent_id as string | null) ?? null,
        slotId,
        role: r.role as StoredMessageDto['role'],
        message: JSON.parse(String(r.message)),
        metadata: JSON.parse(String(r.metadata || '{}')),
        createdAt: Number(r.created_at),
        versionInfo: {
          index: idx + 1,
          total: siblingIds.length,
          siblingIds
        }
      })
      cursorId = (r.parent_id as string | null) ?? ''
    }

    return chain.reverse()
  }

  switchMessageVersion(targetMessageId: string): { threadId: string; activeLeafId: string } | null {
    const target = this.getMessageById(targetMessageId)
    if (!target) return null

    const allRows = this.sqlite
      .prepare('SELECT id, parent_id, created_at FROM messages WHERE thread_id = ? ORDER BY created_at ASC')
      .all(target.threadId) as Array<{ id: string; parent_id: string | null; created_at: number }>

    const childrenByParent = new Map<string, string[]>()
    for (const r of allRows) {
      if (r.parent_id) {
        const list = childrenByParent.get(r.parent_id) || []
        list.push(r.id)
        childrenByParent.set(r.parent_id, list)
      }
    }

    // Descend along the most recently created child path under targetMessageId
    let leafId = target.id
    const guard = new Set<string>()
    while (!guard.has(leafId)) {
      guard.add(leafId)
      const kids = childrenByParent.get(leafId)
      if (!kids || !kids.length) break
      leafId = kids[kids.length - 1]
    }

    this.sqlite
      .prepare('UPDATE threads SET active_leaf_id = ?, updated_at = ? WHERE id = ?')
      .run(leafId, Date.now(), target.threadId)

    return { threadId: target.threadId, activeLeafId: leafId }
  }

  rollbackToMessage(messageId: string): { threadId: string; activeLeafId: string } | null {
    const target = this.getMessageById(messageId)
    if (!target) return null
    this.sqlite
      .prepare('UPDATE threads SET active_leaf_id = ?, updated_at = ? WHERE id = ?')
      .run(target.id, Date.now(), target.threadId)
    return { threadId: target.threadId, activeLeafId: target.id }
  }

  // ==================== Attachments ====================

  insertAttachment(params: {
    id?: string
    threadId?: string | null
    fileName: string
    mimeType: string
    byteSize: number
    relPath: string
  }) {
    const id = params.id || nanoid(12)
    const createdAt = Date.now()
    this.sqlite
      .prepare(
        `INSERT INTO attachments (id, thread_id, file_name, mime_type, byte_size, rel_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.threadId ?? null,
        params.fileName,
        params.mimeType,
        params.byteSize,
        params.relPath,
        createdAt
      )
    return { id, ...params, createdAt }
  }

  getAttachment(id: string): {
    id: string
    threadId: string | null
    fileName: string
    mimeType: string
    byteSize: number
    relPath: string
    createdAt: number
  } | null {
    const row = this.sqlite.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    return {
      id: String(row.id),
      threadId: (row.thread_id as string | null) ?? null,
      fileName: String(row.file_name),
      mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size),
      relPath: String(row.rel_path),
      createdAt: Number(row.created_at)
    }
  }

  // ==================== MCP Servers ====================

  listMcpServers(): Array<{
    id: string
    name: string
    transport: 'stdio' | 'streamable-http'
    config: {
      command?: string | null
      args?: string[]
      env?: Record<string, string>
      url?: string | null
      headers?: Record<string, string>
    }
    enabled: boolean
  }> {
    const rows = this.sqlite
      .prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC')
      .all() as Array<Record<string, unknown>>
    return rows.map(r => ({
      id: String(r.id),
      name: String(r.name),
      transport: r.transport as 'stdio' | 'streamable-http',
      config: JSON.parse(String(r.config || '{}')),
      enabled: Boolean(r.enabled)
    }))
  }

  upsertMcpServer(input: McpServerUpsertInput, explicitId?: string) {
    const id = explicitId || input.id || nanoid(10)
    const existing = this.sqlite.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(id)
    const now = Date.now()
    const config = {
      command: input.command ?? null,
      args: input.args || [],
      env: input.env || {},
      url: input.url ?? null,
      headers: input.headers || {}
    }
    if (!existing) {
      this.sqlite
        .prepare(
          'INSERT INTO mcp_servers (id, name, transport, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, input.name, input.transport, JSON.stringify(config), input.enabled ? 1 : 0, now, now)
    } else {
      this.sqlite
        .prepare(
          'UPDATE mcp_servers SET name = ?, transport = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?'
        )
        .run(input.name, input.transport, JSON.stringify(config), input.enabled ? 1 : 0, now, id)
    }
    return this.listMcpServers().find(s => s.id === id)!
  }

  deleteMcpServer(id: string): boolean {
    const res = this.sqlite.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  // ==================== Skills State ====================

  getSkillsEnabledMap(): Map<string, boolean> {
    const rows = this.sqlite
      .prepare('SELECT id, enabled FROM skills_state')
      .all() as Array<{ id: string; enabled: number }>
    return new Map(rows.map(r => [r.id, Boolean(r.enabled)]))
  }

  setSkillEnabled(id: string, skillPath: string, enabled: boolean): void {
    const now = Date.now()
    this.sqlite
      .prepare(
        `INSERT INTO skills_state (id, path, enabled, sort_order, updated_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, path = excluded.path, updated_at = excluded.updated_at`
      )
      .run(id, skillPath, enabled ? 1 : 0, now)
  }

  // ==================== Usage Records ====================

  insertUsage(params: {
    threadId?: string | null
    messageId?: string | null
    category: 'chat' | 'aux'
    purpose: 'reply' | 'title' | 'compact' | 'memory'
    providerId: string
    model: string
    inputTokens: number
    outputTokens: number
    cachedInputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
    latencyMs?: number
  }): void {
    const total =
      params.totalTokens ??
      params.inputTokens + params.outputTokens + (params.reasoningTokens ?? 0)
    this.sqlite
      .prepare(
        `INSERT INTO usage_records (
          id, thread_id, message_id, category, purpose, provider_id, model,
          input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
          total_tokens, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nanoid(12),
        params.threadId ?? null,
        params.messageId ?? null,
        params.category,
        params.purpose,
        params.providerId,
        params.model,
        params.inputTokens,
        params.outputTokens,
        params.cachedInputTokens ?? 0,
        params.reasoningTokens ?? 0,
        total,
        params.latencyMs ?? 0,
        Date.now()
      )
  }

  getUsageStats(days = 30) {
    const since = Date.now() - days * 86_400_000
    const summaryRows = this.sqlite
      .prepare(
        `SELECT category,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cached_input_tokens) AS cached_input_tokens,
                SUM(reasoning_tokens) AS reasoning_tokens,
                SUM(total_tokens) AS total_tokens,
                COUNT(*) AS request_count
         FROM usage_records
         WHERE created_at >= ?
         GROUP BY category`
      )
      .all(since) as Array<Record<string, unknown>>

    const byModelRows = this.sqlite
      .prepare(
        `SELECT provider_id, model, category,
                SUM(total_tokens) AS total_tokens,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                COUNT(*) AS calls
         FROM usage_records
         WHERE created_at >= ?
         GROUP BY provider_id, model, category
         ORDER BY total_tokens DESC`
      )
      .all(since) as Array<Record<string, unknown>>

    return {
      days,
      byCategory: summaryRows.map(r => ({
        category: String(r.category),
        inputTokens: Number(r.input_tokens || 0),
        outputTokens: Number(r.output_tokens || 0),
        cachedInputTokens: Number(r.cached_input_tokens || 0),
        reasoningTokens: Number(r.reasoning_tokens || 0),
        totalTokens: Number(r.total_tokens || 0),
        requestCount: Number(r.request_count || 0)
      })),
      byModel: byModelRows.map(r => ({
        providerId: String(r.provider_id),
        model: String(r.model),
        category: String(r.category),
        totalTokens: Number(r.total_tokens || 0),
        inputTokens: Number(r.input_tokens || 0),
        outputTokens: Number(r.output_tokens || 0),
        calls: Number(r.calls || 0)
      }))
    }
  }

  // ==================== Cron Jobs & Runs ====================

  private mapCronJobRow(row: Record<string, unknown>): CronJobDto {
    return {
      id: String(row.id),
      name: String(row.name),
      cronExpr: String(row.cron_expr),
      timezone: String(row.timezone || 'Asia/Shanghai'),
      threadId: (row.thread_id as string | null) ?? null,
      prompt: String(row.prompt),
      model: (row.model as string | null) ?? null,
      feishuChatId: (row.feishu_chat_id as string | null) ?? null,
      enabled: Boolean(row.enabled),
      lastRunAt: row.last_run_at ? Number(row.last_run_at) : null,
      nextRunAt: row.next_run_at ? Number(row.next_run_at) : null,
      lastStatus: (row.last_status as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  private mapCronRunRow(row: Record<string, unknown>): CronRunDto {
    return {
      id: String(row.id),
      jobId: String(row.job_id),
      threadId: (row.thread_id as string | null) ?? null,
      messageId: (row.message_id as string | null) ?? null,
      triggerType: (row.trigger_type as CronRunDto['triggerType']) || 'schedule',
      status: (row.status as CronRunDto['status']) || 'running',
      error: (row.error as string | null) ?? null,
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at ? Number(row.finished_at) : null
    }
  }

  listCronJobs(): CronJobDto[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC')
      .all() as Array<Record<string, unknown>>
    return rows.map(r => this.mapCronJobRow(r))
  }

  getCronJob(id: string): CronJobDto | null {
    const row = this.sqlite.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapCronJobRow(row) : null
  }

  listDueCronJobs(now: number): CronJobDto[] {
    const rows = this.sqlite
      .prepare(
        'SELECT * FROM cron_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC'
      )
      .all(now) as Array<Record<string, unknown>>
    return rows.map(r => this.mapCronJobRow(r))
  }

  upsertCronJob(
    input: CronJobUpsertInput & { nextRunAt?: number | null },
    explicitId?: string
  ): CronJobDto {
    const id = explicitId || input.id || nanoid(10)
    const existing = this.getCronJob(id)
    const now = Date.now()
    if (!existing) {
      this.sqlite
        .prepare(
          `INSERT INTO cron_jobs (
            id, name, cron_expr, timezone, thread_id, prompt, model, feishu_chat_id,
            enabled, last_run_at, next_run_at, last_status, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`
        )
        .run(
          id,
          input.name.trim(),
          input.cronExpr.trim(),
          input.timezone.trim() || 'Asia/Shanghai',
          input.threadId ?? null,
          input.prompt,
          input.model ?? null,
          input.feishuChatId ?? null,
          input.enabled ? 1 : 0,
          input.nextRunAt ?? null,
          now,
          now
        )
    } else {
      this.sqlite
        .prepare(
          `UPDATE cron_jobs SET
            name = ?, cron_expr = ?, timezone = ?, thread_id = ?, prompt = ?, model = ?, feishu_chat_id = ?,
            enabled = ?, next_run_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.name.trim(),
          input.cronExpr.trim(),
          input.timezone.trim() || 'Asia/Shanghai',
          input.threadId ?? null,
          input.prompt,
          input.model ?? null,
          input.feishuChatId ?? null,
          input.enabled ? 1 : 0,
          input.nextRunAt !== undefined ? input.nextRunAt : existing.nextRunAt,
          now,
          id
        )
    }
    return this.getCronJob(id)!
  }

  updateCronJobRuntime(
    id: string,
    patch: {
      enabled?: boolean
      lastRunAt?: number | null
      nextRunAt?: number | null
      lastStatus?: string | null
      lastError?: string | null
    }
  ): CronJobDto | null {
    const cur = this.getCronJob(id)
    if (!cur) return null
    this.sqlite
      .prepare(
        `UPDATE cron_jobs SET
          enabled = ?, last_run_at = ?, next_run_at = ?, last_status = ?, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        (patch.enabled !== undefined ? patch.enabled : cur.enabled) ? 1 : 0,
        patch.lastRunAt !== undefined ? patch.lastRunAt : cur.lastRunAt,
        patch.nextRunAt !== undefined ? patch.nextRunAt : cur.nextRunAt,
        patch.lastStatus !== undefined ? patch.lastStatus : cur.lastStatus,
        patch.lastError !== undefined ? patch.lastError : cur.lastError,
        Date.now(),
        id
      )
    return this.getCronJob(id)
  }

  deleteCronJob(id: string): boolean {
    const res = this.sqlite.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  insertCronRun(params: {
    jobId: string
    threadId?: string | null
    triggerType: 'schedule' | 'manual'
    status?: 'running' | 'success' | 'error'
    startedAt?: number
  }): CronRunDto {
    const id = nanoid(12)
    const startedAt = params.startedAt ?? Date.now()
    this.sqlite
      .prepare(
        `INSERT INTO cron_runs (id, job_id, thread_id, message_id, trigger_type, status, error, started_at, finished_at)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, NULL)`
      )
      .run(id, params.jobId, params.threadId ?? null, params.triggerType, params.status || 'running', startedAt)
    const row = this.sqlite.prepare('SELECT * FROM cron_runs WHERE id = ?').get(id) as Record<
      string,
      unknown
    >
    return this.mapCronRunRow(row)
  }

  finishCronRun(
    id: string,
    patch: {
      status: 'success' | 'error'
      messageId?: string | null
      error?: string | null
      finishedAt?: number
    }
  ): CronRunDto | null {
    const existing = this.sqlite.prepare('SELECT * FROM cron_runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!existing) return null
    this.sqlite
      .prepare(
        'UPDATE cron_runs SET status = ?, message_id = ?, error = ?, finished_at = ? WHERE id = ?'
      )
      .run(
        patch.status,
        patch.messageId ?? null,
        patch.error ?? null,
        patch.finishedAt ?? Date.now(),
        id
      )
    const row = this.sqlite.prepare('SELECT * FROM cron_runs WHERE id = ?').get(id) as Record<
      string,
      unknown
    >
    return this.mapCronRunRow(row)
  }

  listCronRuns(jobId: string, limit = 50): CronRunDto[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
      .all(jobId, limit) as Array<Record<string, unknown>>
    return rows.map(r => this.mapCronRunRow(r))
  }

  // ==================== Full-Text Search (FTS5) ====================

  private buildSnippetFallback(content: string, query: string): string {
    const idx = content.toLowerCase().indexOf(query.toLowerCase())
    if (idx === -1) return content.slice(0, 120)
    const start = Math.max(0, idx - 32)
    const end = Math.min(content.length, idx + query.length + 64)
    return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '')
  }

  search(
    rawQuery: string,
    limit = 30,
    statusLookup?: (threadId: string) => ThreadRuntimeStatus
  ): SearchResponseDto {
    const query = rawQuery.trim()
    if (!query) {
      return { query: '', threads: [], messages: [] }
    }

    const escapeLike = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`
    const likePattern = escapeLike(query)

    const threadRows = this.sqlite
      .prepare(
        `SELECT * FROM threads
         WHERE title LIKE ? ESCAPE '\\'
         ORDER BY (archived_at IS NOT NULL) ASC, is_pinned DESC, updated_at DESC
         LIMIT ?`
      )
      .all(likePattern, limit) as Array<Record<string, unknown>>

    const threads = threadRows.map(r => this.mapThreadRow(r, statusLookup))

    let msgRows: Array<Record<string, unknown>> = []
    if (Array.from(query).length >= 3) {
      const ftsPhrase = `"${query.replace(/"/g, '""')}"`
      try {
        msgRows = this.sqlite
          .prepare(
            `SELECT f.message_id, f.thread_id, f.role,
                    snippet(messages_fts, 3, '', '', '…', 16) AS snippet,
                    m.created_at, t.title AS thread_title, t.archived_at
             FROM messages_fts f
             JOIN messages m ON m.id = f.message_id
             JOIN threads t ON t.id = f.thread_id
             WHERE messages_fts MATCH ?
             ORDER BY m.created_at DESC
             LIMIT ?`
          )
          .all(ftsPhrase, limit) as Array<Record<string, unknown>>
      } catch {
        msgRows = []
      }
    } else {
      const rawLikeRows = this.sqlite
        .prepare(
          `SELECT f.message_id, f.thread_id, f.role, f.content,
                  m.created_at, t.title AS thread_title, t.archived_at
           FROM messages_fts f
           JOIN messages m ON m.id = f.message_id
           JOIN threads t ON t.id = f.thread_id
           WHERE f.content LIKE ? ESCAPE '\\'
           ORDER BY m.created_at DESC
           LIMIT ?`
        )
        .all(likePattern, limit) as Array<Record<string, unknown>>
      msgRows = rawLikeRows.map(r => ({
        ...r,
        snippet: this.buildSnippetFallback(String(r.content || ''), query)
      }))
    }

    const messages: SearchMessageHitDto[] = msgRows.map(r => ({
      messageId: String(r.message_id),
      threadId: String(r.thread_id),
      threadTitle: String(r.thread_title || '新对话'),
      archivedAt: r.archived_at ? Number(r.archived_at) : null,
      role: (r.role as SearchMessageHitDto['role']) || 'user',
      snippet: String(r.snippet || ''),
      createdAt: Number(r.created_at || 0)
    }))

    return { query, threads, messages }
  }

  // ==================== Prompts Library (B5) ====================

  private mapPromptRow(row: Record<string, unknown>): PromptTemplateDto {
    return {
      id: String(row.id),
      title: String(row.title),
      shortcut: (row.shortcut as string | null) ?? null,
      content: String(row.content),
      category: (row.category as string | null) ?? null,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  listPrompts(): PromptTemplateDto[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM prompts ORDER BY updated_at DESC, created_at DESC')
      .all() as Array<Record<string, unknown>>
    return rows.map(r => this.mapPromptRow(r))
  }

  getPrompt(id: string): PromptTemplateDto | null {
    const row = this.sqlite.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? this.mapPromptRow(row) : null
  }

  upsertPrompt(input: PromptTemplateUpsertInput, explicitId?: string): PromptTemplateDto {
    const id = explicitId || input.id || nanoid(10)
    const existing = this.getPrompt(id)
    const now = Date.now()
    const cleanShortcut = input.shortcut?.trim().replace(/^\/+/, '') || null
    const cleanCategory = input.category?.trim() || null
    if (!existing) {
      this.sqlite
        .prepare(
          'INSERT INTO prompts (id, title, shortcut, content, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, input.title.trim(), cleanShortcut, input.content, cleanCategory, now, now)
    } else {
      this.sqlite
        .prepare(
          'UPDATE prompts SET title = ?, shortcut = ?, content = ?, category = ?, updated_at = ? WHERE id = ?'
        )
        .run(input.title.trim(), cleanShortcut, input.content, cleanCategory, now, id)
    }
    return this.getPrompt(id)!
  }

  deletePrompt(id: string): boolean {
    const res = this.sqlite.prepare('DELETE FROM prompts WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  // ==================== Execution Traces (B9) ====================

  private mapTraceRow(row: Record<string, unknown>): ExecutionTraceDto {
    return {
      id: String(row.id),
      threadId: String(row.thread_id),
      messageId: String(row.message_id),
      providerId: String(row.provider_id),
      model: String(row.model),
      source: String(row.source || 'gui'),
      status: (row.status as ExecutionTraceDto['status']) || 'success',
      durationMs: Number(row.duration_ms || 0),
      inputTokens: Number(row.input_tokens || 0),
      outputTokens: Number(row.output_tokens || 0),
      cachedInputTokens: Number(row.cached_input_tokens || 0),
      reasoningTokens: Number(row.reasoning_tokens || 0),
      totalTokens: Number(row.total_tokens || 0),
      toolCallCount: Number(row.tool_call_count || 0),
      toolCalls: JSON.parse(String(row.tool_calls || '[]')),
      error: (row.error as string | null) ?? null,
      startedAt: Number(row.started_at),
      finishedAt: Number(row.finished_at)
    }
  }

  insertTrace(params: {
    threadId: string
    messageId: string
    providerId: string
    model: string
    source: string
    status: 'success' | 'error' | 'aborted'
    durationMs: number
    inputTokens: number
    outputTokens: number
    cachedInputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
    toolCalls: ExecutionTraceToolCallItem[]
    error?: string | null
    startedAt: number
    finishedAt: number
  }): ExecutionTraceDto {
    const id = nanoid(12)
    const total =
      params.totalTokens ??
      params.inputTokens + params.outputTokens + (params.reasoningTokens ?? 0)
    this.sqlite
      .prepare(
        `INSERT INTO traces (
          id, thread_id, message_id, provider_id, model, source, status,
          duration_ms, input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
          total_tokens, tool_call_count, tool_calls, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.threadId,
        params.messageId,
        params.providerId,
        params.model,
        params.source || 'gui',
        params.status,
        params.durationMs,
        params.inputTokens,
        params.outputTokens,
        params.cachedInputTokens ?? 0,
        params.reasoningTokens ?? 0,
        total,
        params.toolCalls.length,
        JSON.stringify(params.toolCalls),
        params.error ?? null,
        params.startedAt,
        params.finishedAt
      )
    return this.getTraceByMessageId(params.messageId)!
  }

  getTraceByMessageId(messageId: string): ExecutionTraceDto | null {
    const row = this.sqlite
      .prepare('SELECT * FROM traces WHERE message_id = ? ORDER BY finished_at DESC LIMIT 1')
      .get(messageId) as Record<string, unknown> | undefined
    return row ? this.mapTraceRow(row) : null
  }

  listTracesForThread(threadId: string, limit = 50): ExecutionTraceDto[] {
    const rows = this.sqlite
      .prepare('SELECT * FROM traces WHERE thread_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(threadId, limit) as Array<Record<string, unknown>>
    return rows.map(r => this.mapTraceRow(r))
  }

  // ==================== Memories Index & FTS5 (R4) ====================

  upsertMemoryIndex(params: {
    id: string
    title: string
    tags: string[]
    content: string
    sourceThreadId: string | null
    fileName: string
    createdAt: number
    updatedAt: number
  }): void {
    const tagsJson = JSON.stringify(params.tags)
    const tagsText = params.tags.join(' ')
    this.sqlite
      .prepare(
        `INSERT INTO memories (id, title, tags, source_thread_id, file_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           tags = excluded.tags,
           source_thread_id = excluded.source_thread_id,
           file_name = excluded.file_name,
           updated_at = excluded.updated_at`
      )
      .run(
        params.id,
        params.title,
        tagsJson,
        params.sourceThreadId,
        params.fileName,
        params.createdAt,
        params.updatedAt
      )
    this.sqlite.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(params.id)
    this.sqlite
      .prepare('INSERT INTO memories_fts (memory_id, title, tags, content) VALUES (?, ?, ?, ?)')
      .run(params.id, params.title, tagsText, params.content)
  }

  deleteMemoryIndex(id: string): boolean {
    this.sqlite.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id)
    const res = this.sqlite.prepare('DELETE FROM memories WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  listMemoryRows(limit = 200): Array<{
    id: string
    title: string
    tags: string[]
    sourceThreadId: string | null
    fileName: string
    createdAt: number
    updatedAt: number
  }> {
    const rows = this.sqlite
      .prepare('SELECT * FROM memories ORDER BY updated_at DESC, created_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>
    return rows.map(r => ({
      id: String(r.id),
      title: String(r.title),
      tags: JSON.parse(String(r.tags || '[]')),
      sourceThreadId: (r.source_thread_id as string | null) ?? null,
      fileName: String(r.file_name),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    }))
  }

  getMemoryRow(id: string): {
    id: string
    title: string
    tags: string[]
    sourceThreadId: string | null
    fileName: string
    createdAt: number
    updatedAt: number
  } | null {
    const r = this.sqlite.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    if (!r) return null
    return {
      id: String(r.id),
      title: String(r.title),
      tags: JSON.parse(String(r.tags || '[]')),
      sourceThreadId: (r.source_thread_id as string | null) ?? null,
      fileName: String(r.file_name),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    }
  }

  searchMemoryFts(
    rawQuery: string,
    limit = 5
  ): Array<{
    id: string
    title: string
    tags: string[]
    sourceThreadId: string | null
    fileName: string
    snippet: string
    createdAt: number
    updatedAt: number
  }> {
    const query = rawQuery.trim()
    if (!query) return []

    const mapHit = (r: Record<string, unknown>) => ({
      id: String(r.id),
      title: String(r.title),
      tags: JSON.parse(String(r.tags || '[]')) as string[],
      sourceThreadId: (r.source_thread_id as string | null) ?? null,
      fileName: String(r.file_name),
      snippet: String(r.snippet || ''),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    })

    // Extract candidate >=3-char tokens (ASCII words or CJK segments) for natural language recall
    const rawTokens = query
      .split(/[\s,.;:!?，。；：！？、"'()[\]{}<>]+/)
      .map(s => s.trim())
      .filter(Boolean)

    const ftsPhrases: string[] = []
    if (Array.from(query).length >= 3 && rawTokens.length <= 2) {
      ftsPhrases.push(`"${query.replace(/"/g, '""')}"`)
    }
    for (const tok of rawTokens) {
      if (Array.from(tok).length >= 3) {
        const quoted = `"${tok.replace(/"/g, '""')}"`
        if (!ftsPhrases.includes(quoted)) ftsPhrases.push(quoted)
      }
      // Also split mixed CJK+ASCII tokens into sub-runs >= 3 chars
      const subMatches = tok.match(/[a-zA-Z0-9_.-]{3,}|[\u4e00-\u9fff]{3,}/g)
      if (subMatches) {
        for (const sub of subMatches) {
          const quoted = `"${sub.replace(/"/g, '""')}"`
          if (!ftsPhrases.includes(quoted)) ftsPhrases.push(quoted)
        }
      }
    }

    if (ftsPhrases.length > 0) {
      const ftsExpr = ftsPhrases.slice(0, 8).join(' OR ')
      try {
        const rows = this.sqlite
          .prepare(
            `SELECT m.*, snippet(memories_fts, 3, '', '', '…', 20) AS snippet
             FROM memories_fts f
             JOIN memories m ON m.id = f.memory_id
             WHERE memories_fts MATCH ?
             ORDER BY bm25(memories_fts), m.updated_at DESC
             LIMIT ?`
          )
          .all(ftsExpr, limit) as Array<Record<string, unknown>>
        if (rows.length > 0) {
          return rows.map(mapHit)
        }
      } catch {
        // Fallback to LIKE below
      }
    }

    // Fallback LIKE for short (<3 char) tokens or CJK 2-char keywords
    const escapeLike = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`
    const likeTerms = new Set<string>()
    if (Array.from(query).length <= 12) likeTerms.add(query)
    for (const tok of rawTokens) {
      if (Array.from(tok).length >= 2) likeTerms.add(tok)
      const cjkRuns = tok.match(/[\u4e00-\u9fff]{2,}/g)
      if (cjkRuns) {
        for (const run of cjkRuns) {
          const chars = Array.from(run)
          if (chars.length <= 4) likeTerms.add(run)
          for (let i = 0; i <= chars.length - 2 && likeTerms.size < 10; i++) {
            likeTerms.add(chars.slice(i, i + 2).join(''))
          }
        }
      }
    }

    const terms = [...likeTerms].slice(0, 8)
    if (!terms.length) return []

    const clauses = terms
      .map(() => "(f.title LIKE ? ESCAPE '\\' OR f.tags LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\')")
      .join(' OR ')
    const params: Array<string | number> = []
    for (const term of terms) {
      const pat = escapeLike(term)
      params.push(pat, pat, pat)
    }
    params.push(limit)

    const likeRows = this.sqlite
      .prepare(
        `SELECT m.*, substr(f.content, 1, 160) AS snippet
         FROM memories_fts f
         JOIN memories m ON m.id = f.memory_id
         WHERE ${clauses}
         ORDER BY m.updated_at DESC
         LIMIT ?`
      )
      .all(...params) as Array<Record<string, unknown>>

    return likeRows.map(mapHit)
  }

  // ==================== Channel Mappings (R3) ====================

  private mapChannelMappingRow(row: Record<string, unknown>): ChannelMappingDto {
    return {
      id: String(row.id),
      platform: String(row.platform),
      externalChatId: String(row.external_chat_id),
      externalUserId: String(row.external_user_id),
      chatType: String(row.chat_type || 'p2p'),
      threadId: String(row.thread_id),
      metadata: JSON.parse(String(row.metadata || '{}')),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    }
  }

  getChannelMapping(
    platform: string,
    externalChatId: string,
    externalUserId: string
  ): ChannelMappingDto | null {
    const row = this.sqlite
      .prepare(
        'SELECT * FROM channel_mappings WHERE platform = ? AND external_chat_id = ? AND external_user_id = ?'
      )
      .get(platform, externalChatId, externalUserId) as Record<string, unknown> | undefined
    return row ? this.mapChannelMappingRow(row) : null
  }

  upsertChannelMapping(params: {
    platform: string
    externalChatId: string
    externalUserId: string
    chatType?: string
    threadId: string
    metadata?: Record<string, unknown>
  }): ChannelMappingDto {
    const existing = this.getChannelMapping(
      params.platform,
      params.externalChatId,
      params.externalUserId
    )
    const now = Date.now()
    if (!existing) {
      const id = `cmap_${nanoid(10)}`
      this.sqlite
        .prepare(
          `INSERT INTO channel_mappings (
            id, platform, external_chat_id, external_user_id, chat_type, thread_id, metadata, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          params.platform,
          params.externalChatId,
          params.externalUserId,
          params.chatType || 'p2p',
          params.threadId,
          JSON.stringify(params.metadata || {}),
          now,
          now
        )
    } else {
      this.sqlite
        .prepare(
          `UPDATE channel_mappings SET
            chat_type = ?, thread_id = ?, metadata = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          params.chatType || existing.chatType,
          params.threadId,
          JSON.stringify(params.metadata ?? existing.metadata),
          now,
          existing.id
        )
    }
    return this.getChannelMapping(params.platform, params.externalChatId, params.externalUserId)!
  }

  listChannelMappings(platform?: string): ChannelMappingDto[] {
    const rows = platform
      ? (this.sqlite
          .prepare('SELECT * FROM channel_mappings WHERE platform = ? ORDER BY updated_at DESC')
          .all(platform) as Array<Record<string, unknown>>)
      : (this.sqlite
          .prepare('SELECT * FROM channel_mappings ORDER BY updated_at DESC')
          .all() as Array<Record<string, unknown>>)
    return rows.map(r => this.mapChannelMappingRow(r))
  }

  deleteChannelMapping(id: string): boolean {
    const res = this.sqlite.prepare('DELETE FROM channel_mappings WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  listKnownFeishuChats(): Array<{ chatId: string; chatType: string; updatedAt: number }> {
    const rows = this.sqlite
      .prepare(
        `SELECT external_chat_id AS chat_id, MAX(chat_type) AS chat_type, MAX(updated_at) AS updated_at
         FROM channel_mappings
         WHERE platform = 'feishu'
         GROUP BY external_chat_id
         ORDER BY updated_at DESC`
      )
      .all() as Array<Record<string, unknown>>
    return rows.map(r => ({
      chatId: String(r.chat_id),
      chatType: String(r.chat_type || 'p2p'),
      updatedAt: Number(r.updated_at || 0)
    }))
  }

  // ==================== Portable Export & Import ====================

  exportAllData() {
    return {
      exportedAt: new Date().toISOString(),
      app: 'cjh',
      schemaVersion: MIGRATION_011_ID,
      settings: this.getSettings(),
      providers: this.listProviders(), // API keys masked safely
      threads: this.listThreads(undefined, true),
      messages: this.sqlite.prepare('SELECT * FROM messages ORDER BY created_at ASC').all(),
      mcpServers: this.listMcpServers(),
      cronJobs: this.listCronJobs(),
      prompts: this.listPrompts(),
      usageStats: this.getUsageStats(365)
    }
  }

  importAllData(
    rawPayload: Record<string, unknown>,
    mode: 'merge' | 'replace' = 'merge'
  ): {
    mode: 'merge' | 'replace'
    imported: {
      providers: number
      threads: number
      messages: number
      mcpServers: number
      cronJobs: number
      settingsUpdated: boolean
    }
  } {
    const counts = {
      providers: 0,
      threads: 0,
      messages: 0,
      mcpServers: 0,
      cronJobs: 0,
      prompts: 0,
      settingsUpdated: false
    }

    const existingEncKeys = new Map<string, string | null>()
    const existingProviderRows = this.sqlite
      .prepare('SELECT id, api_key_enc FROM providers')
      .all() as Array<{ id: string; api_key_enc: string | null }>
    for (const r of existingProviderRows) {
      existingEncKeys.set(r.id, r.api_key_enc)
    }

    this.sqlite.exec('BEGIN IMMEDIATE;')
    try {
      if (mode === 'replace') {
        this.sqlite.exec(`
          DELETE FROM cron_runs;
          DELETE FROM cron_jobs;
          DELETE FROM prompts;
          DELETE FROM messages_fts;
          DELETE FROM messages;
          DELETE FROM threads;
          DELETE FROM mcp_servers;
          DELETE FROM providers;
        `)
      }

      if (rawPayload.settings && typeof rawPayload.settings === 'object' && !Array.isArray(rawPayload.settings)) {
        const parsedSettings = SettingsSchema.parse(rawPayload.settings)
        this.updateSettings(parsedSettings)
        counts.settingsUpdated = true
      }

      if (Array.isArray(rawPayload.providers)) {
        const now = Date.now()
        for (const item of rawPayload.providers) {
          if (!item || typeof item !== 'object') continue
          const p = item as Record<string, unknown>
          if (typeof p.id !== 'string' || !p.id.trim() || typeof p.name !== 'string') continue
          const id = p.id.trim()
          const plainKey = typeof p.apiKey === 'string' && p.apiKey.trim() ? p.apiKey.trim() : null
          const apiKeyEnc = plainKey ? this.vault.encrypt(plainKey) : (existingEncKeys.get(id) ?? null)

          const sql =
            mode === 'replace'
              ? `INSERT OR REPLACE INTO providers (
                  id, name, type, api_format, is_response_api, use_max_completion_tokens,
                  api_version, base_url, api_key_enc, custom_headers, models, available_models,
                  acp_preset, acp_command, acp_executable_path, acp_args, acp_env,
                  acp_api_provider_id, acp_mcp_server_ids, acp_permission_mode,
                  acp_available_modes, acp_last_mode_id, enabled, sort_order, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              : `INSERT OR IGNORE INTO providers (
                  id, name, type, api_format, is_response_api, use_max_completion_tokens,
                  api_version, base_url, api_key_enc, custom_headers, models, available_models,
                  acp_preset, acp_command, acp_executable_path, acp_args, acp_env,
                  acp_api_provider_id, acp_mcp_server_ids, acp_permission_mode,
                  acp_available_modes, acp_last_mode_id, enabled, sort_order, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

          const res = this.sqlite
            .prepare(sql)
            .run(
              id,
              p.name,
              String(p.type || 'openai-compatible'),
              String(p.apiFormat || 'openai-chat'),
              p.isResponseApi ? 1 : 0,
              p.useMaxCompletionTokens ? 1 : 0,
              typeof p.apiVersion === 'string' ? p.apiVersion : null,
              typeof p.baseUrl === 'string' ? p.baseUrl : null,
              apiKeyEnc,
              JSON.stringify(p.customHeaders || {}),
              JSON.stringify(p.models || []),
              JSON.stringify(p.availableModels || []),
              typeof p.acpPreset === 'string' ? p.acpPreset : null,
              typeof p.acpCommand === 'string' ? p.acpCommand : null,
              typeof p.acpExecutablePath === 'string' ? p.acpExecutablePath : null,
              JSON.stringify(p.acpArgs || []),
              JSON.stringify(p.acpEnv || {}),
              typeof p.acpApiProviderId === 'string' ? p.acpApiProviderId : null,
              JSON.stringify(p.acpMcpServerIds || []),
              String(p.acpPermissionMode || 'default'),
              JSON.stringify(p.acpAvailableModes || []),
              typeof p.acpLastModeId === 'string' ? p.acpLastModeId : null,
              p.enabled === false ? 0 : 1,
              Number(p.sortOrder ?? 0),
              Number(p.createdAt ?? now),
              Number(p.updatedAt ?? now)
            )
          if (Number(res.changes) > 0) counts.providers++
        }
      }

      if (Array.isArray(rawPayload.threads)) {
        const now = Date.now()
        for (const item of rawPayload.threads) {
          if (!item || typeof item !== 'object') continue
          const t = item as Record<string, unknown>
          if (typeof t.id !== 'string' || !t.id.trim()) continue
          const sql =
            mode === 'replace'
              ? `INSERT OR REPLACE INTO threads (
                  id, title, title_source, model, reasoning_effort, fast_mode,
                  active_leaf_id, workspace_path, enabled_mcp_ids, builtin_tools_enabled, skill_ids,
                  is_pinned, archived_at, metadata, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              : `INSERT OR IGNORE INTO threads (
                  id, title, title_source, model, reasoning_effort, fast_mode,
                  active_leaf_id, workspace_path, enabled_mcp_ids, builtin_tools_enabled, skill_ids,
                  is_pinned, archived_at, metadata, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          const res = this.sqlite
            .prepare(sql)
            .run(
              t.id,
              String(t.title || '新对话'),
              String(t.titleSource || 'default'),
              typeof t.model === 'string' ? t.model : null,
              typeof t.reasoningEffort === 'string' ? t.reasoningEffort : null,
              t.fastMode ? 1 : 0,
              typeof t.activeLeafId === 'string' ? t.activeLeafId : null,
              typeof t.workspacePath === 'string' ? t.workspacePath : null,
              t.enabledMcpIds ? JSON.stringify(t.enabledMcpIds) : null,
              t.builtinToolsEnabled === false ? 0 : 1,
              t.skillIds ? JSON.stringify(t.skillIds) : null,
              t.isPinned ? 1 : 0,
              typeof t.archivedAt === 'number' ? t.archivedAt : null,
              JSON.stringify(t.metadata || {}),
              Number(t.createdAt ?? now),
              Number(t.updatedAt ?? now)
            )
          if (Number(res.changes) > 0) counts.threads++
        }
      }

      if (Array.isArray(rawPayload.messages)) {
        const now = Date.now()
        for (const item of rawPayload.messages) {
          if (!item || typeof item !== 'object') continue
          const m = item as Record<string, unknown>
          const id = typeof m.id === 'string' ? m.id : ''
          const threadId = typeof m.thread_id === 'string' ? m.thread_id : typeof m.threadId === 'string' ? m.threadId : ''
          if (!id || !threadId) continue
          const parentId =
            typeof m.parent_id === 'string'
              ? m.parent_id
              : typeof m.parentId === 'string'
                ? m.parentId
                : null
          const slotId = typeof m.slot_id === 'string' ? m.slot_id : typeof m.slotId === 'string' ? m.slotId : id
          const role = String(m.role || 'user')
          const rawMsgStr = typeof m.message === 'string' ? m.message : JSON.stringify(m.message || {})
          const rawMetaStr = typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata || {})
          const createdAt = Number(m.created_at ?? m.createdAt ?? now)

          const sql =
            mode === 'replace'
              ? `INSERT OR REPLACE INTO messages (id, thread_id, parent_id, slot_id, role, message, metadata, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              : `INSERT OR IGNORE INTO messages (id, thread_id, parent_id, slot_id, role, message, metadata, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          const res = this.sqlite
            .prepare(sql)
            .run(id, threadId, parentId, slotId, role, rawMsgStr, rawMetaStr, createdAt)
          if (Number(res.changes) > 0) {
            counts.messages++
            try {
              const uiMsg = JSON.parse(rawMsgStr) as UIMessage
              this.syncMessageFts(id, threadId, role, uiMsg)
            } catch {
              // Ignore invalid message JSON
            }
          }
        }
      }

      if (Array.isArray(rawPayload.mcpServers)) {
        const now = Date.now()
        for (const item of rawPayload.mcpServers) {
          if (!item || typeof item !== 'object') continue
          const s = item as Record<string, unknown>
          if (typeof s.id !== 'string' || typeof s.name !== 'string') continue
          const sql =
            mode === 'replace'
              ? `INSERT OR REPLACE INTO mcp_servers (id, name, transport, config, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              : `INSERT OR IGNORE INTO mcp_servers (id, name, transport, config, enabled, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
          const res = this.sqlite
            .prepare(sql)
            .run(
              s.id,
              s.name,
              String(s.transport || 'stdio'),
              JSON.stringify(s.config || {}),
              s.enabled === false ? 0 : 1,
              now,
              now
            )
          if (Number(res.changes) > 0) counts.mcpServers++
        }
      }

      if (Array.isArray(rawPayload.cronJobs)) {
        const now = Date.now()
        for (const item of rawPayload.cronJobs) {
          if (!item || typeof item !== 'object') continue
          const j = item as Record<string, unknown>
          if (typeof j.id !== 'string' || typeof j.name !== 'string' || typeof j.cronExpr !== 'string') {
            continue
          }
          const sql =
            mode === 'replace'
              ? `INSERT OR REPLACE INTO cron_jobs (id, name, cron_expr, timezone, thread_id, prompt, model, feishu_chat_id, enabled, last_run_at, next_run_at, last_status, last_error, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              : `INSERT OR IGNORE INTO cron_jobs (id, name, cron_expr, timezone, thread_id, prompt, model, feishu_chat_id, enabled, last_run_at, next_run_at, last_status, last_error, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          const res = this.sqlite
            .prepare(sql)
            .run(
              j.id,
              j.name,
              j.cronExpr,
              String(j.timezone || 'Asia/Shanghai'),
              typeof j.threadId === 'string' ? j.threadId : null,
              String(j.prompt || ''),
              typeof j.model === 'string' ? j.model : null,
              typeof j.feishuChatId === 'string' ? j.feishuChatId : null,
              j.enabled === false ? 0 : 1,
              typeof j.lastRunAt === 'number' ? j.lastRunAt : null,
              typeof j.nextRunAt === 'number' ? j.nextRunAt : null,
              typeof j.lastStatus === 'string' ? j.lastStatus : null,
              typeof j.lastError === 'string' ? j.lastError : null,
              Number(j.createdAt ?? now),
              Number(j.updatedAt ?? now)
            )
          if (Number(res.changes) > 0) counts.cronJobs++
        }
      }

      if (Array.isArray(rawPayload.prompts)) {
        const now = Date.now()
        for (const item of rawPayload.prompts) {
          if (!item || typeof item !== 'object') continue
          const pr = item as Record<string, unknown>
          if (typeof pr.id !== 'string' || typeof pr.title !== 'string' || typeof pr.content !== 'string') {
            continue
          }
          const sql =
            mode === 'replace'
              ? `INSERT OR REPLACE INTO prompts (id, title, shortcut, content, category, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
              : `INSERT OR IGNORE INTO prompts (id, title, shortcut, content, category, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
          const res = this.sqlite
            .prepare(sql)
            .run(
              pr.id,
              pr.title,
              typeof pr.shortcut === 'string' ? pr.shortcut : null,
              pr.content,
              typeof pr.category === 'string' ? pr.category : null,
              Number(pr.createdAt ?? now),
              Number(pr.updatedAt ?? now)
            )
          if (Number(res.changes) > 0) counts.prompts++
        }
      }

      this.sqlite.exec('COMMIT;')
      return { mode, imported: counts }
    } catch (err) {
      this.sqlite.exec('ROLLBACK;')
      throw err
    }
  }
}
