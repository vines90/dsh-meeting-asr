/**
 * 场景提示（coach）：把当前逐字稿交给 DeepSeek，按场景给下一步建议。
 *
 * 设计取舍：
 * - 按需触发，不做自动轮询（每几分钟一次才符合真实用法，也省 token）
 * - 只送最近一段（默认末尾 3000 字），不送全文，成本可控
 * - 提示词由用户可改：预设只是起点，改了就以用户的为准
 */
import { readPublicConfig } from './config.js'
import { chatComplete } from './naming.js'

/** 送进模型的逐字稿上限，超过就从前往后截，保留最近的。 */
const MAX_TRANSCRIPT_CHARS = 3000
const MAX_SUGGESTIONS = 4

export const SCENES = [
  {
    key: 'interview',
    name: '访谈',
    hint: '追问含糊处、识别客套话',
    prompt: [
      '你在旁听一场用户访谈，逐字稿来自语音识别，可能有错字。',
      '基于最近的对话，给我 2~4 条能直接用的建议：',
      '1. 哪个点对方说得含糊或回避，值得追问——直接写出追问的原话；',
      '2. 对方有没有在客套、跑题、或者只是复述常识；',
      '3. 下一步最该问的问题是什么。',
      '每条一行、30 字以内，不要复述原文，不要编造对方没提过的需求。',
    ].join('\n'),
  },
  {
    key: 'negotiation',
    name: '商务谈判',
    hint: '对方顾虑、我方让步、下一句',
    prompt: [
      '你在旁听一场商务谈判，逐字稿来自语音识别，可能有错字。',
      '基于最近的对话，给我 2~4 条建议：',
      '1. 对方真正在意的是什么（从措辞判断，并点出依据那句话）；',
      '2. 我方有没有过早让步、暴露底线或承诺了没确认的条件；',
      '3. 下一句该怎么说——给可以直接说出口的短句。',
      '每条一行、30 字以内。价格、条款、数字一律不要编造，听不清就写「待确认」。',
    ].join('\n'),
  },
  {
    key: 'job-interview',
    name: '面试',
    hint: '回答缺证据、能力未验证、红旗',
    prompt: [
      '你在旁听一场面试，逐字稿来自语音识别，可能有错字。',
      '基于最近的对话，给我 2~4 条建议：',
      '1. 候选人哪句只有结论没有例子，该怎么追问具体案例；',
      '2. 哪项关键能力还没被验证，给出下一个问题；',
      '3. 有没有红旗信号（含糊、甩锅、数据对不上）。',
      '每条一行、30 字以内。不要替我做录用结论，不要编造候选人的经历。',
    ].join('\n'),
  },
]

export function scenePreset(key) {
  return SCENES.find((scene) => scene.key === key) || SCENES[0]
}

/**
 * 把逐字稿压成送模型的样子：带时间与说话人，保留最近的部分。
 */
export function buildTranscript(segments) {
  const rows = (segments ?? [])
    .filter((segment) => String(segment?.text ?? '').trim())
    .slice(-40)
  const lines = rows.map((segment) => {
    const seconds = Math.round((Number(segment.startMs) || 0) / 1000)
    const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    const label = String(segment.label ?? '').trim() || '说话人'
    return `[${clock}] ${label}：${String(segment.text).trim()}`
  })
  let text = lines.join('\n')
  if (text.length > MAX_TRANSCRIPT_CHARS) text = text.slice(text.length - MAX_TRANSCRIPT_CHARS)
  return text
}

/**
 * @param {{ segments: { label?: string, text: string, startMs?: number }[], key?: string, prompt?: string }} input
 * @returns {Promise<{ suggestions: string[], transcriptChars: number }>}
 */
export async function coachHint(input) {
  const transcript = buildTranscript(input.segments)
  if (transcript.length < 20) throw new Error('对话还太短，先说几句再要提示')

  const preset = scenePreset(input.key)
  const custom = String(input.prompt ?? '').trim()
  const scenePrompt = custom || preset.prompt

  const raw = await chatComplete([
    {
      role: 'system',
      content: `${scenePrompt}\n\n只输出建议本身，每条一行，不要序号以外的解释，不要 Markdown 标题，不要复述逐字稿。`,
    },
    { role: 'user', content: `【当前对话逐字稿（可能不完整）】\n${transcript}` },
  ], { maxTokens: 260, temperature: 0.3, timeoutMs: 20_000 })

  const suggestions = String(raw ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*·]|\d+[.、)])\s*/u, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_SUGGESTIONS)

  return { suggestions, transcriptChars: transcript.length }
}

export function readCoachConfig() {
  const config = readPublicConfig()
  return { key: config.sceneKey || 'interview', prompt: config.scenePrompt || '' }
}
