/**
 * dsh-meeting-asr —— 配置与凭证。
 *
 * 密钥只走 DSH 凭证服务或环境变量，永远不写进插件源码 / 插件目录：
 *   DEEPSEEK_ASR_API_KEY  面板里填的专用 key（优先）
 *   DEEPSEEK_API_KEY      运行时已经配好的 DeepSeek key（兜底）
 * 非敏感字段（baseUrl）落在 ~/.dsh/meeting-asr.json。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PRIMARY_KEY_REF = 'DEEPSEEK_ASR_API_KEY'
export const FALLBACK_KEY_REF = 'DEEPSEEK_API_KEY'
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const API_PATH = '/v1/tools/asr'

export const CONFIG_DIR = join(homedir(), '.dsh')
export const CONFIG_FILE = join(CONFIG_DIR, 'meeting-asr.json')
export const NOTES_DIR = join(CONFIG_DIR, 'meeting-notes')
export const AUDIO_DIR = join(NOTES_DIR, 'audio')
export const TMP_DIR = join(NOTES_DIR, 'tmp')
export const NOTES_INDEX = join(NOTES_DIR, 'index.json')

/** 官网限时折扣价，只用于面板上的费用估算。 */
export const PRICE_CNY_PER_HOUR = 0.39
/** DeepSeek ASR 单次请求上限：120 秒 / 8 MiB。 */
export const MAX_CHUNK_SECONDS = 100
/** 默认切片长度：越小时间戳越细，请求数越多（计费只按音频时长，与片数无关）。 */
export const DEFAULT_CHUNK_SECONDS = 60

/** @type {{ resolve(ref: string): Promise<{ value: string, source: string } | undefined>, describe(ref: string): Promise<{ configured: boolean, writable: boolean, source?: string }>, set(ref: string, value: string): Promise<void> } | null} */
let credentialsApi = null

export function bindCredentials(api) {
  credentialsApi = api
}

export function ensureDirs() {
  mkdirSync(NOTES_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 })
  mkdirSync(AUDIO_DIR, { recursive: true, mode: 0o700 })
}

function readStored() {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function asBaseUrl(value) {
  const url = typeof value === 'string' ? value.trim().replace(/\/+$/u, '') : ''
  return url.length > 0 && URL.canParse(url) ? url : DEFAULT_BASE_URL
}

export function readPublicConfig() {
  const stored = readStored()
  const chunk = Number(stored.chunkSeconds)
  return {
    baseUrl: asBaseUrl(stored.baseUrl ?? process.env.DEEPSEEK_ASR_BASE_URL),
    chunkSeconds: Number.isFinite(chunk) && chunk >= 10 && chunk <= MAX_CHUNK_SECONDS ? chunk : DEFAULT_CHUNK_SECONDS,
  }
}

export function writePublicConfig(patch) {
  const next = { ...readStored() }
  if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) next.baseUrl = asBaseUrl(patch.baseUrl)
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return readPublicConfig()
}

/**
 * @returns {Promise<{ value: string, source: string, ref: string } | undefined>}
 */
export async function resolveApiKey() {
  for (const ref of [PRIMARY_KEY_REF, FALLBACK_KEY_REF]) {
    if (credentialsApi) {
      const hit = await credentialsApi.resolve(ref)
      const value = hit?.value?.trim()
      if (value) return { value, source: hit.source ?? 'credentials', ref }
    }
    const fromEnv = process.env[ref]?.trim()
    if (fromEnv) return { value: fromEnv, source: 'env', ref }
  }
  return undefined
}

export async function describeApiKey() {
  for (const ref of [PRIMARY_KEY_REF, FALLBACK_KEY_REF]) {
    if (credentialsApi) {
      const info = await credentialsApi.describe(ref)
      if (info?.configured) {
        return { configured: true, ref, source: info.source ?? 'credentials', writable: info.writable !== false }
      }
    } else if (process.env[ref]?.trim()) {
      return { configured: true, ref, source: 'env', writable: true }
    }
  }
  return { configured: false, ref: PRIMARY_KEY_REF, source: null, writable: Boolean(credentialsApi) }
}

export async function setApiKey(token) {
  const value = String(token ?? '').trim()
  if (!value) throw new Error('API key 不能为空')
  if (!credentialsApi) throw new Error('当前运行时没有 DSH 凭证服务，无法保存 key')
  await credentialsApi.set(PRIMARY_KEY_REF, value)
  return describeApiKey()
}

export async function clearApiKey() {
  if (!credentialsApi) return describeApiKey()
  try {
    await credentialsApi.set(PRIMARY_KEY_REF, '')
  } catch {
    /* 某些实现不接受空值，忽略 */
  }
  return describeApiKey()
}
