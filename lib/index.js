/**
 * dsh-meeting-asr —— Host 半。
 *
 * 左边栏一个「会议记录」入口：实时录音 / 文件转写 / 记录库。
 * 识别走 DeepSeek 语音识别（/v1/tools/asr），key 留在 Host 进程；
 * 逐字稿存 ~/.dsh/meeting-notes，Agent 用 meeting_* 工具直接读。
 */
import { bindCredentials, PRIMARY_KEY_REF } from './config.js'
import { listNotes } from './meeting.js'
import { mountMeetingRoutes } from './routes.js'
import { registerMeetingTools } from './tools.js'

export const name = 'dsh-meeting-asr'
export const inject = ['tools', 'systemPrompt', 'webServer']

function guidance() {
  const lines = [
    '本会话已加载会议记录插件 dsh-meeting-asr（DeepSeek 语音识别 / ASR）。',
    '用户要转写会议录音、访谈、音视频文件时调用 meeting_transcribe（传本机路径）；不要用 bash + ffmpeg 自己切片，插件会按 60 秒一段自动切。',
    '找历史逐字稿用 meeting_notes_list，读原文用 meeting_notes_read（也可以用 read 直接读 ~/.dsh/meeting-notes/*.md）。',
    '说话人怎么分：单声道音频会用本地声纹（3D-Speaker embedding + 聚类）自动区分「说话人1/2/…」，知道人数时给 meeting_transcribe 传 speakers 更稳；双通道录音（两个麦克风 / 麦克风 + 系统声音）按左右轨分人。DeepSeek ASR 本身不做说话人识别。',
    '单请求上限 120 秒 / 8 MiB，不支持流式；按官网 ¥0.39/小时 的限时价计费。',
    `密钥优先读 DSH 凭证 ${PRIMARY_KEY_REF}，兜底 DEEPSEEK_API_KEY。未配置时请用户去左侧栏「会议记录」面板填写，不要读取凭证文件、不要用 curl 代替。`,
    '用户在面板里录完可以直接「让 DSH 分析」，那一轮通常要摘要、决议、待办（负责人 / 时间）、风险与未决问题。',
  ]
  try {
    const notes = listNotes(500)
    if (notes.length) {
      const latest = notes[0]
      lines.push(`当前记录库有 ${notes.length} 份逐字稿，最近一份：${latest.title}（${latest.path}，${latest.segments} 段）。`)
    } else {
      lines.push('当前记录库还是空的：面板录音会自动存，文件转写用 meeting_transcribe。')
    }
  } catch {
    /* 记录库读失败不影响对话 */
  }
  return lines.join('\n')
}

export function apply(ctx) {
  ctx.inject(['credentials'], (credCtx) => {
    bindCredentials(credCtx.credentials)
  })
  ctx.systemPrompt.section({
    name: 'dsh-meeting-asr:guidance',
    order: 167,
    text: () => guidance(),
  })
  registerMeetingTools(ctx)
  ctx.effect(() => mountMeetingRoutes(ctx), 'dsh-meeting-asr: http routes')
}
