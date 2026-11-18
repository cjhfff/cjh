import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { ModelDefinition, ProviderDto } from '@shared/schemas'
import { guessModelCapabilities } from '../db/database'

function normalizeBaseUrl(raw?: string | null, fallback = 'https://api.openai.com/v1'): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '')
  return trimmed || fallback
}

/**
 * Custom fetch wrapper supporting relay quirks (`sub2api`, Azure, DeepSeek, etc.):
 * - `useMaxCompletionTokens`: rewrites `max_tokens` -> `max_completion_tokens` in JSON body
 * - `apiVersion`: appends `api-version` query parameter if not already present
 */
function createRelayFetch(provider: ProviderDto): typeof fetch {
  return async (input, init) => {
    let urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (provider.apiVersion) {
      const u = new URL(urlStr)
      if (!u.searchParams.has('api-version')) {
        u.searchParams.set('api-version', provider.apiVersion)
        urlStr = u.toString()
      }
    }

    let nextInit = init
    if (provider.useMaxCompletionTokens && init?.body && typeof init.body === 'string') {
      try {
        const parsed = JSON.parse(init.body)
        if (parsed && typeof parsed === 'object' && 'max_tokens' in parsed) {
          parsed.max_completion_tokens = parsed.max_tokens
          delete parsed.max_tokens
          nextInit = { ...init, body: JSON.stringify(parsed) }
        }
      } catch {
        // Non-JSON payload, leave untouched
      }
    }

    return fetch(urlStr, nextInit)
  }
}

export function createLanguageModelForProvider(
  provider: ProviderDto,
  apiKey: string | null,
  modelId: string
): LanguageModel {
  const headers = { ...(provider.customHeaders || {}) }
  const customFetch = createRelayFetch(provider)
  const effectiveFormat =
    provider.type === 'anthropic'
      ? 'anthropic'
      : provider.isResponseApi
        ? 'openai-responses'
        : provider.apiFormat

  if (effectiveFormat === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: apiKey || 'missing-key',
      baseURL: normalizeBaseUrl(provider.baseUrl, 'https://api.anthropic.com/v1'),
      headers,
      fetch: customFetch
    })
    return anthropic(modelId)
  }

  if (effectiveFormat === 'openai-responses' || provider.type === 'openai') {
    const openai = createOpenAI({
      apiKey: apiKey || 'missing-key',
      baseURL: normalizeBaseUrl(provider.baseUrl, 'https://api.openai.com/v1'),
      headers,
      fetch: customFetch
    })
    return effectiveFormat === 'openai-responses' ? openai.responses(modelId) : openai.chat(modelId)
  }

  const compat = createOpenAICompatible({
    name: provider.id,
    apiKey: apiKey || undefined,
    baseURL: normalizeBaseUrl(provider.baseUrl, 'https://api.openai.com/v1'),
    headers,
    fetch: customFetch
  })
  return compat.chatModel(modelId)
}

export async function fetchProviderRemoteModels(
  provider: ProviderDto,
  apiKey: string | null
): Promise<ModelDefinition[]> {
  const isAnthropic = provider.type === 'anthropic' || provider.apiFormat === 'anthropic'
  const base = normalizeBaseUrl(
    provider.baseUrl,
    isAnthropic ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'
  )
  const url = new URL(`${base}/models`)
  if (provider.apiVersion) {
    url.searchParams.set('api-version', provider.apiVersion)
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(provider.customHeaders || {})
  }
  if (apiKey) {
    if (isAnthropic) {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
      // Many multi-protocol relays (including sub2api) also accept Bearer
      if (!headers['Authorization']) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '')
    throw new Error(`拉取模型失败 (HTTP ${res.status}): ${bodyText.slice(0, 200)}`)
  }

  const json = (await res.json()) as {
    data?: Array<Record<string, unknown>>
    models?: Array<Record<string, unknown>>
  }
  const rawList = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.models)
      ? json.models
      : []

  const existingById = new Map(provider.models.map(m => [m.id, m]))
  const discovered: ModelDefinition[] = []

  for (const item of rawList) {
    const id = String(item.id || item.name || '').trim()
    if (!id) continue
    const autoCaps = guessModelCapabilities(id)
    const prev = existingById.get(id)
    discovered.push({
      id,
      name: String(item.display_name || item.name || id),
      description: item.description ? String(item.description) : undefined,
      enabled: prev ? prev.enabled : false,
      capabilities: prev ? prev.capabilities : autoCaps,
      autoCapabilities: autoCaps
    })
  }

  return discovered
}

export async function testApiProviderConnection(
  provider: ProviderDto,
  apiKey: string | null
): Promise<{ ok: boolean; latencyMs: number; message: string }> {
  const started = Date.now()
  try {
    const models = await fetchProviderRemoteModels(provider, apiKey)
    const latencyMs = Date.now() - started
    return {
      ok: true,
      latencyMs,
      message: `连接成功 (${latencyMs}ms)，共返回 ${models.length} 个远端模型`
    }
  } catch (err) {
    const latencyMs = Date.now() - started
    return {
      ok: false,
      latencyMs,
      message: err instanceof Error ? err.message : String(err)
    }
  }
}
