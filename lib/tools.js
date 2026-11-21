/**
 * Agent 侧工具：本机音视频文件转写 + 记录库查询。
 *
 * 转写结果会写成 ~/.dsh/meeting-notes/<id>-<标题>.md，Agent 之后可以用 read
 * 或 meeting_notes_read 再读，也能直接拿来写会议纪要。
 */
import { isAbsolute, resolve } from 'node:path'
import { deleteNote, formatDuration, getJob, listNotes, readNote, renameNote, startFileJob, waitJob } from './meeting.js'

function textTool(name, description, parameters, execute, timeoutMs) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters)) {
    const { required: isRequired, ...field } = spec
    properties[key] = field
    if (isRequired) required.push(key)
  }
  return {
    name,
    description,
    timeoutMs,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      },
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: '会议记录',
        kind: 'other',
        rawInput: String(args?.file_path ?? args?.id ?? '').slice(0, 240),
      }
    },
    async execute(args, exec) {
      try {
        return await execute(args, exec)
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd()
}

function formatClock(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  const m = String(Math.floor(seconds / 60)).padStart(2, '0')
  const s = String(Math.floor(seconds % 60)).padStart(2, '0')
  return `${m}:${s}`
}

/**
 * @param {{ tools: { register(definition: object): () => void } }} ctx
 */
export function registerMeetingTools(ctx) {
  ctx.tools.register(textTool(
    'meeting_transcribe',
    '用 DeepSeek 语音识别把本机音视频文件转成带时间戳的逐字稿，并自动存到 ~/.dsh/meeting-notes。'
      + '支持 wav/mp3/m4a/mp4/webm 等（ffmpeg 解码，超过 120 秒会自动切段）。'
      + '单声道音频会用本地声纹（3D-Speaker embedding + 聚类）自动区分说话人；知道人数时传 speakers 更稳。'
      + 'dual_track=true 时把左右声道当成两位说话人分开转写（只有双轨录音才有意义）。'
      + 'DeepSeek ASR 本身不做说话人识别。',
    {
      file_path: { type: 'string', required: true, description: '本机音视频路径（绝对路径，或相对当前工作区）' },
      dual_track: { type: 'boolean', description: '左右声道分别代表两位说话人时设为 true，默认 true' },
      speakers: { type: 'integer', description: '说话人数；本地声纹聚类用，0 或省略=自动判断' },
      title: { type: 'string', description: '记录标题，默认用文件名' },
      wait: { type: 'boolean', description: '是否等转写跑完再返回，默认 true' },
    },
    async (args, exec) => {
      const raw = String(args.file_path ?? '').trim()
      if (!raw) throw new Error('请提供音视频文件路径')
      const filePath = isAbsolute(raw) ? raw : resolve(sessionCwd(exec), raw)
      const job = await startFileJob({
        filePath,
        dualTrack: args.dual_track !== false,
        speakers: Number(args.speakers) || 0,
        title: typeof args.title === 'string' ? args.title : '',
      })
      const started = `已开始转写：任务 ${job.id}`
      if (args.wait === false) return started
      const finished = await waitJob(job.id, 45 * 60 * 1000)
      if (finished.state === 'failed') {
        return `${started}\n转写失败：${finished.error}`
      }
      const head = [
        `转写完成：${finished.notePath}`,
        `时长 ${formatDuration(finished.durationMs)} · ${finished.mode} · ${finished.segments.length} 段`,
        finished.warning ? `注意：${finished.warning}` : '',
      ].filter(Boolean).join('\n')
      const body = finished.segments
        .slice()
        .sort((a, b) => (a.startMs || 0) - (b.startMs || 0))
        .map((segment) => `[${formatClock(segment.startMs)}] ${segment.label}：${segment.text}`)
        .join('\n')
      if (body.length > 18_000) {
        return `${head}\n（逐字稿共 ${body.length} 字，太长没有全贴；用 read 读上面那个文件，或调 meeting_notes_read）`
      }
      return `${head}\n\n${body}`
    },
    45 * 60 * 1000,
  ))

  ctx.tools.register(textTool(
    'meeting_notes_list',
    '列出最近保存的会议逐字稿记录（标题、时间、时长、段落数、文件路径）。用户问「上次那个会议记录」时先看这里。',
    {
      limit: { type: 'integer', description: '返回条数，默认 10' },
    },
    async (args) => {
      const notes = listNotes(Number(args.limit) || 10)
      if (!notes.length) return '还没有任何会议记录。可以用左侧栏的「会议记录」面板录音，或用 meeting_transcribe 转写本机音视频文件。'
      return notes.map((note) => [
        `- ${note.title}（${note.id}）`,
        `  ${new Date(note.createdAt).toLocaleString('zh-CN')} · 时长 ${formatDuration(note.durationMs)} · ${note.segments} 段 · ${note.chars} 字`,
        `  ${note.path}`,
      ].join('\n')).join('\n')
    },
  ))

  ctx.tools.register(textTool(
    'meeting_notes_rename',
    '给一份会议逐字稿改成能看出主题的中文标题（10 字以内）。会同时改文件名和 markdown 标题。'
      + '用户录完音想「自动命名」时用它。',
    {
      id: { type: 'string', required: true, description: '记录 id（meeting_notes_list 里有）' },
      title: { type: 'string', required: true, description: '新标题，简洁体现会议/对话主题' },
    },
    async (args) => {
      const note = renameNote(args.id, args.title)
      return `已改名：${note.title}\n${note.path}`
    },
  ))

  ctx.tools.register(textTool(
    'meeting_notes_delete',
    '删掉一份会议逐字稿（markdown、原音、索引一起清）。调用前必须向用户确认是哪一份，不要猜。',
    {
      id: { type: 'string', required: true, description: '记录 id（meeting_notes_list 里有）' },
    },
    async (args) => {
      const removed = deleteNote(args.id)
      return `已删除：${removed.title}\n${removed.path}`
    },
  ))

  ctx.tools.register(textTool(
    'meeting_notes_read',
    '读一份会议逐字稿的 markdown 原文（会议记录 id 或文件路径）。',
    {
      id: { type: 'string', required: true, description: '记录 id、标题或 md 文件路径' },
      max_chars: { type: 'integer', description: '最多返回多少字符，默认 20000' },
    },
    async (args) => {
      const note = readNote(args.id)
      const limit = Math.max(2000, Math.min(60_000, Number(args.max_chars) || 20_000))
      const text = note.markdown.length > limit
        ? `${note.markdown.slice(0, limit)}\n\n…（已截断，全文见 ${note.path}）`
        : note.markdown
      return `${text}\n\n文件：${note.path}`
    },
  ))
}
