/**
 * 会议记录面板的 Host 端 HTTP 接口（和 Web 页面同源，key 不出 Host 进程）。
 *
 *   GET  /dsh-meeting/health             key 状态 + 记录数 + baseUrl
 *   POST /dsh-meeting/key                保存 DeepSeek API Key 到 DSH 凭证
 *   POST /dsh-meeting/settings           改 baseUrl
 *   POST /dsh-meeting/probe              测试 ASR 通不通（发 0.6 秒静音）
 *   POST /dsh-meeting/asr                单段音频（base64 WAV）转写，实时录音用
 *   POST /dsh-meeting/speaker            单段音频判说话人（在线声纹聚类）
 *   POST /dsh-meeting/polish             识别后校正（错别字 / 说话人，需在设置里开）
 *   POST /dsh-meeting/polish-pair        相邻两句：句子被切断就合并、连贯但换了人重新判说话人
 *   GET  /dsh-meeting/scenes             场景预设（访谈 / 商务谈判 / 面试）
 *   POST /dsh-meeting/coach              按场景给下一步建议
 *   POST /dsh-meeting/speaker/reset      清掉一场录音的声纹库
 *   POST /dsh-meeting/audio/append       实时录音的原音分片（16k 单声道 PCM）落盘
 *   POST /dsh-meeting/audio/finish       把临时 PCM 收成 WAV，返回路径
 *   POST /dsh-meeting/audio/discard      丢弃本次原音
 *   POST /dsh-meeting/notes              保存一份逐字稿（客户端拼好的段落）
 *   GET  /dsh-meeting/notes              最近记录
 *   GET  /dsh-meeting/notes/:id          读一份记录
 *   POST /dsh-meeting/upload             原始字节上传（x-filename），返回落盘路径
 *   POST /dsh-meeting/file               对落盘文件起转写任务
 *   GET  /dsh-meeting/file/:id           任务进度 / 结果
 */
import { appendFileSync, createWriteStream, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import {
  AUDIO_DIR,
  NOTES_DIR,
  TMP_DIR,
  describeApiKey,
  ensureDirs,
  readPublicConfig,
  setApiKey,
  writePublicConfig,
} from './config.js'
import { AsrError, probeAsr, transcribeWav } from './asr.js'
import { autoNameNote, deleteNote, getJob, listNotes, readNote, renameNote, saveNote, startFileJob } from './meeting.js'
import { modelsReady, parseWavBuffer, trackSpeaker, resetSpeakerSession } from './diarize.js'
import { polishPair, polishSegment } from './polish.js'
import { SCENES, coachHint, readCoachConfig } from './coach.js'

class HttpError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function requestUrl(request) {
  return new URL(request.url ?? '/', `http://${request.headers.host || '127.0.0.1'}`)
}

async function readBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new HttpError('请求体过大', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(request, limit = 12 * 1024 * 1024) {
  const body = await readBody(request, limit)
  if (!body.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpError('请求体不是合法 JSON')
  }
}

function fail(response, error) {
  const status = error instanceof HttpError || error instanceof AsrError
    ? (error.status || 500)
    : 500
  sendJson(response, status, { error: error instanceof Error ? error.message : String(error) })
}

/**
 * @param {{ webServer: { register(route: object): () => void } }} host
 * @returns {() => void}
 */
export function mountMeetingRoutes(host) {
  return host.webServer.register({
    kind: 'prefix',
    path: '/dsh-meeting',
    handler: async (request, response) => {
      try {
        await handle(request, response)
      } catch (error) {
        if (!response.headersSent) fail(response, error)
      }
    },
  })
}

async function handle(request, response) {
  const url = requestUrl(request)
  const path = url.pathname.replace(/\/+$/u, '') || '/'
  const method = request.method ?? 'GET'

  if (path === '/dsh-meeting/health' && method === 'GET') {
    const notes = listNotes(500)
    sendJson(response, 200, {
      ok: true,
      key: await describeApiKey(),
      config: readPublicConfig(),
      notes: notes.length,
      notesDir: NOTES_DIR,
      speakerModel: modelsReady(),
      scene: readCoachConfig(),
      limits: { maxSeconds: 120, maxBytes: 8 * 1024 * 1024, pricePerHour: 0.39 },
    })
    return
  }

  if (path === '/dsh-meeting/key' && method === 'POST') {
    const body = await readJson(request, 64 * 1024)
    const key = await setApiKey(typeof body.token === 'string' ? body.token : '')
    sendJson(response, 200, { ok: true, key })
    return
  }

  if (path === '/dsh-meeting/settings' && method === 'POST') {
    const body = await readJson(request, 64 * 1024)
    sendJson(response, 200, {
      ok: true,
      config: writePublicConfig({
        baseUrl: body.baseUrl,
        polishText: body.polishText,
        polishSpeaker: body.polishSpeaker,
        autoName: body.autoName,
      }),
    })
    return
  }

  if (path === '/dsh-meeting/probe' && method === 'POST') {
    sendJson(response, 200, await probeAsr())
    return
  }

  if (path === '/dsh-meeting/asr' && method === 'POST') {
    const body = await readJson(request, 12 * 1024 * 1024)
    const audio = typeof body.audio === 'string' ? body.audio.replace(/^data:[^;]+;base64,/u, '') : ''
    if (!audio) throw new HttpError('缺少 audio（16-bit PCM WAV 的 base64）')
    const bytes = Buffer.from(audio, 'base64')
    if (bytes.length > 8 * 1024 * 1024) throw new AsrError('音频片段超过 8 MiB，请缩短片段', 413)
    const started = Date.now()
    const result = await transcribeWav(bytes, { filename: 'live-chunk.wav' })
    sendJson(response, 200, {
      ok: true,
      text: result.text,
      durationMs: result.durationMs,
      requestId: result.requestId,
      elapsedMs: Date.now() - started,
    })
    return
  }

  if (path === '/dsh-meeting/audio/append' && method === 'POST') {
    const body = await readJson(request, 24 * 1024 * 1024)
    const sessionId = safeSessionId(body.sessionId)
    const pcm = typeof body.pcm === 'string' ? Buffer.from(body.pcm, 'base64') : Buffer.alloc(0)
    if (!pcm.length) throw new HttpError('缺少 pcm 数据')
    ensureDirs()
    const target = join(TMP_DIR, `rec-${sessionId}.pcm`)
    if (existsSync(target) && statSync(target).size > 500 * 1024 * 1024) throw new HttpError('原音超过 500 MB，停止保存', 413)
    appendFileSync(target, pcm)
    sendJson(response, 200, { ok: true, bytes: statSync(target).size })
    return
  }

  if (path === '/dsh-meeting/audio/finish' && method === 'POST') {
    const body = await readJson(request, 64 * 1024)
    const sessionId = safeSessionId(body.sessionId)
    const source = join(TMP_DIR, `rec-${sessionId}.pcm`)
    if (!existsSync(source)) throw new HttpError('没有找到这段录音的原音', 404)
    ensureDirs()
    const pcm = readFileSync(source)
    const target = join(AUDIO_DIR, `${sessionId}.wav`)
    writeFileSync(target, wrapPcmAsWav(pcm), { mode: 0o600 })
    try { unlinkSync(source) } catch { /* ignore */ }
    sendJson(response, 200, {
      ok: true,
      path: target,
      bytes: pcm.length,
      durationMs: Math.round((pcm.length / 2 / 16000) * 1000),
    })
    return
  }

  if (path === '/dsh-meeting/audio/discard' && method === 'POST') {
    const body = await readJson(request, 64 * 1024)
    const sessionId = safeSessionId(body.sessionId)
    try { unlinkSync(join(TMP_DIR, `rec-${sessionId}.pcm`)) } catch { /* ignore */ }
    sendJson(response, 200, { ok: true })
    return
  }

  if (path === '/dsh-meeting/polish' && method === 'POST') {
    const body = await readJson(request, 512 * 1024)
    const text = typeof body.text === 'string' ? body.text : ''
    if (!text.trim()) {
      sendJson(response, 200, { ok: true })
      return
    }
    try {
      const result = await polishSegment({
        text,
        label: typeof body.label === 'string' ? body.label : '',
        context: Array.isArray(body.context) ? body.context : [],
        labels: Array.isArray(body.labels) ? body.labels : [],
        allowSpeaker: body.allowSpeaker === true,
        debug: body.debug === true,
      })
      sendJson(response, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(response, 200, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (path === '/dsh-meeting/scenes' && method === 'GET') {
    sendJson(response, 200, { ok: true, scenes: SCENES, current: readCoachConfig() })
    return
  }

  if (path === '/dsh-meeting/coach' && method === 'POST') {
    const body = await readJson(request, 1024 * 1024)
    try {
      const result = await coachHint({
        segments: Array.isArray(body.segments) ? body.segments : [],
        key: typeof body.key === 'string' ? body.key : '',
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
      })
      sendJson(response, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(response, 200, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (path === '/dsh-meeting/polish-pair' && method === 'POST') {
    const body = await readJson(request, 512 * 1024)
    try {
      const result = await polishPair({
        prev: body.prev ?? {},
        next: body.next ?? {},
        context: Array.isArray(body.context) ? body.context : [],
        labels: Array.isArray(body.labels) ? body.labels : [],
        allowSpeaker: body.allowSpeaker === true,
      })
      sendJson(response, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(response, 200, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (path === '/dsh-meeting/speaker' && method === 'POST') {
    const body = await readJson(request, 12 * 1024 * 1024)
    const audio = typeof body.audio === 'string' ? body.audio.replace(/^data:[^;]+;base64,/u, '') : ''
    if (!audio) throw new HttpError('缺少 audio')
    const bytes = Buffer.from(audio, 'base64')
    if (!modelsReady()) {
      sendJson(response, 200, { ok: true, speaker: null, speakers: 0, reason: '模型未就绪' })
      return
    }
    const wav = parseWavBuffer(bytes)
    const result = trackSpeaker(body.sessionId, wav.samples, wav.sampleRate, wav.samples.length / wav.sampleRate)
    sendJson(response, 200, { ok: true, ...result })
    return
  }

  if (path === '/dsh-meeting/speaker/reset' && method === 'POST') {
    const body = await readJson(request, 64 * 1024)
    resetSpeakerSession(body.sessionId)
    sendJson(response, 200, { ok: true })
    return
  }

  if (path === '/dsh-meeting/notes/delete' && method === 'POST') {
    const body = await readJson(request, 64 * 1024)
    const removed = deleteNote(body.id)
    sendJson(response, 200, { ok: true, id: removed.id, title: removed.title, audioPath: removed.audioPath || '' })
    return
  }

  if (path === '/dsh-meeting/notes' && method === 'POST') {
    const body = await readJson(request, 24 * 1024 * 1024)
    const segments = Array.isArray(body.segments) ? body.segments : []
    if (!segments.length) throw new HttpError('没有可保存的逐字稿段落')
    const createdAt = body.startedAt ? new Date(body.startedAt) : new Date()
    const saved = saveNote({
      title: typeof body.title === 'string' ? body.title : '',
      createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
      durationMs: Number(body.durationMs) || 0,
      segments,
      mode: typeof body.mode === 'string' ? body.mode : '',
      source: typeof body.source === 'string' ? body.source : '实时录音',
      costCny: typeof body.costCny === 'number' ? body.costCny : undefined,
    })
    const named = await autoNameNote(saved)
    sendJson(response, 200, {
      ok: true,
      id: named.id,
      title: named.title,
      path: named.path,
      chars: saved.chars,
      segments: saved.segments,
      markdown: saved.markdown,
    })
    return
  }

  if (path === '/dsh-meeting/notes' && method === 'GET') {
    sendJson(response, 200, { ok: true, notes: listNotes(Number(url.searchParams.get('limit')) || 30) })
    return
  }

  const noteMatch = /^\/dsh-meeting\/notes\/([^/]+)$/u.exec(path)
  if (noteMatch && method === 'GET') {
    sendJson(response, 200, { ok: true, ...readNote(decodeURIComponent(noteMatch[1])) })
    return
  }

  if (path === '/dsh-meeting/upload' && method === 'POST') {
    ensureDirs()
    const filename = sanitizeFilename(
      typeof request.headers['x-filename'] === 'string' ? decodeURIComponent(request.headers['x-filename']) : 'meeting-audio',
    )
    const target = join(TMP_DIR, `${Date.now()}-${randomUUID().slice(0, 6)}-${filename}`)
    let received = 0
    const counter = async function* count(source) {
      for await (const chunk of source) {
        received += chunk.length
        if (received > 2 * 1024 * 1024 * 1024) throw new HttpError('文件大于 2 GB', 413)
        yield chunk
      }
    }
    try {
      await pipeline(request, counter, createWriteStream(target))
    } catch (error) {
      try { unlinkSync(target) } catch { /* ignore */ }
      throw error instanceof HttpError ? error : new HttpError(`上传失败：${error instanceof Error ? error.message : String(error)}`, 500)
    }
    if (!received) throw new HttpError('没有收到文件内容')
    sendJson(response, 200, { ok: true, path: target, name: filename, bytes: received })
    return
  }

  if (path === '/dsh-meeting/file' && method === 'POST') {
    const body = await readJson(request, 64 * 1024)
    const job = await startFileJob({
      filePath: typeof body.path === 'string' ? body.path : '',
      dualTrack: Boolean(body.dualTrack),
      diarize: body.diarize !== false,
      speakers: Number(body.speakers) || 0,
      title: typeof body.title === 'string' ? body.title : '',
    })
    sendJson(response, 200, { ok: true, job })
    return
  }

  const jobMatch = /^\/dsh-meeting\/file\/([^/]+)$/u.exec(path)
  if (jobMatch && method === 'GET') {
    const job = getJob(decodeURIComponent(jobMatch[1]))
    if (!job) throw new HttpError('找不到这个转写任务', 404)
    sendJson(response, 200, { ok: true, job })
    return
  }

  if (method !== 'GET' && method !== 'POST') {
    response.writeHead(405, { allow: 'GET, POST' })
    response.end()
    return
  }
  sendJson(response, 404, { error: 'not found' })
}

function sanitizeFilename(name) {
  const base = basename(String(name || 'audio')).replace(/[^\w.\-\u4e00-\u9fa5]+/gu, '_')
  return base.slice(-80) || 'audio'
}

function safeSessionId(value) {
  const id = String(value ?? '').replace(/[^\w.-]+/gu, '')
  if (!id) throw new HttpError('缺少 sessionId')
  return id.slice(0, 64)
}

/** 裸 16-bit 单声道 PCM（16k）包成 WAV。 */
function wrapPcmAsWav(pcm, sampleRate = 16000) {
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
