/**
 * 本地说话人分离（声纹聚类）。
 *
 * 流程：能量切段 → 每段取声纹 embedding（3D-Speaker ERes2Net，512 维）→ 平均连接聚类 → 合并连续同人片段。
 * 运行时复用 Harness 自带的 sherpa-onnx（含 libonnxruntime），不额外装依赖；
 * 模型放在 ~/.dsh/meeting-asr/models，缺失时可按需下载（约 39 MB）。
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MODEL_DIR = join(homedir(), '.dsh', 'meeting-asr', 'models')
export const EMBEDDING_MODEL = join(MODEL_DIR, 'speaker-embedding.onnx')
const EMBEDDING_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'
const EMBEDDING_PROXY = `https://gh-proxy.com/${EMBEDDING_URL}`

const SAMPLE_RATE = 16000
const FRAME_SEC = 0.02
/** 句间静音超过它才断开（同一句话里的换气不算）。 */
const MIN_PAUSE_SEC = 0.3
/** 太短的片段取不出稳定声纹，直接丢弃。 */
const MIN_SEGMENT_SEC = 0.35
/** 聚类相似度阈值：真实录音里同人常在 0.45~0.65，取 0.45 才不会把一场会拆成七八个人。 */
const CLUSTER_THRESHOLD = 0.45
/** 建声纹库只用够长的片段，太短的 embedding 不稳定。 */
const RELIABLE_SEGMENT_SEC = 1.0

let cached = null

/** 复用 Harness 自带的 sherpa-onnx-node。 */
function loadSherpa() {
  if (cached) return cached
  const roots = []
  if (typeof process.resourcesPath === 'string') roots.push(process.resourcesPath)
  roots.push(join(dirname(process.execPath), '..', 'Resources'))
  const tried = []
  for (const root of roots) {
    for (const pkg of [join(root, 'app.asar', 'dsh', 'package.json'), join(root, 'app', 'dsh', 'package.json')]) {
      if (!existsSync(pkg)) continue
      try {
        cached = createRequire(pkg)('sherpa-onnx-node')
        return cached
      } catch (error) {
        tried.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
  throw new Error(`当前运行时找不到 sherpa-onnx${tried.length ? `（${tried[0]}）` : ''}，说话人分离不可用`)
}

export function modelsReady() {
  return existsSync(EMBEDDING_MODEL)
}

export async function ensureModel() {
  if (modelsReady()) return EMBEDDING_MODEL
  mkdirSync(MODEL_DIR, { recursive: true, mode: 0o700 })
  const urls = [EMBEDDING_PROXY, EMBEDDING_URL]
  let lastError = null
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length < 10 * 1024 * 1024) throw new Error(`下载不完整（${buffer.length} 字节）`)
      writeFileSync(EMBEDDING_MODEL, buffer, { mode: 0o600 })
      return EMBEDDING_MODEL
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`说话人模型下载失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

/* ------------------------------------------------------------------ 音频 */

/** 读取 16-bit 单声道 WAV（Electron 下 sherpa 自带的 readWave 会因 external buffer 报错）。 */
export function readWavSamples(path) {
  return parseWavBuffer(readFileSync(path))
}

export function parseWavBuffer(buffer) {
  let offset = 12
  let rate = SAMPLE_RATE
  let bits = 16
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      rate = buffer.readUInt32LE(body + 4)
      bits = buffer.readUInt16LE(body + 14)
    }
    if (id === 'data') {
      data = buffer.subarray(body, body + size)
      break
    }
    offset = body + size + (size % 2)
  }
  if (!data || bits !== 16) throw new Error('只支持 16-bit PCM WAV')
  const samples = new Float32Array(data.length / 2)
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 32768
  return { samples, sampleRate: rate }
}

function rmsOf(samples, start, length) {
  let sum = 0
  const end = Math.min(samples.length, start + length)
  const n = Math.max(1, end - start)
  for (let i = start; i < end; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / n)
}

/**
 * 按能量切出语音片段，返回 [{start, end}]（秒）。
 */
export function detectSpeech(samples, sampleRate = SAMPLE_RATE) {
  const frame = Math.max(80, Math.round(sampleRate * FRAME_SEC))
  const count = Math.floor(samples.length / frame)
  if (!count) return []
  const levels = new Float32Array(count)
  for (let i = 0; i < count; i += 1) levels[i] = rmsOf(samples, i * frame, frame)

  // 噪声底取 10% 分位：会议室底噪高也没关系，阈值跟着走
  const sorted = Array.from(levels).sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0.001
  const threshold = Math.max(0.004, floor * 2.5)

  const minPauseFrames = Math.round(MIN_PAUSE_SEC / FRAME_SEC)
  const segments = []
  let startFrame = -1
  let silenceRun = 0
  for (let i = 0; i < count; i += 1) {
    if (levels[i] >= threshold) {
      if (startFrame < 0) startFrame = i
      silenceRun = 0
    } else if (startFrame >= 0) {
      silenceRun += 1
      if (silenceRun >= minPauseFrames) {
        segments.push({ start: startFrame * frame / sampleRate, end: (i - silenceRun + 1) * frame / sampleRate })
        startFrame = -1
        silenceRun = 0
      }
    }
  }
  if (startFrame >= 0) segments.push({ start: startFrame * frame / sampleRate, end: count * frame / sampleRate })
  return segments.filter((segment) => segment.end - segment.start >= MIN_SEGMENT_SEC)
}

/* ---------------------------------------------------------------- 声纹 */

function embedSegment(extractor, samples, sampleRate, start, end) {
  const pad = Math.round(sampleRate * 0.1)
  const from = Math.max(0, Math.round(start * sampleRate) - pad)
  const to = Math.min(samples.length, Math.round(end * sampleRate) + pad)
  const slice = samples.subarray(from, to)
  const stream = extractor.createStream()
  stream.acceptWaveform({ sampleRate, samples: slice })
  stream.inputFinished()
  // Electron 不允许 external buffer，第二个参数必须传 false
  const vector = Float32Array.from(extractor.compute(stream, false))
  let norm = 0
  for (const value of vector) norm += value * value
  const scale = Math.sqrt(norm) || 1
  for (let i = 0; i < vector.length; i += 1) vector[i] /= scale
  return vector
}

function cosine(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i]
  return sum
}

/**
 * 平均连接层次聚类（余弦相似度）。threshold 越大越容易合并。
 * @param {Float32Array[]} vectors
 * @param {{ threshold?: number, maxSpeakers?: number }} [options]
 */
export function clusterEmbeddings(vectors, options = {}) {
  const threshold = options.threshold ?? CLUSTER_THRESHOLD
  const maxSpeakers = Math.max(1, options.maxSpeakers ?? 8)
  let groups = vectors.map((vector, index) => ({ members: [index], centroid: vector }))
  if (!groups.length) return []

  const similarity = (a, b) => cosine(a.centroid, b.centroid)
  while (groups.length > 1) {
    let best = -Infinity
    let bestPair = null
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const sim = similarity(groups[i], groups[j])
        if (sim > best) {
          best = sim
          bestPair = [i, j]
        }
      }
    }
    if (!bestPair) break
    if (best < threshold && groups.length <= maxSpeakers) break
    const [i, j] = bestPair
    const merged = {
      members: [...groups[i].members, ...groups[j].members],
      centroid: averageVector(groups[i], groups[j]),
    }
    groups = groups.filter((_, index) => index !== i && index !== j)
    groups.push(merged)
  }
  // 按首次出现顺序编号，保证跨片段稳定
  groups.sort((a, b) => Math.min(...a.members) - Math.min(...b.members))
  const labels = new Array(vectors.length).fill(0)
  groups.forEach((group, groupIndex) => {
    for (const member of group.members) labels[member] = groupIndex
  })
  return labels
}

function averageVector(a, b) {
  const total = a.members.length + b.members.length
  const out = new Float32Array(a.centroid.length)
  let norm = 0
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (a.centroid[i] * a.members.length + b.centroid[i] * b.members.length) / total
    norm += out[i] * out[i]
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i += 1) out[i] /= norm
  return out
}

/**
 * 把连续同人的片段并成一段（中间停顿 < 1.2 秒），过长再切开。
 * @returns {{start: number, end: number, speaker: number}[]}
 */
function groupBySpeaker(segments, labels) {
  const runs = []
  let current = null
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    const speaker = labels[i]
    if (current && current.speaker === speaker && segment.start - current.end < 1.2) {
      current.end = segment.end
      continue
    }
    if (current) runs.push(current)
    current = { start: segment.start, end: segment.end, speaker }
  }
  if (current) runs.push(current)

  // 按首次出现顺序重新编号，读起来才是「说话人1、说话人2…」
  const order = new Map()
  for (const run of runs) {
    if (!order.has(run.speaker)) order.set(run.speaker, order.size)
  }

  // 单段太长会超出 ASR 上限，按 28 秒切开
  const out = []
  for (const run of runs) {
    const speaker = order.get(run.speaker) ?? 0
    let start = run.start
    while (run.end - start > 28) {
      out.push({ start, end: start + 28, speaker })
      start += 28
    }
    out.push({ start, end: run.end, speaker })
  }
  return out
}

/* -------------------------------------------------- 实时录音的在线声纹 */

let extractorInstance = null

function embeddingExtractor() {
  if (extractorInstance) return extractorInstance
  const sherpa = loadSherpa()
  extractorInstance = new sherpa.SpeakerEmbeddingExtractor({
    model: EMBEDDING_MODEL,
    numThreads: 2,
    debug: false,
    provider: 'cpu',
  })
  return extractorInstance
}

/** 单段音频的归一化声纹向量。 */
export function embedSamples(samples, sampleRate = SAMPLE_RATE) {
  return embedSegment(embeddingExtractor(), samples, sampleRate, 0, samples.length / sampleRate)
}

/** 在线聚类：每个会话维护一组说话人质心，逐段判断「这是谁」。 */
class SpeakerTracker {
  constructor(options = {}) {
    this.threshold = options.threshold ?? 0.50
    this.maxSpeakers = Math.max(2, options.maxSpeakers ?? 6)
    this.centroids = []
  }

  assign(vector, durationSec) {
    if (!this.centroids.length) {
      if (durationSec < 1.2) return null
      this.centroids.push({ vector: Float32Array.from(vector), hits: 1 })
      return 0
    }
    let best = -1
    let bestIndex = -1
    this.centroids.forEach((centroid, index) => {
      const score = cosine(centroid.vector, vector)
      if (score > best) {
        best = score
        bestIndex = index
      }
    })
    if (best >= this.threshold) {
      const centroid = this.centroids[bestIndex]
      let norm = 0
      for (let i = 0; i < centroid.vector.length; i += 1) {
        centroid.vector[i] = centroid.vector[i] * 0.75 + vector[i] * 0.25
        norm += centroid.vector[i] * centroid.vector[i]
      }
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < centroid.vector.length; i += 1) centroid.vector[i] /= norm
      centroid.hits += 1
      return bestIndex
    }
    // 明显不是同一个人（实测不同人 0.45~0.55、同人 0.8+），而且这段够长，才新增一位
    if (best < 0.45 && durationSec >= 1.5 && this.centroids.length < this.maxSpeakers) {
      this.centroids.push({ vector: Float32Array.from(vector), hits: 1 })
      return this.centroids.length - 1
    }
    return best >= 0.40 ? bestIndex : null
  }
}

const trackers = new Map()

/**
 * 实时录音用：给一段音频判说话人。sessionId 用来累积同一场录音的声纹库。
 * @returns {{ speaker: number | null, speakers: number }}
 */
export function trackSpeaker(sessionId, samples, sampleRate, durationSec) {
  const key = String(sessionId || 'default')
  let tracker = trackers.get(key)
  if (!tracker) {
    tracker = new SpeakerTracker()
    trackers.set(key, tracker)
  }
  const vector = embedSamples(samples, sampleRate)
  const speaker = tracker.assign(vector, durationSec)
  return { speaker, speakers: tracker.centroids.length }
}

export function resetSpeakerSession(sessionId) {
  trackers.delete(String(sessionId || 'default'))
}

/**
 * 对 16k 单声道采样做说话人分离。
 * @param {Float32Array} samples
 * @param {{ speakers?: number, sampleRate?: number }} [options]
 * @returns {{ start: number, end: number, speaker: number }[]} 秒
 */
export async function diarize(samples, options = {}) {
  await ensureModel()
  const sherpa = loadSherpa()
  const sampleRate = options.sampleRate ?? SAMPLE_RATE
  const segments = detectSpeech(samples, sampleRate)
  if (!segments.length) return []

  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: EMBEDDING_MODEL,
    numThreads: 2,
    debug: false,
    provider: 'cpu',
  })
  const vectors = segments.map((segment) => embedSegment(extractor, samples, sampleRate, segment.start, segment.end))

  // 只用够长的片段聚类；一句话里的「嗯」「对」这种短段 embedding 很飘，单独归类
  const reliable = []
  const shaky = []
  segments.forEach((segment, index) => {
    if (segment.end - segment.start >= RELIABLE_SEGMENT_SEC) reliable.push(index)
    else shaky.push(index)
  })
  const speakers = Number(options.speakers) > 0 ? Number(options.speakers) : 6
  const labels = new Array(segments.length).fill(0)
  if (reliable.length) {
    const clusterLabels = clusterEmbeddings(reliable.map((index) => vectors[index]), {
      threshold: options.threshold ?? CLUSTER_THRESHOLD,
      maxSpeakers: speakers,
    })
    const centroids = []
    reliable.forEach((index, position) => {
      labels[index] = clusterLabels[position]
      const label = clusterLabels[position]
      centroids[label] = centroids[label] || new Float32Array(vectors[index].length)
      const centroid = centroids[label]
      for (let i = 0; i < centroid.length; i += 1) centroid[i] += vectors[index][i]
    })
    centroids.forEach((centroid) => {
      let norm = 0
      for (const value of centroid) norm += value * value
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < centroid.length; i += 1) centroid[i] /= norm
    })
    // 短段归到最像的人，实在不像就跟着前一段走
    shaky.forEach((index) => {
      let best = -1
      let bestLabel = -1
      centroids.forEach((centroid, label) => {
        if (!centroid) return
        const score = cosine(centroid, vectors[index])
        if (score > best) {
          best = score
          bestLabel = label
        }
      })
      if (bestLabel >= 0) labels[index] = bestLabel
      else if (index > 0) labels[index] = labels[index - 1]
    })
  } else {
    // 整段都是碎片：按出现顺序合并成一位
    labels.fill(0)
  }
  return groupBySpeaker(segments, labels)
}
