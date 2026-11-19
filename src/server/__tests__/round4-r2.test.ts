import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startLocalDaemon } from '../entry'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-r2-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.CJH_DATA_DIR
  while (tempDirs.length) {
    const d = tempDirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore cleanup lock
    }
  }
})

describe('Round 4 R2 — Built-in Skills, Preset Prompts & Onboarding Settings', () => {
  it('loads 5 built-in skills with progressive appendix, distinguishes sources, seeds 5 preset prompts, and persists onboardingCompleted', async () => {
    const dataDir = makeTempDir('cjh-r2-data-')
    const customSkillDir = join(dataDir, 'skills', 'my-local-skill')
    mkdirSync(customSkillDir, { recursive: true })
    writeFileSync(
      join(customSkillDir, 'SKILL.md'),
      '---\nname: my-local-skill\ndescription: Custom local skill\n---\n\n# Secret Local Instructions\nDo local stuff.\n',
      'utf8'
    )

    process.env.CJH_DATA_DIR = dataDir
    const daemon = await startLocalDaemon({ port: 0, masterKeyHex: '33'.repeat(32) })

    try {
      const authHeaders = {
        Authorization: `Bearer ${daemon.authToken}`,
        'Content-Type': 'application/json'
      }

      // 1. Skills API lists 5 builtin skills + local skill
      const skillsRes = await fetch(`http://127.0.0.1:${daemon.port}/api/skills`, {
        headers: authHeaders
      })
      expect(skillsRes.status).toBe(200)
      const skills = (await skillsRes.json()) as Array<{
        id: string
        name: string
        source: string
        enabled: boolean
      }>
      const builtinIds = skills.filter(s => s.source === 'builtin').map(s => s.name)
      expect(builtinIds).toEqual(
        expect.arrayContaining([
          'cjh-self',
          'web-research',
          'daily-report',
          'code-review',
          'file-organizer'
        ])
      )
      expect(skills.some(s => s.source === 'local' && s.name === 'my-local-skill')).toBe(true)

      // 2. Progressive appendix: only name/description, NOT full body
      const appendix = daemon.ctx.skillsScanner.buildSystemPromptAppendix()
      expect(appendix).toContain('skill_read')
      expect(appendix).toContain('cjh-self')
      expect(appendix).not.toContain('Secret Local Instructions')

      // 3. Skill content endpoint
      const contentRes = await fetch(
        `http://127.0.0.1:${daemon.port}/api/skills/${encodeURIComponent('builtin:cjh-self')}/content`,
        { headers: authHeaders }
      )
      expect(contentRes.status).toBe(200)
      const contentJson = (await contentRes.json()) as { content: string }
      expect(contentJson.content).toContain('cjh-self')

      // 4. 5 preset prompts seeded
      const promptsRes = await fetch(`http://127.0.0.1:${daemon.port}/api/prompts`, {
        headers: authHeaders
      })
      expect(promptsRes.status).toBe(200)
      const prompts = (await promptsRes.json()) as Array<{ id: string; shortcut: string; title: string }>
      expect(prompts.map(p => p.shortcut)).toEqual(
        expect.arrayContaining(['summarize', 'translate', 'polish', 'explain', 'commit'])
      )

      // 5. Onboarding flag defaults to false and updates cleanly
      const s1 = daemon.ctx.db.getSettings()
      expect(s1.general.onboardingCompleted).toBe(false)
      const putRes = await fetch(`http://127.0.0.1:${daemon.port}/api/settings`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ general: { onboardingCompleted: true } })
      })
      expect(putRes.status).toBe(200)
      expect(((await putRes.json()) as any).general.onboardingCompleted).toBe(true)
    } finally {
      await daemon.shutdown()
    }
  })

  it('upgrades a legacy 007_traces database through 008–011 preserving data, updates schemaVersion, and marks onboardingCompleted=true only when providers exist', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { SecretVault } = await import('../crypto/vault')
    const { AppDatabase } = await import('../db/database')

    const createLegacy007Db = (dbPath: string, vault: InstanceType<typeof SecretVault>, withProvider: boolean) => {
      const sql = new DatabaseSync(dbPath)
      sql.exec(`
        CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE providers (
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
          acp_permission_mode TEXT NOT NULL DEFAULT 'default',
          acp_available_modes TEXT NOT NULL DEFAULT '[]',
          acp_last_mode_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          title_source TEXT NOT NULL DEFAULT 'default',
          model TEXT,
          reasoning_effort TEXT,
          fast_mode INTEGER NOT NULL DEFAULT 0,
          active_leaf_id TEXT,
          parent_thread_id TEXT,
          branch_from_message_id TEXT,
          workspace_path TEXT,
          enabled_mcp_ids TEXT,
          skill_ids TEXT,
          is_pinned INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          parent_id TEXT,
          slot_id TEXT NOT NULL,
          role TEXT NOT NULL,
          message TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          message_id UNINDEXED,
          thread_id UNINDEXED,
          role UNINDEXED,
          content,
          tokenize='trigram'
        );
        CREATE TABLE attachments (
          id TEXT PRIMARY KEY,
          thread_id TEXT,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          rel_path TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE mcp_servers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          transport TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          applied_extra TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE skills_state (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          sort_order INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE usage_records (
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
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE cron_jobs (
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
        CREATE TABLE cron_runs (
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
        CREATE TABLE prompts (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          shortcut TEXT,
          content TEXT NOT NULL,
          category TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE traces (
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
        INSERT INTO schema_migrations (id, applied_at) VALUES
          ('001_initial_schema', 1000),
          ('002_acp_permission_mode', 1000),
          ('003_cron_jobs', 1000),
          ('004_messages_fts', 1000),
          ('005_prompts', 1000),
          ('006_thread_branching', 1000),
          ('007_traces', 1000);
        INSERT INTO settings (id, data, updated_at) VALUES (
          1,
          '{"general":{"theme":"dark","language":"zh-CN"},"chat":{"defaultModel":"sub2api:gpt-5.5"}}',
          1000
        );
      `)
      if (withProvider) {
        const encKey = vault.encrypt('sk-legacy-provider-key')
        sql
          .prepare(
            `INSERT INTO providers (id, name, type, api_format, base_url, api_key_enc, models, created_at, updated_at)
             VALUES ('sub2api', 'Legacy sub2api', 'openai-compatible', 'openai-responses', 'https://yangyue99.store/v1', ?, '[{"id":"gpt-5.5","name":"GPT-5.5","enabled":true,"capabilities":{}}]', 1000, 1000)`
          )
          .run(encKey)
      }
      sql
        .prepare(
          `INSERT INTO threads (id, title, title_source, model, active_leaf_id, created_at, updated_at)
           VALUES ('th_legacy_1', '老库历史对话', 'manual', 'sub2api:gpt-5.5', 'msg_legacy_1', 1000, 1000)`
        )
        .run()
      sql
        .prepare(
          `INSERT INTO messages (id, thread_id, parent_id, slot_id, role, message, metadata, created_at)
           VALUES ('msg_legacy_1', 'th_legacy_1', NULL, 'slot_1', 'user', '{"id":"msg_legacy_1","role":"user","parts":[{"type":"text","text":"老库保留消息"}]}', '{}', 1000)`
        )
        .run()
      sql
        .prepare(
          `INSERT INTO cron_jobs (id, name, cron_expr, timezone, thread_id, prompt, enabled, created_at, updated_at)
           VALUES ('cron_legacy_1', '老库定时任务', '30 7 * * *', 'Asia/Shanghai', 'th_legacy_1', '生成日报', 1, 1000, 1000)`
        )
        .run()
      sql.close()
    }

    // Case A: Legacy 007 DB WITH configured provider -> onboardingCompleted auto-marked true, data preserved
    const dirWithProv = makeTempDir('cjh-r2-leg-prov-')
    const vaultA = new SecretVault('aa'.repeat(32))
    const dbPathA = join(dirWithProv, 'cjh.db')
    createLegacy007Db(dbPathA, vaultA, true)

    const dbA = new AppDatabase(dbPathA, vaultA)
    try {
      const appliedIds = (
        dbA.sqlite.prepare('SELECT id FROM schema_migrations ORDER BY id ASC').all() as Array<{
          id: string
        }>
      ).map(r => r.id)
      expect(appliedIds).toEqual(
        expect.arrayContaining([
          '008_r1_tools_and_secrets',
          '009_r2_preset_prompts',
          '010_r4_memories',
          '011_r3_feishu_bridge'
        ])
      )

      // Legacy data intact + new columns defaulted safely
      expect(dbA.getProviderSecretKey('sub2api')).toBe('sk-legacy-provider-key')
      const legacyThread = dbA.getThread('th_legacy_1')!
      expect(legacyThread.title).toBe('老库历史对话')
      expect(legacyThread.builtinToolsEnabled).toBe(true)
      expect(dbA.getActiveBranchMessages('th_legacy_1')[0].message.parts[0]).toEqual({
        type: 'text',
        text: '老库保留消息'
      })
      const legacyCron = dbA.getCronJob('cron_legacy_1')!
      expect(legacyCron.name).toBe('老库定时任务')
      expect(legacyCron.feishuChatId).toBeNull()
      expect(dbA.listPrompts().length).toBeGreaterThanOrEqual(5)

      // P2-3: schemaVersion updated to 011_r3_feishu_bridge
      expect(dbA.exportAllData().schemaVersion).toBe('011_r3_feishu_bridge')

      // Section 4: Legacy DB with provider does NOT auto-pop onboarding
      expect(dbA.getSettings().general.onboardingCompleted).toBe(true)
    } finally {
      dbA.close()
    }

    // Case B: Legacy 007 DB WITHOUT any provider -> onboardingCompleted stays false
    const dirNoProv = makeTempDir('cjh-r2-leg-empty-')
    const vaultB = new SecretVault('bb'.repeat(32))
    const dbPathB = join(dirNoProv, 'cjh.db')
    createLegacy007Db(dbPathB, vaultB, false)

    const dbB = new AppDatabase(dbPathB, vaultB)
    try {
      expect(dbB.listProviders()).toHaveLength(0)
      expect(dbB.getSettings().general.onboardingCompleted).toBe(false)
    } finally {
      dbB.close()
    }
  })
})
