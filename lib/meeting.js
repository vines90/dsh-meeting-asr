/**
 * 会议记录核心：逐字稿 markdown、记录库、以及「本机音视频文件 → 切片 → ASR」流水线。
 *
 * 为什么切片：DeepSeek ASR 单请求上限 120 秒 / 8 MiB，且不支持流式。
 * 这里按 100 秒一段切（16k 单声道 16-bit ≈ 3.2 MB），双声道音频可拆成两条轨，
 * 每条轨单独转写 —— 这是唯一靠 ASR 本身能拿到的「说话人区分」。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  MAX_CHUNK_SECONDS,
  NOTES_DIR,
  NOTES_INDEX,
  PRICE_CNY_PER_HOUR,
  TMP_DIR,
  ensureDirs,
  readPublicConfig,
} from './config.js'
import { transcribeWav } from './asr.js'
import { diarize, modelsReady } from './diarize.js'
import { generateTitle } from './naming.js'

const SAMPLE_RATE = 16000
const BYTES_PER_SECOND = SAMPLE_RATE * 2
const MAX_DURATION_MS = 4 * 60 * 60 * 1000
const TRANSCRIBE_CONCURRENCY = 3
/** 切片的静音判定：16-bit 绝对值低于它算静音（约 -35 dBFS）。 */
const SILENCE_ABS = 600
/** 连续静音达到这个长度才当作可切的句子边界。 */
const SILENCE_RUN_MS = 250
/** 在切片末尾往前最多找这么久，找不到静音就硬切。 */
const MAX_BACK_SILENCE_MS = 15_000

/* ------------------------------------------------------------------ 时间格式 */

export function formatClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  const seconds = Math.floor(total / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatDuration(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function localStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function localDateTime(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function slugify(text) {
  return String(text ?? '')
    .replace(/[\\/:*?"<>|\s]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40) || '会议记录'
}

/* --------------------------------------------------------------- 逐字稿 markdown */

/**
 * @param {{ title?: string, createdAt?: Date, durationMs?: number, segments?: Array<{label?: string, startMs?: number, text?: string}>, mode?: string, source?: string, costCny?: number }} input
 */
export function buildNoteMarkdown(input) {
  const createdAt = input.createdAt instanceof Date ? input.createdAt : new Date()
  const segments = [...(input.segments ?? [])]
    .filter((segment) => String(segment?.text ?? '').trim())
    .sort((a, b) => (Number(a.startMs) || 0) - (Number(b.startMs) || 0))
  const chars = segments.reduce((sum, segment) => sum + String(segment.text).trim().length, 0)
  const cost = input.costCny ?? (((Number(input.durationMs) || 0) / 3_600_000) * PRICE_CNY_PER_HOUR)
  const lines = [
    `# ${input.title || '会议记录'}`,
    '',
    `- 时间：${localDateTime(createdAt)}`,
    `- 时长：${formatDuration(input.durationMs)}`,
    `- 说话人：${input.mode || '单通道（不区分说话人）'}`,
    '- 引擎：DeepSeek 语音识别（/v1/tools/asr，非流式，按固定长度切片转写）',
    `- 估算费用：约 ¥${cost.toFixed(2)}（按官网 ¥${PRICE_CNY_PER_HOUR}/小时 的限时价折算，实际以账单为准）`,
  ]
  if (input.source) lines.push(`- 来源：${input.source}`)
  if (input.audioPath) lines.push(`- 原音：${input.audioPath}`)
  lines.push('', '## 逐字稿', '')
  if (!segments.length) {
    lines.push('_没有识别到语音内容。_')
  } else {
    for (const segment of segments) {
      const label = String(segment.label ?? '说话人').trim() || '说话人'
      const text = String(segment.text).trim().replace(/\n+/gu, ' ')
      lines.push(`**[${formatClock(segment.startMs)}] ${label}**：${text}`)
    }
  }
  lines.push(
    '',
    '---',
    '',
    '> 由 dsh-meeting-asr 自动转写。DeepSeek ASR 不返回逐词时间戳，方括号里是**切片起点**（文件转写默认每 60 秒一片、实时录音每 18 秒一片），同一片内的先后不分。ASR 本身也不做说话人识别：只有「双通道」录音（两个麦克风，或麦克风 + 系统声音）才能把「我 / 参会者」分开；单通道录音统一标为「说话人」。人名、专业术语、数字可能有误，重要结论请回听原音。',
  )
  return { markdown: lines.join('\n'), chars, segmentCount: segments.length, costCny: cost }
}

/* --------------------------------------------------------------------- 记录库 */

function readIndex() {
  try {
    const parsed = JSON.parse(readFileSync(NOTES_INDEX, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeIndex(entries) {
  ensureDirs()
  writeFileSync(NOTES_INDEX, `${JSON.stringify(entries.slice(0, 300), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

/**
 * @param {{ title?: string, createdAt?: Date, durationMs?: number, segments?: Array<object>, mode?: string, source?: string, costCny?: number }} input
 */
export function saveNote(input) {
  ensureDirs()
  const createdAt = input.createdAt instanceof Date ? input.createdAt : new Date()
  const title = String(input.title || `会议记录 ${localDateTime(createdAt)}`).trim()
  const built = buildNoteMarkdown({ ...input, title, createdAt })
  const id = `${localStamp(createdAt)}-${randomUUID().slice(0, 6)}`
  const path = join(NOTES_DIR, `${id}-${slugify(title)}.md`)
  writeFileSync(path, `${built.markdown}\n`, { encoding: 'utf8', mode: 0o600 })
  const entry = {
    id,
    title,
    path,
    createdAt: createdAt.toISOString(),
    durationMs: Number(input.durationMs) || 0,
    mode: input.mode || '单通道（不区分说话人）',
    segments: built.segmentCount,
    chars: built.chars,
    costCny: Number(built.costCny.toFixed(3)),
    source: input.source || 'live',
    audioPath: input.audioPath || '',
  }
  const entries = readIndex().filter((row) => row.id !== id)
  entries.unshift(entry)
  writeIndex(entries)
  return { ...entry, markdown: built.markdown }
}

/** 改标题：同时改文件名、markdown 首行 H1 和索引。 */
export function renameNote(key, title) {
  const wanted = String(key ?? '').trim()
  const nextTitle = String(title ?? '').trim()
  if (!wanted) throw new Error('请提供记录 id 或路径')
  if (!nextTitle) throw new Error('标题不能为空')
  const entries = readIndex()
  const index = entries.findIndex((row) => row.id === wanted || row.title === wanted || row.path === wanted)
  if (index < 0) throw new Error(`找不到这份记录：${wanted}`)
  const entry = entries[index]
  const markdown = readFileSync(entry.path, 'utf8')
  const lines = markdown.split('\n')
  if (lines[0]?.startsWith('# ')) lines[0] = `# ${nextTitle}`
  const ext = extname(entry.path)
  const nextPath = join(dirname(entry.path), `${entry.id}-${slugify(nextTitle)}${ext}`)
  writeFileSync(nextPath, lines.join('\n'), { encoding: 'utf8', mode: 0o600 })
  if (nextPath !== entry.path) {
    try { unlinkSync(entry.path) } catch { /* 旧文件可能已经不在了 */ }
  }
  const next = { ...entry, title: nextTitle, path: nextPath }
  entries[index] = next
  writeIndex(entries)
  return next
}

/** 删一份记录：markdown、原音、索引条目一起清掉。 */
export function deleteNote(key) {
  const wanted = String(key ?? '').trim()
  if (!wanted) throw new Error('请提供记录 id')
  const entries = readIndex()
  const index = entries.findIndex((row) => row.id === wanted || row.title === wanted || row.path === wanted)
  if (index < 0) throw new Error(`找不到这份记录：${wanted}`)
  const entry = entries[index]
  try { unlinkSync(entry.path) } catch { /* 文件可能已经被手动删了 */ }
  if (entry.audioPath) {
    try { unlinkSync(entry.audioPath) } catch { /* 原音可能已经不在了 */ }
  }
  entries.splice(index, 1)
  writeIndex(entries)
  return entry
}

export function listNotes(limit = 20) {
  return readIndex().slice(0, Math.max(1, Math.min(200, Number(limit) || 20)))
}

export function readNote(key) {
  const wanted = String(key ?? '').trim()
  if (!wanted) throw new Error('请提供记录 id 或文件路径')
  const entries = readIndex()
  const hit = entries.find((row) => row.id === wanted)
    ?? entries.find((row) => row.title === wanted)
    ?? entries.find((row) => row.path === wanted)
  const path = hit?.path ?? wanted
  if (!existsSync(path)) throw new Error(`找不到这份记录：${path}`)
  return { path, markdown: readFileSync(path, 'utf8'), entry: hit ?? null }
}

/* -------------------------------------------------------------------- ffmpeg */

const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

function resolveBinary(name, envPath) {
  if (envPath && existsSync(envPath)) return envPath
  for (const dir of BIN_DIRS) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return name
}

function ffmpegPath() {
  return resolveBinary('ffmpeg', process.env.FFMPEG_PATH)
}

function ffprobePath() {
  return resolveBinary('ffprobe', process.env.FFPROBE_PATH)
}

function runCapture(bin, args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error(`${basename(bin)} 超时`))
    }, timeoutMs)
    proc.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    proc.stderr.on('data', (chunk) => { err = (err + chunk.toString('utf8')).slice(-4000) })
    proc.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`起不了 ${bin}：${error.message}`))
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`${basename(bin)} 退出码 ${code}：${err.trim() || '没有输出'}`))
    })
  })
}

/**
 * @param {string} filePath
 * @returns {Promise<{ durationMs: number, channels: number, hasAudio: boolean, format: string }>}
 */
export async function probeMedia(filePath) {
  const raw = await runCapture(ffprobePath(), [
    '-v', 'error',
    '-show_entries', 'format=duration,format_name:stream=codec_type,channels',
    '-of', 'json',
    filePath,
  ])
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('读不出音频信息（ffprobe 返回异常）')
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const audio = streams.filter((stream) => stream.codec_type === 'audio')
  const channels = audio.reduce((max, stream) => Math.max(max, Number(stream.channels) || 0), 0)
  const durationSeconds = Number(parsed.format?.duration) || 0
  return {
    durationMs: Math.round(durationSeconds * 1000),
    channels: channels || 1,
    hasAudio: audio.length > 0,
    format: String(parsed.format?.format_name ?? ''),
  }
}

/** 裸 16-bit PCM 包成 WAV（DeepSeek ASR 只收 WAV / Ogg Opus）。 */
function wavWrap(pcm, sampleRate = SAMPLE_RATE) {
  const usable = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + usable.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(usable.length, 40)
  return Buffer.concat([header, usable])
}

/**
 * 在切片末尾往前找一个「足够长静音的起点」再切，避免把句子切成两半。
 * 找不到就硬切。返回字节偏移（偶数）。
 */
function findCutPoint(buffer, chunkBytes) {
  const maxBack = Math.min(chunkBytes, Math.round((MAX_BACK_SILENCE_MS / 1000) * BYTES_PER_SECOND))
  const startFrame = Math.max(0, (chunkBytes - maxBack) >> 1)
  const endFrame = Math.min(buffer.length >> 1, chunkBytes >> 1)
  const runFrames = Math.round((SILENCE_RUN_MS / 1000) * SAMPLE_RATE)
  let run = 0
  for (let frame = endFrame - 1; frame >= startFrame; frame -= 1) {
    const value = buffer.readInt16LE(frame << 1)
    run = value < SILENCE_ABS && value > -SILENCE_ABS ? run + 1 : 0
    if (run >= runFrames) {
      const cut = frame << 1
      if (cut >= BYTES_PER_SECOND) return cut
    }
  }
  return chunkBytes
}

/**
 * 把音轨解码成 16k / 单声道 / 16-bit PCM，按 chunkBytes 切片、优先切在静音处。
 * 每片吐 { wav, durationMs }（wav 已带 RIFF 头）。
 * @param {string} filePath
 * @param {number | null} channel 0=左, 1=右, null=混成单声道
 * @param {number} chunkBytes
 */
async function* decodeChunks(filePath, channel, chunkBytes) {
  const args = ['-v', 'error', '-nostdin', '-i', filePath]
  if (channel === null) {
    args.push('-ac', '1')
  } else {
    args.push('-af', `pan=mono|c0=c${channel}`)
  }
  args.push('-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1')

  const proc = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const queue = []
  let stderrText = ''
  let closed = null
  let wake = null

  proc.stdout.on('data', (chunk) => {
    queue.push(chunk)
    if (wake) {
      const resume = wake
      wake = null
      resume()
    }
  })
  proc.stderr.on('data', (chunk) => { stderrText = (stderrText + chunk.toString('utf8')).slice(-4000) })
  proc.on('error', (error) => {
    closed = -1
    stderrText = `起不了 ffmpeg：${error.message}`
    if (wake) { const resume = wake; wake = null; resume() }
  })
  proc.on('close', (code) => {
    closed = code ?? 0
    if (wake) { const resume = wake; wake = null; resume() }
  })

  const emit = (pcm) => ({
    wav: wavWrap(pcm),
    durationMs: Math.round((pcm.length / BYTES_PER_SECOND) * 1000),
  })

  let acc = Buffer.alloc(0)
  try {
    for (;;) {
      let pulled = false
      while (queue.length) {
        const next = queue.shift()
        acc = acc.length ? Buffer.concat([acc, next]) : next
        pulled = true
      }
      while (acc.length >= chunkBytes) {
        const cut = findCutPoint(acc, chunkBytes)
        yield emit(acc.subarray(0, cut))
        acc = acc.subarray(cut)
      }
      if (!pulled) {
        if (closed !== null) break
        await new Promise((resolve) => { wake = resolve })
      }
    }
    if (acc.length >= BYTES_PER_SECOND * 0.4) yield emit(Buffer.from(acc))
    if (closed !== 0) throw new Error(`ffmpeg 解码失败：${stderrText.trim() || `退出码 ${closed}`}`)
  } finally {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }
}

/** 整段解码成 16k 单声道 float 采样（说话人分离要先看完整段）。 */
async function decodeAllSamples(filePath, maxSeconds) {
  const limit = Math.round(maxSeconds * BYTES_PER_SECOND)
  const proc = spawn(ffmpegPath(), ['-v', 'error', '-nostdin', '-i', filePath, '-ac', '1', '-ar', '16000', '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const parts = []
  let total = 0
  let stderrText = ''
  let truncated = false
  proc.stderr.on('data', (chunk) => { stderrText = (stderrText + chunk.toString('utf8')).slice(-2000) })
  for await (const chunk of proc.stdout) {
    if (truncated) continue
    const room = limit - total
    if (room <= 0) { truncated = true; continue }
    const slice = chunk.length > room ? chunk.subarray(0, room) : chunk
    parts.push(slice)
    total += slice.length
  }
  const code = await new Promise((resolve) => {
    proc.on('close', resolve)
    proc.on('error', () => resolve(-1))
  })
  if (code !== 0 || !total) throw new Error(`解码失败：${stderrText.trim() || `退出码 ${code}`}`)
  const buffer = Buffer.concat(parts)
  const samples = new Float32Array(buffer.length / 2)
  for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(i * 2) / 32768
  return { samples, truncated }
}

function pcm16FromSamples(samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), i * 2)
  }
  return buffer
}

/* ------------------------------------------------------------------- 转写任务 */

/** @type {Map<string, object>} */
const jobs = new Map()

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    title: job.title,
    mode: job.mode,
    filePath: job.filePath,
    durationMs: job.durationMs,
    totalMs: job.totalMs,
    doneMs: job.doneMs,
    progress: job.totalMs > 0 ? Math.min(1, job.doneMs / job.totalMs) : 0,
    segments: job.segments,
    error: job.error,
    warning: job.warning,
    notePath: job.notePath,
    noteId: job.noteId || '',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}

export function getJob(id) {
  const job = jobs.get(String(id))
  return job ? publicJob(job) : null
}

/**
 * @param {{ filePath: string, dualTrack?: boolean, title?: string }} input
 */
export async function startFileJob(input) {
  ensureDirs()
  const filePath = String(input.filePath ?? '').trim()
  if (!filePath) throw new Error('缺少音频文件路径')
  if (!existsSync(filePath)) throw new Error(`文件不存在：${filePath}`)
  const size = statSync(filePath).size
  if (size > 2 * 1024 * 1024 * 1024) throw new Error('文件大于 2 GB，请先切分')
  const job = {
    id: randomUUID().slice(0, 8),
    state: 'running',
    title: String(input.title || basename(filePath)).trim(),
    mode: '单通道（不区分说话人）',
    filePath,
    durationMs: 0,
    totalMs: 0,
    doneMs: 0,
    segments: [],
    error: '',
    warning: '',
    notePath: '',
    startedAt: new Date().toISOString(),
    finishedAt: '',
  }
  jobs.set(job.id, job)
  job.speakers = Number(input.speakers) > 0 ? Number(input.speakers) : 0
  job.diarize = input.diarize !== false
  job.promise = runFileJob(job, Boolean(input.dualTrack)).catch((error) => {
    job.state = 'failed'
    job.error = error instanceof Error ? error.message : String(error)
    job.finishedAt = new Date().toISOString()
  })
  return publicJob(job)
}

export async function waitJob(jobId, timeoutMs = 30 * 60 * 1000) {
  const job = jobs.get(String(jobId))
  if (!job) throw new Error('找不到这个转写任务')
  let timer = null
  try {
    await Promise.race([
      job.promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('转写超时')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  return publicJob(job)
}

async function runFileJob(job, dualTrack) {
  const meta = await probeMedia(job.filePath)
  if (!meta.hasAudio) throw new Error('这个文件里没有音频轨')
  if (meta.durationMs > MAX_DURATION_MS) throw new Error('音频超过 4 小时，请先切分成几个文件')
  job.durationMs = meta.durationMs

  const tracks = dualTrack && meta.channels >= 2
    ? [{ channel: 0, label: '说话人A' }, { channel: 1, label: '说话人B' }]
    : [{ channel: null, label: '说话人' }]
  job.mode = tracks.length === 2
    ? '双通道（左右声道各一位说话人）'
    : '单通道（不区分说话人）'
  job.totalMs = Math.max(1, meta.durationMs * tracks.length)

  // 单声道 + 有模型时：先用本地声纹把说话人分开，再按人分组转写
  if (tracks.length === 1 && job.diarize && modelsReady() && meta.durationMs <= 60 * 60 * 1000) {
    try {
      if (await runDiarizedJob(job, meta)) return
    } catch (error) {
      job.warning = `说话人分离没跑成，已退回普通切段：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const chunkSeconds = Math.max(10, Math.min(MAX_CHUNK_SECONDS, readPublicConfig().chunkSeconds))
  const chunkBytes = chunkSeconds * BYTES_PER_SECOND
  const state = { active: 0, failures: 0, lastError: '' }

  const transcribeOne = async ({ wav, durationMs, label, startMs }) => {
    while (state.active >= TRANSCRIBE_CONCURRENCY) {
      await new Promise((resolve) => { setTimeout(resolve, 60) })
    }
    state.active += 1
    try {
      const result = await transcribeWav(wav, { filename: `chunk-${startMs}.wav` })
      const text = String(result.text ?? '').trim()
      if (text) job.segments.push({ label, startMs, text })
    } catch (error) {
      state.failures += 1
      state.lastError = error instanceof Error ? error.message : String(error)
    } finally {
      state.active -= 1
      job.doneMs = Math.min(job.totalMs, job.doneMs + durationMs)
    }
  }

  // 逐段解码 + 转写；两条轨并行，时间戳按实际已消费的音频字节算，不按片序号。
  const runners = tracks.map(async (track) => {
    let consumedBytes = 0
    for await (const chunk of decodeChunks(job.filePath, track.channel, chunkBytes)) {
      const startMs = Math.round((consumedBytes / BYTES_PER_SECOND) * 1000)
      consumedBytes += Math.round((chunk.durationMs / 1000) * BYTES_PER_SECOND)
      await transcribeOne({ ...chunk, label: track.label, startMs })
    }
  })
  await Promise.all(runners)

  if (!job.segments.length) {
    throw new Error(state.failures ? `全部片段转写失败：${state.lastError}` : '没有识别到语音内容（可能是纯音乐或音量过低）')
  }
  if (state.failures) {
    job.warning = `${state.failures} 个片段转写失败，最后一次错误：${state.lastError}`
  }
  await finalizeJob(job)
}

async function finalizeJob(job) {
  const saved = saveNote({
    title: job.title,
    createdAt: new Date(),
    durationMs: job.durationMs,
    segments: job.segments,
    mode: job.mode,
    source: `文件：${job.filePath}`,
  })
  const named = await autoNameNote(saved)
  job.notePath = named.path
  job.noteId = named.id
  job.noteTitle = named.title
  job.chars = saved.chars
  job.state = 'done'
  job.finishedAt = new Date().toISOString()
}

/** 让 DeepSeek 给这份记录起个能看出主题的标题；失败就保持时间戳标题。 */
export async function autoNameNote(note) {
  try {
    const title = await generateTitle(readNote(note.id).markdown)
    if (!title) return note
    const renamed = renameNote(note.id, title)
    return { ...note, id: renamed.id, path: renamed.path, title: renamed.title }
  } catch {
    return note
  }
}

/** 声纹分流版：整段解码 → 切段取声纹 → 聚类 → 按人分组转写。返回 false 表示没分出来，交给普通切段。 */
async function runDiarizedJob(job, meta) {
  const decoded = await decodeAllSamples(job.filePath, 3600)
  if (!decoded.samples.length) return false
  const groups = await diarize(decoded.samples, { speakers: job.speakers })
  if (!groups.length) return false

  const speakerCount = new Set(groups.map((group) => group.speaker)).size
  job.mode = speakerCount > 1 ? `本地声纹分离（${speakerCount} 人）` : '单通道（只识别到 1 位说话人）'
  job.totalMs = Math.max(1, meta.durationMs)

  let failures = 0
  let lastError = ''
  for (const group of groups) {
    const start = Math.max(0, Math.round(group.start * SAMPLE_RATE))
    const end = Math.min(decoded.samples.length, Math.round(group.end * SAMPLE_RATE))
    if (end - start < SAMPLE_RATE * 0.2) continue
    const durationMs = Math.round(((end - start) / SAMPLE_RATE) * 1000)
    const wav = wavWrap(pcm16FromSamples(decoded.samples.subarray(start, end)))
    try {
      const result = await transcribeWav(wav, { filename: `spk-${group.speaker}-${Math.round(group.start * 1000)}.wav` })
      const text = String(result.text ?? '').trim()
      if (text) {
        job.segments.push({
          label: speakerCount > 1 ? `说话人${group.speaker + 1}` : '说话人',
          startMs: Math.round(group.start * 1000),
          text,
        })
      }
    } catch (error) {
      failures += 1
      lastError = error instanceof Error ? error.message : String(error)
    }
    job.doneMs = Math.min(job.totalMs, job.doneMs + durationMs)
  }

  if (!job.segments.length) {
    throw new Error(failures ? `全部片段转写失败：${lastError}` : '没有识别到语音内容')
  }
  if (failures) {
    job.warning = [job.warning, `${failures} 段转写失败：${lastError}`].filter(Boolean).join('；')
  }
  await finalizeJob(job)
  return true
}

export { NOTES_DIR, TMP_DIR }
