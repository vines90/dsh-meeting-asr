/**
 * DeepSeek 语音识别：POST {baseUrl}/v1/tools/asr
 *
 * 约束（官方文档）：
 *   · 音频：16-bit PCM WAV 或 Ogg Opus，单/双声道（双声道只识别左声道）
 *   · 时长 ≤ 120 秒，文件 ≤ 8 MiB，上传 10 分钟内完成
 *   · 没有语种参数，自动识别；没有流式
 *   · 返回 { request_id, text, duration_ms }
 *   · 限速：单账号最多 50 个并发请求，超了返回 429
 */
import { API_PATH, describeApiKey, readPublicConfig, resolveApiKey } from './config.js'

export class AsrError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'AsrError'
    this.status = status
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504])
const ATTEMPTS = 3

function friendly(status, detail) {
  switch (status) {
    case 400:
      return '音频格式不被接受：DeepSeek ASR 只收 16-bit PCM WAV 或 Ogg Opus'
    case 401:
    case 403:
      return 'DeepSeek API Key 无效，或这个 key 没有 ASR 权限，请到会议记录面板重新填写'
    case 404:
      return '找不到 ASR 接口：baseUrl 可能指向了不支持的网关，默认应为 https://api.deepseek.com'
    case 408:
      return '音频上传超时'
    case 413:
      return '音频片段超过 8 MiB，请缩短片段'
    case 429:
      return 'DeepSeek ASR 并发超限，已自动重试；仍然失败时稍等几秒再继续'
    case 503:
      return 'DeepSeek ASR 服务繁忙，已自动重试'
    case 504:
      return '语音识别超时'
    default:
      return detail ? `语音识别失败：${detail}` : `语音识别失败（HTTP ${status}）`
  }
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * @param {Buffer | Uint8Array} bytes 16-bit PCM WAV
 * @param {{ filename?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<{ text: string, durationMs: number, requestId: string }>}
 */
export async function transcribeWav(bytes, options = {}) {
  const key = await resolveApiKey()
  if (!key) {
    throw new AsrError('还没有配置 DeepSeek API Key：请在会议记录面板里填写，或先在 DSH 里配好 DEEPSEEK_API_KEY', 401)
  }
  const { baseUrl } = readPublicConfig()
  const url = `${baseUrl}${API_PATH}`
  let lastError = null

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted')
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), options.filename || 'chunk.wav')

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key.value}` },
        body: form,
        signal: options.signal ?? AbortSignal.timeout(180_000),
      })
    } catch (error) {
      lastError = new AsrError(`连不上 DeepSeek ASR：${error instanceof Error ? error.message : String(error)}`, 0)
      if (attempt === ATTEMPTS - 1) throw lastError
      await sleep(500 * (attempt + 1) ** 2)
      continue
    }

    if (response.ok) {
      const payload = await response.json().catch(() => ({}))
      return {
        text: typeof payload.text === 'string' ? payload.text : '',
        durationMs: Number(payload.duration_ms) || 0,
        requestId: typeof payload.request_id === 'string' ? payload.request_id : '',
      }
    }

    const detail = await response.text().catch(() => '')
    const error = new AsrError(friendly(response.status, cleanDetail(detail)), response.status)
    if (!RETRYABLE.has(response.status) || attempt === ATTEMPTS - 1) throw error
    lastError = error
    await sleep(700 * (attempt + 1) ** 2)
  }

  throw lastError ?? new AsrError('语音识别失败', 0)
}

function cleanDetail(raw) {
  const text = String(raw ?? '').replace(/\s+/gu, ' ').trim()
  if (!text) return ''
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/** 16-bit PCM 静音 WAV，用来探测「接口是否可用 / key 是否有效」。 */
export function silenceWav(ms = 600, sampleRate = 16000) {
  const frames = Math.round((sampleRate * ms) / 1000)
  const bytes = frames * 2
  const buffer = Buffer.alloc(44 + bytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + bytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(bytes, 40)
  return buffer
}

/** 面板「测试连接」：能通就返回 ok，不通把原因带回去。 */
export async function probeAsr() {
  const key = await describeApiKey()
  if (!key.configured) {
    return { ok: false, key, reason: '还没有配置 DeepSeek API Key' }
  }
  const started = Date.now()
  try {
    const result = await transcribeWav(silenceWav(600), { filename: 'probe.wav' })
    return {
      ok: true,
      key,
      baseUrl: readPublicConfig().baseUrl,
      latencyMs: Date.now() - started,
      requestId: result.requestId,
      note: result.text ? `返回文本：${result.text.slice(0, 40)}` : '接口可用（静音片段没有文本是正常的）',
    }
  } catch (error) {
    return {
      ok: false,
      key,
      baseUrl: readPublicConfig().baseUrl,
      latencyMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error),
      status: error instanceof AsrError ? error.status : 0,
    }
  }
}
