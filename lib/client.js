window.__ModuleLoader__.load({
  id: 'dsh-meeting-asr',
  factory: (require) => {
    const React = require('react')
    const e = React.createElement
    const { useEffect, useRef, useState } = React
    let createPortal = null
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = null
    }

    const SEARCH_LABELS = new Set(['搜索会话', 'Search sessions'])
    const TARGET_RATE = 16000
    const PRICE_PER_HOUR = 0.39
    /** 单段最长秒数：太长会拖慢出字，太短容易把词切断。 */
    const HARD_CAP_SEC = 30
    /** 至少攒够这么久才允许按停顿切段。 */
    const MIN_FLUSH_SEC = 3.5
    /** 停顿超过这么久就切段（配合自适应噪声底，嘈杂环境也能命中）。 */
    const SILENCE_FLUSH_MS = 450
    /** 原音每攒够这么久就送 Host 落盘一次。 */
    const RECORD_FLUSH_SEC = 15

    const CSS = `
.dsh-mt-toggle, .dsh-mt-panel, .dsh-mt-panel * { box-sizing: border-box; }
.dsh-mt-toggle {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-secondary, #6b6760); cursor: pointer;
}
.dsh-mt-toggle:hover, .dsh-mt-toggle[data-open="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dsh-mt-toggle svg { display: block; }
.dsh-mt-anchor[data-rail="true"] .dsh-mt-toggle { width: 36px; height: 36px; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-mt-anchor[data-rail="true"] { margin-bottom: 12px; }

.dsh-mt-panel {
  position: fixed; z-index: 80; top: 56px; right: 16px; bottom: 16px;
  width: min(420px, calc(100vw - 32px));
  display: flex; flex-direction: column;
  border: 1px solid var(--dsw-alias-border-l2, #e2e0d8);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  box-shadow: 0 12px 40px rgba(20, 20, 18, .14);
  color: var(--dsw-alias-label-primary, #1a1a1a);
  font: 13px/20px system-ui, -apple-system, sans-serif;
}
.dsh-mt-head {
  flex: none; display: flex; align-items: center; gap: 8px;
  height: 48px; padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e2e0d8);
}
.dsh-mt-head h1 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; }
.dsh-mt-sub { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8a8680); }
.dsh-mt-icon {
  width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-tertiary, #8a8680); cursor: pointer; font-size: 16px; line-height: 1;
}
.dsh-mt-icon:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-mt-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 16px; }

.dsh-mt-opts { display: flex; gap: 18px; margin-bottom: 16px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e2e0d8); }
.dsh-mt-opt {
  position: relative; height: 32px; padding: 0 0 10px; border: 0; background: transparent;
  color: var(--dsw-alias-label-tertiary, #8a8680); font: 500 13px/1 system-ui, sans-serif; cursor: pointer;
}
.dsh-mt-opt:hover { color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-mt-opt[data-on="true"] { color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-mt-opt[data-on="true"]::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: var(--dsw-alias-label-primary, #1a1a1a); border-radius: 2px;
}

.dsh-mt-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.dsh-mt-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6760); }
.dsh-mt-input, .dsh-mt-select, .dsh-mt-area {
  width: 100%; border: 1px solid var(--dsw-alias-border-l2, #e2e0d8); border-radius: 8px;
  background: transparent; color: inherit; font: 13px/18px system-ui, sans-serif; outline: none;
}
.dsh-mt-input, .dsh-mt-select { height: 34px; padding: 0 10px; }
.dsh-mt-input[type="file"] { height: auto; padding: 6px 8px; font-size: 12px; }
.dsh-mt-area { min-height: 56px; padding: 8px 10px; resize: vertical; }
.dsh-mt-input:focus, .dsh-mt-select:focus, .dsh-mt-area:focus { border-color: var(--dsw-alias-label-tertiary, #8a8680); }
.dsh-mt-row { display: flex; gap: 8px; }
.dsh-mt-row > .dsh-mt-field { flex: 1; min-width: 0; }
.dsh-mt-hint { margin: 0 0 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8680); }
.dsh-mt-err { margin: 0 0 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-danger, #b42318); }

.dsh-mt-rec { display: flex; align-items: center; gap: 14px; }
.dsh-mt-rec-btn {
  position: relative; flex: none; width: 48px; height: 48px; padding: 0;
  border: 1px solid var(--dsw-alias-border-l2, #e2e0d8); border-radius: 50%;
  background: transparent; cursor: pointer; display: grid; place-items: center;
}
.dsh-mt-rec-btn:hover { border-color: #e5484d; }
.dsh-mt-rec-btn:disabled { opacity: .4; cursor: default; }
.dsh-mt-rec-dot { width: 16px; height: 16px; border-radius: 50%; background: #e5484d; transition: border-radius .15s ease, transform .15s ease; }
.dsh-mt-rec-btn[data-on="true"] { border-color: #e5484d; }
.dsh-mt-rec-btn[data-on="true"] .dsh-mt-rec-dot { border-radius: 3px; transform: scale(.9); animation: dsh-mt-pulse 1.6s ease-in-out infinite; }
@keyframes dsh-mt-pulse { 50% { opacity: .35; } }
.dsh-mt-rec-info { min-width: 0; }
.dsh-mt-rec-time {
  font: 500 26px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums; letter-spacing: -.01em;
}
.dsh-mt-rec-sub {
  margin-top: 3px; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8680);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-mt-level { margin: 12px 0 14px; height: 2px; border-radius: 2px; background: var(--dsw-alias-bg-base, #f0eee8); overflow: hidden; }
.dsh-mt-level > i { display: block; height: 100%; background: var(--dsw-alias-label-tertiary, #8a8680); transition: width .2s linear; }
.dsh-mt-meta { margin-bottom: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8680); font-variant-numeric: tabular-nums; }

.dsh-mt-segs {
  display: flex; flex-direction: column;
  max-height: 46vh; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin;
}
.dsh-mt-seg { display: grid; grid-template-columns: 40px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid var(--dsw-alias-border-l2, #e2e0d8); }
.dsh-mt-seg:first-child { border-top: 0; }
.dsh-mt-seg-time { font: 11px/20px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--dsw-alias-label-tertiary, #8a8680); }
.dsh-mt-seg-fix {
  margin-left: 2px; font-size: 11px; line-height: 1;
  color: #1a7f37; cursor: help;
}
.dsh-mt-seg-text { font-size: 13.5px; line-height: 20px; word-break: break-word; }
.dsh-mt-seg-label { color: var(--dsw-alias-label-tertiary, #8a8680); font-size: 11px; }
.dsh-mt-empty { padding: 24px 0; text-align: center; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8680); }

.dsh-mt-list { list-style: none; margin: 0; padding: 0; }
.dsh-mt-item {
  position: relative; padding: 10px 24px 10px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e2e0d8);
}
.dsh-mt-item:last-child { border-bottom: 0; }
.dsh-mt-item-main { cursor: pointer; }
.dsh-mt-item-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-mt-item-del {
  position: absolute; top: 50%; right: 0; transform: translateY(-50%);
  display: grid; place-items: center; width: 18px; height: 18px; padding: 0;
  border: 0; border-radius: 4px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-tertiary, #8a8680);
  font-size: 14px; line-height: 1; opacity: 0; transition: opacity 0.12s ease, color 0.12s ease;
}
.dsh-mt-item:hover .dsh-mt-item-del, .dsh-mt-item-del[data-confirm="true"] { opacity: 1; }
.dsh-mt-item-del:hover { color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-mt-item-del[data-confirm="true"] { color: var(--dsw-alias-state-danger, #c0392b); }
.dsh-mt-item-meta { margin-top: 2px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8680); font-variant-numeric: tabular-nums; }

.dsh-mt-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 10px; }
.dsh-mt-text-btn {
  height: auto; padding: 0; border: 0; background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6760); font: 500 12px/20px system-ui, sans-serif; cursor: pointer;
}
.dsh-mt-text-btn:hover { color: var(--dsw-alias-label-primary, #1a1a1a); }
.dsh-mt-text-btn[data-primary="true"] { color: #1f5fff; }
.dsh-mt-go {
  height: 34px; padding: 0 14px; border: 0; border-radius: 8px; cursor: pointer;
  background: var(--dsw-alias-label-primary, #1a1a1a); color: var(--dsw-alias-bg-layer-2, #fff);
  font: 500 13px/1 system-ui, sans-serif;
}
.dsh-mt-go:disabled { opacity: .35; cursor: default; }
.dsh-mt-progress { margin: 10px 0; height: 3px; border-radius: 2px; background: var(--dsw-alias-bg-base, #f0eee8); overflow: hidden; }
.dsh-mt-progress > i { display: block; height: 100%; background: #1f5fff; transition: width .3s ease; }

.dsh-mt-card { list-style: none; border: 1px solid var(--dsw-alias-border-l2, #e2e0d8); border-radius: 10px; }
.dsh-mt-card-head { padding: 14px 16px; }
.dsh-mt-card-name { font-size: 14px; font-weight: 600; }
.dsh-mt-card-desc { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8680); }
.dsh-mt-badge { margin-left: 8px; font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #8a8680); }
`

    let lastInputActions = null
    let panelOpen = false
    const panelListeners = new Set()
    function setPanelOpen(next) {
      panelOpen = typeof next === 'function' ? next(panelOpen) : next
      panelListeners.forEach((fn) => fn(panelOpen))
    }
    function usePanelOpen() {
      const [open, setOpen] = useState(panelOpen)
      useEffect(() => {
        panelListeners.add(setOpen)
        return () => { panelListeners.delete(setOpen) }
      }, [])
      return [open, setPanelOpen]
    }

    // 样式版本号：HMR 换模块后页面里的 <style> 还在，靠它判断要不要重写，
    // 否则会出现「新结构 + 旧样式」的半截界面。
    /** 版本号由 CSS 内容算出来：改一个字符就变，不用再手改版本号。 */
    function cssHash(text) {
      let hash = 5381
      for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
      return hash.toString(36)
    }
    const CSS_VERSION = cssHash(CSS)

    function ensureCss() {
      let style = document.getElementById('dsh-meeting-style')
      if (!style) {
        style = document.createElement('style')
        style.id = 'dsh-meeting-style'
        document.head.appendChild(style)
      }
      if (style.dataset.v === CSS_VERSION) return
      style.textContent = CSS
      style.dataset.v = CSS_VERSION
    }

    function findSearchButton() {
      return [...document.querySelectorAll('button')].find((btn) => SEARCH_LABELS.has(btn.getAttribute('aria-label') || ''))
    }

    function ensureAnchor() {
      let host = document.getElementById('dsh-meeting-anchor')
      if (!host) {
        host = document.createElement('div')
        host.id = 'dsh-meeting-anchor'
        host.className = 'dsh-mt-anchor'
      }
      const searchBtn = findSearchButton()
      if (!searchBtn) return null
      const capsule = searchBtn.parentElement
      if (!capsule) return null
      const wide = Boolean(capsule.querySelector('input'))
      const slot = wide ? (capsule.parentElement || capsule) : capsule
      host.dataset.rail = wide ? 'false' : 'true'
      host.hidden = searchBtn.getAttribute('aria-expanded') === 'true'
      // 放在搜索胶囊前面，不跟其他插件抢「搜索图标后面」这个位置。
      if (slot.previousElementSibling !== host) slot.insertAdjacentElement('beforebegin', host)
      return host
    }

    function MicIcon() {
      return e('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        e('rect', { x: 6, y: 1.6, width: 4, height: 7.2, rx: 2, stroke: 'currentColor', strokeWidth: 1.35 }),
        e('path', { d: 'M3.6 7.4a4.4 4.4 0 0 0 8.8 0', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' }),
        e('path', { d: 'M8 11.8v2.4M5.6 14.2h4.8', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' }),
      )
    }

    async function fetchJson(path, init) {
      const response = await fetch(path, { cache: 'no-store', ...init })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      return data
    }

    function sleep(ms) {
      return new Promise((resolve) => { setTimeout(resolve, ms) })
    }

    function downsample(input, fromRate, toRate) {
      if (fromRate === toRate) return input
      const ratio = fromRate / toRate
      const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
      for (let i = 0; i < out.length; i += 1) {
        const x = i * ratio
        const i0 = Math.floor(x)
        const i1 = Math.min(i0 + 1, input.length - 1)
        const t = x - i0
        out[i] = input[i0] * (1 - t) + input[i1] * t
      }
      return out
    }

    function rmsOf(samples) {
      if (!samples.length) return 0
      let sum = 0
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
      return Math.sqrt(sum / samples.length)
    }

    function wavBlob(samples, sampleRate) {
      const bytes = samples.length * 2
      const buffer = new ArrayBuffer(44 + bytes)
      const view = new DataView(buffer)
      const write = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
      }
      write(0, 'RIFF')
      view.setUint32(4, 36 + bytes, true)
      write(8, 'WAVE')
      write(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      write(36, 'data')
      view.setUint32(40, bytes, true)
      let offset = 44
      for (let i = 0; i < samples.length; i += 1) {
        const s = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        offset += 2
      }
      return new Blob([buffer], { type: 'audio/wav' })
    }

    function wavBase64(samples, sampleRate) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^;]+;base64,/u, ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(wavBlob(samples, sampleRate))
      })
    }

    function floatToInt16Bytes(samples) {
      const out = new Int16Array(samples.length)
      for (let i = 0; i < samples.length; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[i]))
        out[i] = value < 0 ? value * 0x8000 : value * 0x7fff
      }
      return new Uint8Array(out.buffer)
    }

    function bytesToBase64(bytes) {
      let binary = ''
      const chunkSize = 0x8000
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize))
      }
      return btoa(binary)
    }

    function formatClock(ms) {
      const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
      const m = String(Math.floor(total / 60)).padStart(2, '0')
      const s = String(total % 60).padStart(2, '0')
      return `${m}:${s}`
    }

    function formatDuration(ms) {
      const seconds = Math.round((Number(ms) || 0) / 1000)
      if (seconds < 60) return `${seconds} 秒`
      const m = Math.floor(seconds / 60)
      const s = seconds % 60
      return s ? `${m} 分 ${s} 秒` : `${m} 分钟`
    }

    function takeParts(parts) {
      let total = 0
      for (const part of parts) total += part.length
      const out = new Float32Array(total)
      let offset = 0
      for (const part of parts) {
        out.set(part, offset)
        offset += part.length
      }
      parts.length = 0
      return out
    }

    function modeLabel(mode) {
      if (mode === 'dual-device') return '双通道（两个麦克风：说话人A / 说话人B）'
      if (mode === 'dual-system') return '双通道（我 = 麦克风，参会者 = 系统声音）'
      return '单通道（不区分说话人）'
    }

    function fillConversationInput(text) {
      try {
        const ta = document.querySelector('textarea[data-phase]')
        if (!ta) return false
        const cur = ta.value
        const sep = cur && !cur.endsWith('\n') ? '\n' : ''
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        if (!setter) return false
        setter.call(ta, cur + sep + text)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.focus()
        ta.scrollTop = ta.scrollHeight
        return true
      } catch {
        return false
      }
    }

    function analysisPrompt(notePath, noteId) {
      return [
        '这是一份会议逐字稿，已保存到本地：',
        notePath,
        noteId ? `（记录 id：${noteId}）` : '',
        '',
        '标题已按内容自动命名，不用再改。请读这个文件并输出：',
        '1. 一句话结论',
        '2. 关键决议（谁定了什么）',
        '3. 待办清单：事项 / 负责人 / 时间点（原文没写就标「未指定」）',
        '4. 风险与未决问题',
        '',
        '逐字稿说话人不确定的地方请标「说话人不确定」，不要编造人名、数字和结论。',
      ].filter(Boolean).join('\n')
    }

    function SettingsCard() {
      const [health, setHealth] = useState(null)
      const [open, setOpen] = useState(false)
      const [token, setToken] = useState('')
      const [baseUrl, setBaseUrl] = useState('')
      const [polishText, setPolishText] = useState(false)
      const [polishSpeaker, setPolishSpeaker] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [hint, setHint] = useState('')
      useEffect(ensureCss, [])
      useEffect(() => {
        fetchJson('/dsh-meeting/health').then((row) => {
          setHealth(row)
          setBaseUrl(row.config?.baseUrl || '')
          setPolishText(row.config?.polishText === true)
          setPolishSpeaker(row.config?.polishSpeaker === true)
        }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
      }, [])
      const configured = Boolean(health?.key?.configured)
      async function saveKey() {
        setBusy(true); setError(''); setHint('')
        try {
          const next = await fetchJson('/dsh-meeting/key', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
          })
          setHealth((prev) => ({ ...(prev || {}), key: next.key }))
          setToken('')
          setHint('Key 已保存到 DSH 凭证')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }
      async function saveBaseUrl(patch = {}) {
        setBusy(true); setError(''); setHint('')
        try {
          const next = await fetchJson('/dsh-meeting/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ baseUrl, polishText, polishSpeaker, ...patch }),
          })
          setHealth((prev) => ({ ...(prev || {}), config: next.config }))
          setBaseUrl(next.config?.baseUrl || '')
          setHint('接口地址已保存')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }
      async function test() {
        setBusy(true); setError(''); setHint('')
        try {
          const row = await fetchJson('/dsh-meeting/probe', { method: 'POST' })
          if (row.ok) setHint(`接口可用（${row.latencyMs} ms）：${row.note || ''}`)
          else setError(row.reason || '接口不通')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }
      return e('li', { className: 'dsh-mt-card' },
        e('div', { className: 'dsh-mt-card-head' },
          e('div', { className: 'dsh-mt-card-name' }, '会议记录',
            e('span', { className: 'dsh-mt-badge', 'data-bad': configured ? 'false' : 'true' }, configured ? 'Key 已配置' : '未配置 Key')),
          e('div', { className: 'dsh-mt-card-desc' }, 'DeepSeek 语音识别：实时录音 / 文件转写，逐字稿存到 ~/.dsh/meeting-notes，Agent 可直接读。入口在左侧栏搜索图标旁。'),
          e('button', { type: 'button', className: 'dsh-mt-text-btn', onClick: () => setOpen((value) => !value) }, open ? '收起设置' : '设置（Key / 校正）'),
        ),
        open ? e('div', { className: 'dsh-mt-body', style: { paddingTop: 0 } },
          e('p', { className: 'dsh-mt-hint' }, configured
            ? `当前使用 ${health?.key?.ref || '凭证'}（来源 ${health?.key?.source || 'credentials'}）。填新的会覆盖 DSH 凭证 DEEPSEEK_ASR_API_KEY。`
            : '填 DeepSeek 开放平台的 API Key。会写进 DSH 凭证 DEEPSEEK_ASR_API_KEY，不落任何文件；没有填时兜底用运行时的 DEEPSEEK_API_KEY。'),
          e('div', { className: 'dsh-mt-field' },
            e('label', { className: 'dsh-mt-label' }, 'DeepSeek API Key'),
            e('input', {
              className: 'dsh-mt-input',
              type: 'password',
              value: token,
              placeholder: configured ? '已配置，留空不改' : 'sk-…',
              onChange: (event) => setToken(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter' && token.trim()) void saveKey() },
            }),
          ),
          e('div', { className: 'dsh-mt-field' },
            e('label', { className: 'dsh-mt-label' }, '接口地址'),
            e('input', {
              className: 'dsh-mt-input',
              value: baseUrl,
              placeholder: 'https://api.deepseek.com',
              onChange: (event) => setBaseUrl(event.target.value),
            }),
          ),
          e('div', { className: 'dsh-mt-row' },
            e('button', { type: 'button', className: 'dsh-mt-go', disabled: busy || !token.trim(), onClick: () => { void saveKey() } }, busy ? '保存中…' : '保存 Key'),
            e('button', { type: 'button', className: 'dsh-mt-text-btn', disabled: busy, onClick: () => { void saveBaseUrl() } }, '保存地址'),
            e('button', { type: 'button', className: 'dsh-mt-text-btn', disabled: busy, onClick: () => { void test() } }, '测试连接'),
          ),
          e('div', { className: 'dsh-mt-field', style: { marginTop: 6 } },
            e('label', { className: 'dsh-mt-hint', style: { display: 'flex', alignItems: 'flex-start', gap: 6 } },
              e('input', {
                type: 'checkbox',
                checked: polishText,
                disabled: busy,
                onChange: (event) => {
                  setPolishText(event.target.checked)
                  void saveBaseUrl({ polishText: event.target.checked })
                },
              }),
              e('span', null, '实时校正错别字（用 DeepSeek 改同音字与断句，不改写内容；每段多一次调用，几百毫秒到 1 秒）'),
            ),
            e('label', { className: 'dsh-mt-hint', style: { display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 8 } },
              e('input', {
                type: 'checkbox',
                checked: polishSpeaker,
                disabled: busy,
                onChange: (event) => {
                  setPolishSpeaker(event.target.checked)
                  void saveBaseUrl({ polishSpeaker: event.target.checked })
                },
              }),
              e('span', null, '按上下文猜说话人是否标错（实验性：只听文字没有声音，两人对话较稳，多人容易乱）'),
            ),
          ),
          e('p', { className: 'dsh-mt-hint', style: { marginTop: 10 } },
            '限制：单次 ≤120 秒 / 8 MiB，本插件按 100 秒切段；计费约 ¥0.39/小时（官网限时价）。记录库目前 ',
            String(health?.notes ?? 0),
            ' 份。',
          ),
          error ? e('p', { className: 'dsh-mt-err' }, error) : null,
          hint ? e('p', { className: 'dsh-mt-hint' }, hint) : null,
        ) : null,
      )
    }

    function Panel({ inputActions }) {
      const [health, setHealth] = useState(null)
      const [tab, setTab] = useState('live')
      const [error, setError] = useState('')
      const [hint, setHint] = useState('')
      const [status, setStatus] = useState('')

      const [mode, setMode] = useState('single')
      const [keepAudio, setKeepAudio] = useState(true)
      const [devices, setDevices] = useState([])
      const [deviceA, setDeviceA] = useState('')
      const [deviceB, setDeviceB] = useState('')
      const [recording, setRecording] = useState(false)
      const [elapsed, setElapsed] = useState(0)
      const [level, setLevel] = useState(0)
      const [pending, setPending] = useState(0)
      const [segments, setSegments] = useState([])
      const [costMs, setCostMs] = useState(0)
      const [saved, setSaved] = useState(null)

      const [file, setFile] = useState(null)
      const [dualTrack, setDualTrack] = useState(true)
      const [speakers, setSpeakers] = useState('0')
      const [jobId, setJobId] = useState('')
      const [job, setJob] = useState(null)
      const [fileBusy, setFileBusy] = useState(false)

      const [notes, setNotes] = useState([])
      const [noteBody, setNoteBody] = useState(null)
      const [notesVersion, setNotesVersion] = useState(0)
      const [pendingDelete, setPendingDelete] = useState('')
      const [polishOn, setPolishOn] = useState(false)
      const [polishStats, setPolishStats] = useState({ checked: 0, changed: 0, error: '' })

      function removeNote(note) {
        if (pendingDelete !== note.id) {
          setPendingDelete(note.id)
          setTimeout(() => setPendingDelete((current) => (current === note.id ? '' : current)), 3000)
          return
        }
        setPendingDelete('')
        fetchJson('/dsh-meeting/notes/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: note.id }),
        })
          .then(() => {
            if (noteBody?.id === note.id) setNoteBody(null)
            setNotesVersion((value) => value + 1)
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      }

      useEffect(() => {
        fetchJson('/dsh-meeting/health')
          .then((row) => setPolishOn(row.config?.polishText === true))
          .catch(() => {})
      }, [])

      function togglePolish(next) {
        setPolishOn(next)
        fetchJson('/dsh-meeting/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ polishText: next }),
        }).catch(() => {})
      }

      const live = useRef({
        ctx: null,
        channels: [],
        timer: 0,
        running: false,
        inflight: 0,
        startedAt: 0,
        segments: [],
      })
      const segEnd = useRef(null)
      const jobSegEnd = useRef(null)
      // 是否跟着最新的走：用户往上翻就暂停跟随，翻回底部再继续
      const stickLive = useRef(true)
      const stickJob = useRef(true)
      function trackStick(ref) {
        return (event) => {
          const box = event.currentTarget
          ref.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48
        }
      }

      useEffect(() => {
        fetchJson('/dsh-meeting/health').then(setHealth).catch((err) => setError(err instanceof Error ? err.message : String(err)))
        return () => { stopEverything(true) }
      }, [])

      useEffect(() => {
        if (tab !== 'notes') return
        let alive = true
        fetchJson('/dsh-meeting/notes').then((row) => {
          if (alive) setNotes(Array.isArray(row.notes) ? row.notes : [])
        }).catch((err) => { if (alive) setError(err instanceof Error ? err.message : String(err)) })
        return () => { alive = false }
      }, [tab, notesVersion])

      useEffect(() => {
        if (!jobId) return
        let stopped = false
        let timer = 0
        const poll = async () => {
          try {
            const row = await fetchJson(`/dsh-meeting/file/${encodeURIComponent(jobId)}`)
            if (stopped) return
            setJob(row.job)
            if (row.job?.state === 'running') {
              timer = window.setTimeout(poll, 1200)
            } else {
              setFileBusy(false)
              setStatus('')
              if (row.job?.state === 'done') setNotesVersion((value) => value + 1)
            }
          } catch (err) {
            if (stopped) return
            setError(err instanceof Error ? err.message : String(err))
            setFileBusy(false)
          }
        }
        void poll()
        return () => {
          stopped = true
          if (timer) window.clearTimeout(timer)
        }
      }, [jobId])

      useEffect(() => {
        const box = jobSegEnd.current
        if (box && stickJob.current) box.scrollTop = box.scrollHeight
      }, [job?.segments?.length])

      useEffect(() => {
        const box = segEnd.current
        if (box && stickLive.current) box.scrollTop = box.scrollHeight
      }, [segments.length])


      const needKey = Boolean(health) && !health.key?.configured

      function audioConstraints(deviceId) {
        const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        if (deviceId) base.deviceId = { exact: deviceId }
        return base
      }

      function makeChannel(id, label, stream) {
        return {
          id,
          label,
          stream,
          source: null,
          processor: null,
          gain: null,
          parts: [],
          samples: 0,
          rate: TARGET_RATE,
          consumedMs: 0,
          level: 0,
          lastRms: 0,
          // 噪声底：只让接近底噪的帧参与，说话帧不动它
          noiseFloor: 0.01,
          silentMs: 0,
          record: false,
          recParts: [],
          recSamples: 0,
          recSending: false,
        }
      }

      /** 判定「停顿」的阈值：跟着噪声底浮动，嘈杂房间也能测到停顿。 */
      function silenceThreshold(channel) {
        return Math.max(0.0035, channel.noiseFloor * 2.4)
      }

      /** 在最后 8 秒里找最长的一段安静的起点，作为硬切位置。 */
      function pickQuietCut(samples, rate) {
        if (!samples.length) return samples.length
        const frame = Math.max(80, Math.round(rate * 0.02))
        const from = Math.max(0, samples.length - Math.round(rate * 8))
        let bestStart = -1
        let bestLen = 0
        let runStart = -1
        for (let i = from; i + frame <= samples.length; i += frame) {
          let peak = 0
          for (let j = i; j < i + frame; j += 1) {
            const value = samples[j] < 0 ? -samples[j] : samples[j]
            if (value > peak) peak = value
          }
          if (peak < 0.015) {
            if (runStart < 0) runStart = i
            const runLength = i + frame - runStart
            if (runLength > bestLen) {
              bestLen = runLength
              bestStart = runStart
            }
          } else {
            runStart = -1
          }
        }
        if (bestLen >= rate * 0.15 && bestStart > rate) return bestStart
        return samples.length
      }

      function attachChannel(channel) {
        const ctx = live.current.ctx
        channel.rate = ctx.sampleRate || TARGET_RATE
        const source = ctx.createMediaStreamSource(channel.stream)
        const processor = ctx.createScriptProcessor(4096, 1, 1)
        const mute = ctx.createGain()
        mute.gain.value = 0.0001
        source.connect(processor)
        processor.connect(mute)
        mute.connect(ctx.destination)
        processor.onaudioprocess = (event) => {
          if (!live.current.running) return
          const input = event.inputBuffer.getChannelData(0)
          const copy = new Float32Array(input.length)
          copy.set(input)
          channel.parts.push(copy)
          channel.samples += copy.length
          const rms = rmsOf(copy)
          channel.level = rms
          channel.lastRms = rms
          if (rms < channel.noiseFloor * 4) {
            channel.noiseFloor = channel.noiseFloor * 0.95 + rms * 0.05
          }
          if (channel.record) {
            const pcm = downsample(copy, channel.rate, TARGET_RATE)
            channel.recParts.push(pcm)
            channel.recSamples += pcm.length
          }
        }
        channel.source = source
        channel.processor = processor
        channel.gain = mute
      }

      function teardown() {
        const state = live.current
        state.running = false
        state.inflight = 0
        for (const channel of state.channels) {
          try { channel.processor?.disconnect() } catch { /* ignore */ }
          try { channel.source?.disconnect() } catch { /* ignore */ }
          try { channel.gain?.disconnect() } catch { /* ignore */ }
          try { channel.stream?.getTracks?.().forEach((track) => track.stop()) } catch { /* ignore */ }
          channel.parts = []
        }
        state.channels = []
        if (state.timer) {
          window.clearInterval(state.timer)
          state.timer = 0
        }
        if (state.ctx) {
          try { state.ctx.close() } catch { /* ignore */ }
          state.ctx = null
        }
        setPending(0)
      }

      function stopEverything(silent) {
        const state = live.current
        if (!state.running && !state.channels.length) return
        state.running = false
        teardown()
        setRecording(false)
        setLevel(0)
        if (!silent) setStatus('已停止')
      }

      function maybeFlush(channel, force) {
        const state = live.current
        const seconds = channel.rate ? channel.samples / channel.rate : 0
        if (!force) {
          if (state.inflight >= 3) return
          const reachedCap = seconds >= HARD_CAP_SEC
          const paused = seconds >= MIN_FLUSH_SEC && channel.silentMs >= SILENCE_FLUSH_MS
          if (!reachedCap && !paused) return
        }
        if (!channel.samples) return
        let samples = takeParts(channel.parts)
        channel.samples = 0
        channel.silentMs = 0
        if (!force) {
          // 到硬上限时宁可多留一点：优先切在最后一段安静处，别切在词中间
          const cut = pickQuietCut(samples, channel.rate)
          if (cut > 0 && cut < samples.length) {
            const rest = samples.subarray(cut)
            channel.parts.push(new Float32Array(rest))
            channel.samples = rest.length
            samples = samples.subarray(0, cut)
          }
        }
        const length = samples.length / channel.rate
        if (length < 0.3) return
        const startMs = channel.consumedMs
        channel.consumedMs += length * 1000
        const pcm = downsample(samples, channel.rate, TARGET_RATE)
        if (rmsOf(pcm) < 0.0015) return
        state.inflight += 1
        setPending(state.inflight)
        void (async () => {
          try {
            const audio = await wavBase64(pcm, TARGET_RATE)
            const row = await fetchJson('/dsh-meeting/asr', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ audio, startMs, label: channel.label }),
            })
            const text = String(row.text || '').trim()
            let label = channel.label
            if (mode === 'single' && state.speakerSession) {
              try {
                const who = await fetchJson('/dsh-meeting/speaker', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ sessionId: state.speakerSession, audio, durationMs: length * 1000 }),
                })
                if (who?.speaker != null) label = `说话人${Number(who.speaker) + 1}`
              } catch {
                /* 声纹失败就退回通用标签 */
              }
            }
            if (text) {
              const segment = { startMs, label, text }
              state.segments.push(segment)
              state.segments.sort((a, b) => a.startMs - b.startMs)
              setSegments(state.segments.slice())
              void polishLiveSegment(segment)
            }
            setCostMs((prev) => prev + (Number(row.durationMs) || length * 1000))
            setError('')
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            state.inflight = Math.max(0, state.inflight - 1)
            setPending(state.inflight)
          }
        })()
      }

      function tick() {
        const state = live.current
        if (!state.running) return
        let peak = 0
        for (const channel of state.channels) {
          peak = Math.max(peak, channel.level)
          if (channel.lastRms < silenceThreshold(channel)) channel.silentMs += 300
          else channel.silentMs = 0
          maybeFlush(channel, false)
          if (channel.record && channel.recSamples >= RECORD_FLUSH_SEC * TARGET_RATE) void flushRecord(channel)
        }
        setLevel(Math.min(1, peak * 8))
        setElapsed(Date.now() - state.startedAt)
      }

      async function flushRecord(channel) {
        const state = live.current
        if (!state.recordId || channel.recSending || !channel.recSamples) return
        const samples = takeParts(channel.recParts)
        channel.recSamples = 0
        if (!samples.length) return
        channel.recSending = true
        try {
          await fetchJson('/dsh-meeting/audio/append', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: state.recordId,
              pcm: bytesToBase64(floatToInt16Bytes(samples)),
            }),
          })
        } catch (err) {
          setHint(`原音保存失败：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          channel.recSending = false
        }
      }

      async function startRecording() {
        if (live.current.running) return
        setError(''); setHint(''); setSaved(null); setCostMs(0); setStatus('正在打开麦克风…')
        setSegments([])
        const state = live.current
        state.segments = []
        stickLive.current = true
        setPolishStats({ checked: 0, changed: 0, error: '' })
        state.inflight = 0
        state.startedAt = Date.now()
        state.running = true
        state.recordId = keepAudio ? `${state.startedAt}-${Math.random().toString(36).slice(2, 8)}` : ''
        state.speakerSession = `${state.startedAt}-${Math.random().toString(36).slice(2, 8)}`
        void fetchJson('/dsh-meeting/speaker/reset', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: state.speakerSession }),
        }).catch(() => {})
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext
          const ctx = new AudioCtx()
          if (ctx.state === 'suspended') await ctx.resume()
          state.ctx = ctx
          state.channels = []
          if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前窗口不能使用麦克风')

          if (mode === 'dual-device') {
            if (!deviceA || !deviceB) throw new Error('先选两个不同的麦克风')
            if (deviceA === deviceB) throw new Error('两个通道不能选同一个麦克风')
            const first = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceA), video: false })
            state.channels.push(makeChannel('mic-a', '说话人A', first))
            const second = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceB), video: false })
            state.channels.push(makeChannel('mic-b', '说话人B', second))
          } else if (mode === 'dual-system') {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceA), video: false })
            state.channels.push(makeChannel('mic-me', '我', mic))
            if (!navigator.mediaDevices.getDisplayMedia) throw new Error('当前窗口不能采集系统声音')
            const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
            const tracks = display.getAudioTracks ? display.getAudioTracks() : []
            if (!tracks.length) {
              try { display.getTracks().forEach((track) => track.stop()) } catch { /* ignore */ }
              throw new Error('没拿到系统声音：共享时请勾选「分享标签页音频 / 系统音频」，Electron 里还需要主进程放行屏幕捕获')
            }
            try { display.getVideoTracks?.().forEach((track) => track.stop()) } catch { /* ignore */ }
            state.channels.push(makeChannel('sys', '参会者', new MediaStream(tracks)))
          } else {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceA), video: false })
            state.channels.push(makeChannel('mic-1', '说话人', mic))
          }

          state.channels.forEach((channel, index) => { channel.record = Boolean(state.recordId) && index === 0 })
          for (const channel of state.channels) attachChannel(channel)
          state.timer = window.setInterval(tick, 300)
          setElapsed(0)
          setRecording(true)
          setStatus('正在听…说完一段会自动出字')
        } catch (err) {
          stopEverything(true)
          setRecording(false)
          setStatus('')
          setError(err instanceof Error ? err.message : String(err))
        }
      }

      async function stopRecording() {
        const state = live.current
        if (!state.running) return
        setStatus('正在收尾…')
        state.running = false
        for (const channel of state.channels) maybeFlush(channel, true)
        const deadline = Date.now() + 25000
        while (state.inflight > 0 && Date.now() < deadline) await sleep(150)
        // 把最后一段原音送上去并封成 WAV，方便回听或重新精转
        if (state.speakerSession) {
          void fetchJson('/dsh-meeting/speaker/reset', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: state.speakerSession }),
          }).catch(() => {})
          state.speakerSession = ''
        }
        const recordChannel = state.channels.find((channel) => channel.record)
        if (recordChannel) {
          const until = Date.now() + 5000
          while (recordChannel.recSending && Date.now() < until) await sleep(100)
          await flushRecord(recordChannel)
        }
        let audioPath = ''
        if (state.recordId) {
          try {
            const finished = await fetchJson('/dsh-meeting/audio/finish', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: state.recordId }),
            })
            audioPath = finished.path || ''
          } catch (err) {
            setHint(`原音没有存下来：${err instanceof Error ? err.message : String(err)}`)
          }
        }
        const durationMs = Math.max(Date.now() - state.startedAt, ...state.channels.map((channel) => channel.consumedMs), 0)
        const payload = {
          startedAt: new Date(state.startedAt || Date.now()).toISOString(),
          durationMs,
          mode: modeLabel(mode),
          segments: state.segments.slice(),
          source: '实时录音',
          audioPath,
        }
        teardown()
        setRecording(false)
        setLevel(0)
        setStatus('')
        if (!payload.segments.length) {
          setStatus('没有识别到内容，未保存')
          return
        }
        try {
          const row = await fetchJson('/dsh-meeting/notes', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: `会议记录 ${new Date(state.startedAt).toLocaleString('zh-CN')}`, ...payload }),
          })
          setSaved({ id: row.id, path: row.path, chars: row.chars, audioPath })
          setNotesVersion((value) => value + 1)
          setStatus('已保存')
          setHealth((prev) => (prev ? { ...prev, notes: (prev.notes || 0) + 1 } : prev))
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          setStatus('')
        }
      }

      async function loadDevices() {
        try {
          const list = await navigator.mediaDevices.enumerateDevices()
          const inputs = list.filter((item) => item.kind === 'audioinput')
          setDevices(inputs)
          if (!deviceA && inputs[0]) setDeviceA(inputs[0].deviceId)
          if (!deviceB && inputs[1]) setDeviceB(inputs[1].deviceId)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }

      async function startFile() {
        if (!file || fileBusy) return
        setFileBusy(true)
        setError('')
        setJob(null)
        setJobId('')
        try {
          setStatus('正在上传…')
          const response = await fetch('/dsh-meeting/upload', {
            method: 'POST',
            headers: {
              'content-type': file.type || 'application/octet-stream',
              'x-filename': encodeURIComponent(file.name || 'meeting-audio'),
            },
            body: file,
            cache: 'no-store',
          })
          const uploaded = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(uploaded.error || `上传失败 HTTP ${response.status}`)
          setStatus('正在起转写任务…')
          const started = await fetchJson('/dsh-meeting/file', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              path: uploaded.path,
              dualTrack,
              speakers: Number(speakers) || 0,
              title: String(file.name || '').replace(/\.[^.]+$/u, ''),
            }),
          })
          setJob(started.job)
          setJobId(started.job.id)
          setStatus('转写中…')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
          setFileBusy(false)
          setStatus('')
        }
      }

      async function refine() {
        const audioPath = saved?.audioPath
        if (!audioPath) return
        setError('')
        setHint('')
        try {
          const started = await fetchJson('/dsh-meeting/file', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              path: audioPath,
              dualTrack: false,
              title: `精转 ${new Date().toLocaleString('zh-CN')}`,
            }),
          })
          setJob(started.job)
          setJobId(started.job.id)
          setFileBusy(true)
          setTab('file')
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }

      // 识别完再让 DeepSeek 校一遍（设置里开了才生效，没开时 Host 直接返回空）
      // 看的是相邻两句：上一句被切断就合并，连贯但换了人则重新判说话人
      function polishLiveSegment(segment) {
        const segments = live.current.segments
        const index = segments.indexOf(segment)
        if (index < 0) return
        const context = segments
          .slice(Math.max(0, index - 5), index)
          .map((row) => ({ label: row.label, text: row.text }))
        const labels = [...new Set(segments.map((row) => row.label))]
        const allowSpeaker = mode === 'single' && segment.text.length <= 60

        if (index === 0) {
          fetchJson('/dsh-meeting/polish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: segment.text, label: segment.label, context, labels, allowSpeaker }),
          })
            .then((row) => applyPolish(row, { next: segment }))
            .catch((err) => notePolishError(err))
          return
        }

        const prev = segments[index - 1]
        fetchJson('/dsh-meeting/polish-pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prev: { text: prev.text, label: prev.label, startMs: prev.startMs },
            next: { text: segment.text, label: segment.label },
            context,
            labels,
            allowSpeaker,
          }),
        })
          .then((row) => applyPolish(row, { prev, next: segment }))
          .catch((err) => notePolishError(err))
      }

      function notePolishError(err) {
        setPolishStats((prev) => ({
          ...prev,
          checked: prev.checked + 1,
          error: err instanceof Error ? err.message : String(err),
        }))
      }

      function applyPolish(row, { prev, next }) {
        if (!row) return
        if (row.ok === false) {
          setPolishStats((state) => ({ ...state, checked: state.checked + 1, error: row.reason || '接口返回失败' }))
          return
        }
        let changed = false

        // 1) 上一句在句子中间被切断：合成一句，刚识别的那段并进去
        if (row.join && prev) {
          prev.origin = prev.origin || prev.text
          prev.text = row.join
          prev.merged = true
          // 两段原本标了不同人却被合并：说明说话人也判错了，按上一句的人算
          if (prev.label !== next.label) prev.speakerFixed = true
          const at = live.current.segments.indexOf(next)
          if (at > 0) live.current.segments.splice(at, 1)
          changed = true
        } else {
          if (prev && row.prevText && row.prevText !== prev.text) {
            prev.origin = prev.origin || prev.text
            prev.text = row.prevText
            changed = true
          }
          if (row.text && row.text !== next.text) {
            next.origin = next.origin || next.text
            next.text = row.text
            changed = true
          }
          if (row.nextText && row.nextText !== next.text) {
            next.origin = next.origin || next.text
            next.text = row.nextText
            changed = true
          }
        }

        // 2) 连贯但标了不同人：按模型的判断改说话人
        if (row.speaker && row.speaker !== next.label) {
          next.label = row.speaker
          next.speakerFixed = true
          changed = true
        }

        setPolishStats((state) => ({
          ...state,
          checked: state.checked + 1,
          changed: state.changed + (changed ? 1 : 0),
          error: '',
        }))
        if (changed) setSegments(live.current.segments.slice())
      }

      function addToChat(notePath, noteId) {
        const text = analysisPrompt(notePath, noteId)
        let ok = false
        if (inputActions && typeof inputActions.setDraft === 'function') {
          const ta = document.querySelector('textarea[data-phase]')
          const cur = ta ? ta.value : ''
          const next = cur ? (cur.endsWith('\n') ? cur + text : `${cur}\n${text}`) : text
          inputActions.setDraft(next)
          ok = true
        } else {
          ok = fillConversationInput(text)
        }
        setHint(ok ? '已加入输入框，回车交给 DSH 分析' : '无法写入对话')
        setTimeout(() => setHint(''), 2600)
      }

      function copyText(text) {
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {})
        setHint('已复制')
        setTimeout(() => setHint(''), 1800)
      }

      function transcriptText() {
        return live.current.segments.map((segment) => `[${formatClock(segment.startMs)}] ${segment.label}：${segment.text}`).join('\n')
      }

      function renderSegment(segment, index) {
        return e('div', { key: `${segment.startMs}-${index}`, className: 'dsh-mt-seg' },
          e('span', { className: 'dsh-mt-seg-time' }, formatClock(segment.startMs)),
          e('span', { className: 'dsh-mt-seg-text' },
            segment.label && segment.label !== '说话人'
              ? e('span', { className: 'dsh-mt-seg-label' }, `${segment.label} · `)
              : null,
            segment.text,
            segment.merged
              ? e('span', { className: 'dsh-mt-seg-fix', title: `合并前：${segment.origin || ''}` }, '（校正合并）')
              : null,
            segment.speakerFixed
              ? e('span', { className: 'dsh-mt-seg-fix', title: '说话人已按上下文校正' }, '（校正说话人）')
              : null,
            segment.origin && !segment.merged
              ? e('span', { className: 'dsh-mt-seg-fix', title: `原文：${segment.origin}` }, '（校正）')
              : null,
          ),
        )
      }

      const cost = (costMs / 3_600_000) * PRICE_PER_HOUR

      return e('div', { className: 'dsh-mt-panel', role: 'dialog', 'aria-label': '会议记录' },
        e('div', { className: 'dsh-mt-head' },
          e('h1', null, '会议记录', e('span', { className: 'dsh-mt-sub' }, 'DeepSeek 语音识别')),
          e('button', { type: 'button', className: 'dsh-mt-icon', onClick: () => setPanelOpen(false), title: '关闭', 'aria-label': '关闭' }, '×'),
        ),
        e('div', { className: 'dsh-mt-body' },
          e('div', { className: 'dsh-mt-opts', role: 'tablist' },
            e('button', { type: 'button', className: 'dsh-mt-opt', 'data-on': tab === 'live' ? 'true' : 'false', onClick: () => setTab('live') }, '实时录音'),
            e('button', { type: 'button', className: 'dsh-mt-opt', 'data-on': tab === 'file' ? 'true' : 'false', onClick: () => setTab('file') }, '文件转写'),
            e('button', { type: 'button', className: 'dsh-mt-opt', 'data-on': tab === 'notes' ? 'true' : 'false', onClick: () => setTab('notes') }, '记录库'),
          ),

          needKey ? e('p', { className: 'dsh-mt-err' }, '还没有配置 DeepSeek API Key：去「设置 → 插件 → 会议记录」填一个，或先用运行时的 DEEPSEEK_API_KEY。') : null,

          tab === 'live' ? e(React.Fragment, null,
            e('div', { className: 'dsh-mt-rec' },
              e('button', {
                type: 'button',
                className: 'dsh-mt-rec-btn',
                'data-on': recording ? 'true' : 'false',
                disabled: needKey && !recording,
                title: recording ? '停止并保存' : '开始录音',
                'aria-label': recording ? '停止录音' : '开始录音',
                onClick: () => { if (recording) void stopRecording(); else void startRecording() },
              }, e('span', { className: 'dsh-mt-rec-dot' })),
              e('div', { className: 'dsh-mt-rec-info' },
                e('div', { className: 'dsh-mt-rec-time' }, formatClock(elapsed)),
                e('div', { className: 'dsh-mt-rec-sub' },
                  status || (recording ? '正在听…' : '点一下开始'),
                  pending ? ` · 识别中 ${pending}` : '',
                ),
              ),
            ),
            e('div', { className: 'dsh-mt-level', 'aria-hidden': true },
              e('i', { style: { width: `${Math.round(level * 100)}%` } }),
            ),
            segments.length ? e('div', { className: 'dsh-mt-meta' },
              `${segments.length} 段 · ${segments.reduce((sum, item) => sum + item.text.length, 0)} 字 · 约 ¥${cost.toFixed(3)}`,
              polishOn && polishStats.checked
                ? ` · 已校正 ${polishStats.changed}/${polishStats.checked}`
                : '',
              polishStats.error ? ` · 校正失败：${polishStats.error}` : '',
            ) : null,
            e('div', { className: 'dsh-mt-segs', ref: segEnd, onScroll: trackStick(stickLive) },
              segments.length
                ? segments.map(renderSegment)
                : e('p', { className: 'dsh-mt-empty' }, '说完一段就会出字：停顿 0.45 秒成一段，最多 30 秒切一刀。'),
            ),
            saved ? e('div', { className: 'dsh-mt-field', style: { marginTop: 12 } },
              e('p', { className: 'dsh-mt-hint' }, `已保存：${saved.path}`),
              saved.audioPath ? e('p', { className: 'dsh-mt-hint' }, `原音：${saved.audioPath}`) : null,
              e('div', { className: 'dsh-mt-actions' },
                e('button', { type: 'button', className: 'dsh-mt-text-btn', onClick: () => copyText(transcriptText()) }, '复制逐字稿'),
                e('button', { type: 'button', className: 'dsh-mt-text-btn', 'data-primary': 'true', onClick: () => addToChat(saved.path, saved.id) }, '让 DSH 分析'),
                saved.audioPath ? e('button', { type: 'button', className: 'dsh-mt-text-btn', onClick: () => { void refine() } }, '精转（60 秒切片）') : null,
              ),
            ) : null,
            e('label', { className: 'dsh-mt-hint', style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 } },
              e('input', {
                type: 'checkbox',
                checked: polishOn,
                onChange: (event) => togglePolish(event.target.checked),
              }),
              '识别后校正错别字（DeepSeek，每段多一次调用，约慢 1 秒）',
            ),
          ) : null,

          tab === 'file' ? e(React.Fragment, null,
            e('div', { className: 'dsh-mt-field' },
              e('label', { className: 'dsh-mt-label' }, '本机音视频'),
              e('input', {
                className: 'dsh-mt-input',
                type: 'file',
                accept: 'audio/*,video/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.mp4,.mov,.mkv,.webm',
                disabled: fileBusy,
                onChange: (event) => {
                  const next = event.target.files?.[0] || null
                  setFile(next)
                  setJob(null)
                  setJobId('')
                },
              }),
            ),
            e('div', { className: 'dsh-mt-row' },
              e('div', { className: 'dsh-mt-field' },
                e('label', { className: 'dsh-mt-label' }, '说话人数'),
                e('input', {
                  className: 'dsh-mt-input',
                  type: 'number',
                  min: 0,
                  max: 8,
                  value: speakers,
                  disabled: fileBusy,
                  onChange: (event) => setSpeakers(event.target.value),
                }),
              ),
              e('label', { className: 'dsh-mt-hint', style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 } },
                e('input', { type: 'checkbox', checked: dualTrack, disabled: fileBusy, onChange: (event) => setDualTrack(event.target.checked) }),
                '左右声道各是一位说话人',
              ),
            ),
            e('p', { className: 'dsh-mt-hint' }, '单声道会用本地声纹自动区分说话人（0 = 自动判断人数）；双声道按左右轨分人。结果自动存进记录库。'),
            e('button', { type: 'button', className: 'dsh-mt-go', disabled: !file || fileBusy || needKey, onClick: () => { void startFile() } }, fileBusy ? '转写中…' : '开始转写'),
            job ? e(React.Fragment, null,
              e('div', { className: 'dsh-mt-progress', 'aria-hidden': true }, e('i', { style: { width: `${Math.round((job.progress || 0) * 100)}%` } })),
              e('p', { className: 'dsh-mt-hint' },
                job.state === 'failed'
                  ? `失败：${job.error}`
                  : `${job.state === 'done' ? '完成' : '进行中'} · ${formatDuration(job.durationMs)} · ${job.mode} · ${job.segments?.length || 0} 段${job.warning ? ` · ${job.warning}` : ''}`,
              ),
              job.segments?.length ? e('div', { className: 'dsh-mt-segs', ref: jobSegEnd, onScroll: trackStick(stickJob) },
                job.segments.slice(0, 200).map(renderSegment),
              ) : null,
              job.notePath ? e('div', { className: 'dsh-mt-actions' },
                e('button', { type: 'button', className: 'dsh-mt-text-btn', onClick: () => copyText(job.notePath) }, '复制路径'),
                e('button', { type: 'button', className: 'dsh-mt-text-btn', onClick: () => addToChat(job.notePath, job.noteId) }, '让 DSH 分析'),
              ) : null,
            ) : null,
          ) : null,

          tab === 'notes' ? e(React.Fragment, null,
            notes.length
              ? e('ul', { className: 'dsh-mt-list' }, notes.map((note) => e('li', { key: note.id, className: 'dsh-mt-item' },
                e('div', {
                  className: 'dsh-mt-item-main',
                  onClick: () => {
                    setNoteBody(null)
                    fetchJson(`/dsh-meeting/notes/${encodeURIComponent(note.id)}`)
                      .then((row) => setNoteBody({ path: row.path, markdown: row.markdown, id: note.id }))
                      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                  },
                },
                  e('div', { className: 'dsh-mt-item-title' }, note.title),
                  e('div', { className: 'dsh-mt-item-meta' }, `${new Date(note.createdAt).toLocaleString('zh-CN')} · ${formatDuration(note.durationMs)} · ${note.segments} 段 · ${note.chars} 字`),
                ),
                e('button', {
                  type: 'button',
                  className: 'dsh-mt-item-del',
                  title: pendingDelete === note.id ? '再点一次删除' : '删除',
                  'data-confirm': pendingDelete === note.id ? 'true' : 'false',
                  onClick: (event) => {
                    event.stopPropagation()
                    removeNote(note)
                  },
                }, '×'),
              )))
              : e('p', { className: 'dsh-mt-empty' }, '还没有记录。录完音或转写完文件会自动存到这里。'),
            noteBody ? e(React.Fragment, null,
              e('div', { className: 'dsh-mt-actions', style: { justifyContent: 'flex-start', marginTop: 10 } },
                e('button', { type: 'button', className: 'dsh-mt-text-btn', onClick: () => addToChat(noteBody.path, noteBody.id) }, '让 DSH 分析'),
                e('button', { type: 'button', className: 'dsh-mt-text-btn', onClick: () => copyText(noteBody.markdown) }, '复制 markdown'),
                e('button', { type: 'button', className: 'dsh-mt-text-btn', onClick: () => setNoteBody(null) }, '收起'),
              ),
              e('pre', {
                style: {
                  marginTop: 8, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontSize: 12, lineHeight: 1.55, background: 'var(--dsw-alias-bg-base, #f7f6f3)',
                  border: '1px solid var(--dsw-alias-border-l2, #e2e0d8)', borderRadius: 10, padding: '8px 10px',
                },
              }, noteBody.markdown),
            ) : null,
          ) : null,

          error ? e('p', { className: 'dsh-mt-err', style: { marginTop: 10 } }, error) : null,
          hint ? e('p', { className: 'dsh-mt-hint', style: { marginTop: 10 } }, hint) : null,
        ),
      )
    }

    function ActionsSink(props) {
      lastInputActions = props.inputActions || lastInputActions
      return e('span', { style: { display: 'none' }, 'aria-hidden': true })
    }

    function SidebarEntry() {
      const [open] = usePanelOpen()
      const [anchor, setAnchor] = useState(null)
      const watch = useRef(null)
      useEffect(ensureCss, [])
      useEffect(() => {
        const place = () => { setAnchor(ensureAnchor()) }
        place()
        const observer = new MutationObserver(place)
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded', 'aria-label'] })
        watch.current = window.setInterval(place, 1500)
        return () => {
          observer.disconnect()
          if (watch.current) window.clearInterval(watch.current)
        }
      }, [])
      const toggle = e('button', {
        type: 'button',
        className: 'dsh-mt-toggle',
        'data-open': open ? 'true' : 'false',
        title: '会议记录',
        'aria-label': '会议记录',
        'aria-expanded': open,
        onClick: () => setPanelOpen((value) => !value),
      }, e(MicIcon))
      const panel = open ? e(Panel, { inputActions: lastInputActions }) : null
      if (createPortal && anchor) {
        return e(React.Fragment, null,
          createPortal(toggle, anchor),
          panel && createPortal(panel, document.body),
        )
      }
      return e(React.Fragment, null, toggle, panel)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dsh-meeting-toggle', order: 21, label: '会议记录' },
          () => e(SidebarEntry),
        ))
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'dsh-meeting-actions', order: 91, label: '会议记录' },
          ActionsSink,
        ))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'meeting-asr',
          order: 32,
          label: '会议记录',
        }, SettingsCard))
      },
    }
  },
})
