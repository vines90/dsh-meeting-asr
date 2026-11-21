/**
 * 用 DeepSeek 给逐字稿自动起标题。
 * 保存时顺手调用，失败就保留时间戳标题，绝不阻塞转写。
 */
import { DEFAULT_BASE_URL, readPublicConfig, resolveApiKey } from './config.js'

const TITLE_TIMEOUT_MS = 20_000
const MAX_INPUT_CHARS = 2500

function chatEndpoint() {
  const base = String(readPublicConfig().baseUrl || DEFAULT_BASE_URL).replace(/\/+$/u, '')
  const asrBase = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${asrBase}/chat/completions`
}

function cleanTitle(raw) {
  let text = String(raw ?? '').trim()
  text = text.split('\n').map((line) => line.trim()).find(Boolean) || ''
  text = text.replace(/^#+\s*/u, '').replace(/^["'「『【\s]+|["'」』】。，,\s]+$/gu, '')
  text = text.replace(/^(标题|题目|会议标题)[：:]\s*/u, '')
  if (!text) return ''
  // 太长的截到 14 个字，别让模型写成一整句
  const chars = Array.from(text)
  if (chars.length > 14) text = `${chars.slice(0, 14).join('')}`
  if (chars.length < 2) return ''
  return text
}

/** 通用的一次性 chat 调用（标题、校对都走这里）。 */
export async function chatComplete(messages, options = {}) {
  const resolved = await resolveApiKey()
  const key = resolved?.value
  if (!key) throw new Error('没有配置 DeepSeek key')
  const response = await fetch(chatEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: options.model ?? 'deepseek-chat',
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 300,
      stream: false,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  })
  if (!response.ok) throw new Error(`DeepSeek 接口返回 ${response.status}`)
  const data = await response.json()
  return String(data?.choices?.[0]?.message?.content ?? '').trim()
}

/**
 * @param {string} markdown 逐字稿全文
 * @returns {Promise<string>} 标题；失败或没把握时返回空串
 */
export async function generateTitle(markdown) {
  if (readPublicConfig().autoName === false) return ''
  const excerpt = String(markdown ?? '').slice(0, MAX_INPUT_CHARS)
  if (excerpt.trim().length < 20) return ''
  const raw = await chatComplete([
    {
      role: 'system',
      content: '你给会议/对话逐字稿起标题。只输出标题本身：中文，8~14 个字，能看出主题或决定的事。'
        + '不要引号、不要标点结尾、不要解释。看不清主题就输出「未命名对话」。',
    },
    { role: 'user', content: `逐字稿：\n${excerpt}` },
  ], { maxTokens: 40, temperature: 0.2, timeoutMs: TITLE_TIMEOUT_MS })
  return cleanTitle(raw)
}
