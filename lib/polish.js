/**
 * 识别后的实时校正（可选）。
 *
 * 两种能力，可靠性不同：
 *   polishText     用 DeepSeek 改错别字 / 同音字 / 漏字 / 断句 —— 可靠，但必须防「模型自行改写」
 *   polishSpeaker  用对话上下文猜这句话是不是被标错了说话人 —— 只是猜测，默认关
 *
 * 两条都只作用于「刚识别完的这一句」，改不动历史，也不改原始音频。
 */
import { readPublicConfig } from './config.js'
import { chatComplete } from './naming.js'

/** 前文带多少句给模型做参考。 */
const MAX_CONTEXT = 6
/** 允许的最大改动比例：超过它说明模型在改写，不是在纠错。 */
const MAX_CHANGE_RATIO = 0.4

function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

function stripFence(raw) {
  return String(raw ?? '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/```$/u, '').trim()
}

function parseModelOutput(raw) {
  const text = stripFence(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      return { text: typeof parsed.text === 'string' ? parsed.text.trim() : '', speaker: typeof parsed.speaker === 'string' ? parsed.speaker.trim() : '' }
    } catch {
      /* 落回纯文本 */
    }
  }
  return { text: text.replace(/^["'「]+|["'」]+$/gu, ''), speaker: '' }
}

/** 改动过大就当模型在改写，丢掉；没改也返回空串，让调用方决定。 */
function guardText(original, corrected) {
  const a = String(original ?? '').replace(/\s+/gu, '')
  const b = String(corrected ?? '').replace(/\s+/gu, '')
  if (!b || b === a) return ''
  const distance = levenshtein(a, b)
  if (distance / Math.max(a.length, b.length) > MAX_CHANGE_RATIO) return ''
  return corrected
}

/* ---------------------------------------------- 相邻两句：合并 / 说话人纠正 */

/** 上一句已经是完整句时不许合并（句末标点是最好的判据）。 */
const SENTENCE_END = /[。！？!?…]$/u

function safeJoin(a, b) {
  if (!a || !b) return ''
  if (SENTENCE_END.test(a.trim())) return ''
  const joined = `${a.trim()}${b.trim()}`
  return joined.length <= 200 ? joined : ''
}

/**
 * 一次看相邻两句：能合并就合并，说话人可能是标错就纠正。
 * @param {{ prev: { text: string, label: string, startMs?: number }, next: { text: string, label: string }, context?: { label: string, text: string }[], labels?: string[], allowSpeaker?: boolean }} input
 * @returns {Promise<{ prevText?: string, nextText?: string, join?: string, speaker?: string }>}
 */
export async function polishPair(input) {
  const config = readPublicConfig()
  if (!config.polishText && !config.polishSpeaker) return {}
  const prev = { text: String(input.prev?.text ?? '').trim(), label: String(input.prev?.label ?? '') }
  const next = { text: String(input.next?.text ?? '').trim(), label: String(input.next?.label ?? '') }
  if (!prev.text || !next.text) return {}

  const allowed = (input.labels ?? []).filter((item) => typeof item === 'string' && item)
  const allowSpeaker = config.polishSpeaker && input.allowSpeaker === true && allowed.length > 1
  const history = (input.context ?? [])
    .slice(-4)
    .map((row) => `${row.label}：${row.text}`)
    .join('\n')

  const rules = [
    '你在校对一段实时会议逐字稿里相邻的两句（A 是上一句，B 是下一句，来自两次切片）。',
    '只做三件事，其余一律不动：',
    '1. 改错别字、同音字、漏字，补必要的断句标点；不改写、不删减、不添加原文没有的信息。',
    '2. 如果 A 在句子中间被切断、B 正好是它的后半句（凑在一起才成句），把两段合并成一句：join 设 true，a 给合并后的完整句子，b 给空串。',
    '   注意：这种情况下即使两段标了不同说话人，也说明说话人判错了——人不可能把半句话交给别人说完，合并时以 A 的说话人为准。',
    '3. 如果 B 是完整的句子、但明显是同一个人接着 A 往下说（比如 A 是提问的一半、B 补完），也可以合并。',
    '4. 只有在这两种情况下才给 speaker；其余情况 speaker 留空字符串，不要猜。',
    '输出严格的 JSON，不要代码块、不要解释：',
    '{"a":"A 修正后（合并时给完整句）","b":"B 修正后（合并时给空串）","join":false,"speaker":""}',
  ]
  if (allowSpeaker) rules.push(`speaker 只能是这些之一：${allowed.join(' / ')}；没把握就留空字符串。`)

  let raw = ''
  try {
    raw = await chatComplete([
      { role: 'system', content: rules.join('\n') },
      { role: 'user', content: `前文（只作参考）：\n${history || '（无）'}\n\nA（${prev.label}）：${prev.text}\nB（${next.label}）：${next.text}` },
    ], { maxTokens: 320, temperature: 0, timeoutMs: 12_000 })
  } catch {
    return {}
  }

  const text = stripFence(raw)
  let parsed = {}
  const startIndex = text.indexOf('{')
  const endIndex = text.lastIndexOf('}')
  if (startIndex >= 0 && endIndex > startIndex) {
    try {
      parsed = JSON.parse(text.slice(startIndex, endIndex + 1))
    } catch {
      return {}
    }
  }

  const result = {}
  const a = typeof parsed.a === 'string' ? parsed.a.trim() : ''
  const b = typeof parsed.b === 'string' ? parsed.b.trim() : ''

  if (config.polishText) {
    const wantJoin = parsed.join === true
    if (wantJoin) {
      const joined = safeJoin(prev.text, next.text)
      // 模型说合并，但把它给的 a/b 拼起来与原句差太多时，退回按原句直接拼
      const modelJoined = a && guardText(prev.text + next.text, a)
      if (joined) result.join = modelJoined || joined
    } else {
      const fixedPrev = guardText(prev.text, a)
      const fixedNext = guardText(next.text, b)
      if (fixedPrev) result.prevText = fixedPrev
      if (fixedNext) result.nextText = fixedNext
    }
  }

  if (allowSpeaker && typeof parsed.speaker === 'string') {
    const speaker = parsed.speaker.trim()
    if (allowed.includes(speaker) && speaker !== next.label) result.speaker = speaker
  }
  return result
}

/**
 * @param {{ text: string, label?: string, context?: { label: string, text: string }[], labels?: string[], allowSpeaker?: boolean }} input
 * @returns {Promise<{ text?: string, speaker?: string }>}
 */
export async function polishSegment(input) {
  const config = readPublicConfig()
  if (!config.polishText && !config.polishSpeaker) return {}

  const text = String(input.text ?? '').trim()
  if (text.length < 2) return {}
  const label = String(input.label ?? '说话人')
  const allowed = (input.labels ?? []).filter((item) => typeof item === 'string' && item)
  const history = (input.context ?? [])
    .slice(-MAX_CONTEXT)
    .map((row) => `${row.label}：${row.text}`)
    .join('\n')

  const rules = [
    '你在校对会议语音识别的逐字稿。只做最小修正：改同音字、错别字、漏字，补必要的断句标点。',
    '禁止：改写说法、扩写、删减内容、合并句子、补原文没有的信息。口语词（嗯、那个、就是）保留，除非明显是识别错的字。',
    '输出严格的 JSON，不要代码块，不要解释：{"text":"修正后的这一句"}',
  ]
  // 说话人只在「单通道 + 短句」时让模型猜：长句、双通道、多人场景误判率明显更高
  const allowSpeaker = config.polishSpeaker && input.allowSpeaker === true && allowed.length > 1 && text.length <= 40
  if (allowSpeaker) {
    rules.push(`如果你判断这句话其实不是 ${label} 说的（从上下文能看出来），再加一个字段 "speaker"，取值必须是这些之一：${allowed.join(' / ')}。没把握就不要加。`)
  }

  let raw = ''
  try {
    raw = await chatComplete([
      { role: 'system', content: rules.join('\n') },
      { role: 'user', content: `前文（只作参考，不要修改）：\n${history || '（无）'}\n\n要校对的这一句（当前标为 ${label}）：${text}` },
    ], { maxTokens: 220, temperature: 0, timeoutMs: 12_000 })
  } catch {
    return {}
  }

  const parsed = parseModelOutput(raw)
  const result = {}
  if (input.debug) {
    result.debug = {
      raw: raw.slice(0, 200),
      modelText: parsed.text.slice(0, 200),
      modelSpeaker: parsed.speaker || '',
      changed: Boolean(guardText(text, parsed.text)),
    }
  }
  if (config.polishText) {
    const fixed = guardText(text, parsed.text)
    if (fixed) result.text = fixed
  }
  if (allowSpeaker && parsed.speaker && allowed.includes(parsed.speaker) && parsed.speaker !== label) {
    result.speaker = parsed.speaker
  }
  return result
}
