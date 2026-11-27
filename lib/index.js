// dsh-bl-link：把 B-Link BLE 烧录器接进 DSH Go。
//
// 工具的宿主半侧跑在 DSH 引擎里（手机本机引擎时与 B-Link App 共享 127.0.0.1），
// 通过 App 内置的本地 HTTP 桥完成三件事：
//   GET  /status    查询连接/目标/进度/上次结果
//   POST /burn      接受一次烧录（必须 confirm=true）：任意 url / 本地文件 base64
// 写操作永远不直接写 Flash：桥只负责把任务交给 App，由 App 走既有的 BLE 流程。
import fs from 'node:fs'
import nodePath from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { BridgeError, request } from './http.js'
import {
  burnText,
  burnView,
  statusText,
  statusView,
  toolCard,
} from './view.js'

export const name = 'dsh-bl-link'
export const inject = ['tools']

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8737'

/** 原生设置页：令牌在 B-Link App 日志「本地桥已启动 … token=…」里复制。 */
export const Config = z.object({
  bridgeUrl: z.string().default(DEFAULT_BRIDGE_URL).volatile().description({
    zh: '本地桥地址。手机本机引擎用默认值即可：装了 B-Link 后台服务版会走 8738，否则用 App 的 8737。',
    en: 'Local bridge URL. The default works on-device: 8738 with the background service, 8737 with the app.',
  }),
  token: z.string().default('auto').volatile().description({
    zh: '本地桥令牌。默认 auto：自动读取 B-Link App 导出的 blink-bridge.json，无需手填。',
    en: 'Bridge token. "auto" (default) reads it from the blink-bridge.json exported by the B-Link app.',
  }),
  bridgeInfoPath: z.string().default('/sdcard/Download/DSH-GO/blink-bridge.json').volatile().description({
    zh: 'B-Link App 导出的桥信息文件（含 url 与 token），token 为 auto 时读它。',
    en: 'Bridge info file exported by the B-Link app (url + token); read when token is "auto".',
  }),
  timeoutMs: z.number().min(1000).max(60000).default(15000).volatile().description({
    zh: '单次请求超时（毫秒）。',
    en: 'Request timeout in milliseconds.',
  }),
})

/**
 * 引擎传下来的值可能被 volatile 对象包了一层（本身还带 get()）。
 * 最多解两层，遇到普通值原样返回。
 */
function unwrap(value, key) {
  let current = value
  for (let depth = 0; depth < 2; depth++) {
    if (current === null || typeof current !== 'object' || typeof current.get !== 'function') break
    let next
    try {
      next = current.get()
    } catch {
      break
    }
    if (next === undefined || next === null) {
      try {
        next = current.get(key)
      } catch {
        break
      }
    }
    if (next === undefined) break
    current = next
  }
  return current
}

/**
 * 引擎传入的配置可能是普通对象，也可能是 schemastery 实例。
 * 普通对象直接读属性；schemastery 实例要先用 get(key) 取字段。
 */
function readField(source, key) {
  if (!source || typeof source !== 'object') return undefined
  if (typeof source.get === 'function') {
    try {
      const value = source.get(key)
      if (value !== undefined && value !== null) return unwrap(value, key)
    } catch {
      /* 不是 schemastery 实例时退回读属性 */
    }
  }
  return unwrap(source[key], key)
}

const AUTO_TOKEN = 'auto'
const DEFAULT_BRIDGE_INFO_PATH = '/sdcard/Download/DSH-GO/blink-bridge.json'
/* 后台服务版（com.blink.service，端口 8738）导出的桥信息，优先使用 */
const SERVICE_INFO_PATH = '/sdcard/Download/DSH-GO/blink-service.json'

/** 读 B-Link App 导出的桥信息（url + token）；文件不存在或损坏时返回 null。 */
function readBridgeInfo(path) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return {
      url: typeof parsed.url === 'string' ? parsed.url.trim() : '',
      token: typeof parsed.token === 'string' ? parsed.token.trim() : '',
    }
  } catch {
    return null
  }
}

function configOf(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const rawUrl = readField(source, 'bridgeUrl')
  const rawToken = readField(source, 'token')
  const rawTimeout = readField(source, 'timeoutMs')
  const rawInfoPath = readField(source, 'bridgeInfoPath')
  const timeout = rawTimeout == null ? 15000 : Number(rawTimeout)
  const infoPath =
    typeof rawInfoPath === 'string' && rawInfoPath.trim() ? rawInfoPath.trim() : DEFAULT_BRIDGE_INFO_PATH

  let url = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  let token = typeof rawToken === 'string' ? rawToken.trim() : ''
  let tokenSource = token && token !== AUTO_TOKEN ? 'manual' : 'none'

  if (tokenSource === 'none') {
    token = ''
    /* 优先用后台服务版导出的信息（8738）；没有就退回 App 前台桥（8737） */
    const serviceInfo = readBridgeInfo(SERVICE_INFO_PATH)
    const appInfo = readBridgeInfo(infoPath)
    const info = serviceInfo && serviceInfo.token ? serviceInfo : appInfo
    if (info && info.token) {
      token = info.token
      tokenSource = 'file'
      /* 没手改过地址时跟随桥信息文件，避免默认值把服务版挡掉 */
      if ((!url || url === DEFAULT_BRIDGE_URL) && info.url) url = info.url
    }
  }

  return {
    bridgeUrl: url || DEFAULT_BRIDGE_URL,
    token,
    tokenSource,
    timeoutMs: Number.isFinite(timeout) ? Math.min(Math.max(timeout, 1000), 60000) : 15000,
  }
}

const languageOf = (args) => (args && args.language === 'en' ? 'en' : 'zh')
const textOf = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value))

function percentOf(value) {
  const n = Math.round(Number(value) || 0)
  return Math.min(100, Math.max(0, n))
}

/** 把客户端异常翻成视图需要的 code / 文案 / 提示。 */
function failureFields(error, language) {
  const zh = language !== 'en'
  const code = error instanceof BridgeError ? error.code : 'unexpected'
  const message = error && error.message ? error.message : zh ? '本地桥请求失败' : 'Bridge request failed'
  const hints = {
    'bridge-url-missing': zh
      ? '在插件设置里填写 bridgeUrl，默认 http://127.0.0.1:8737。'
      : 'Set bridgeUrl in the plugin settings (default http://127.0.0.1:8737).',
    'token-missing': zh
      ? '让 B-Link 后台服务（或 App）启动一次即可自动获取令牌（会导出 blink-service.json / blink-bridge.json）；也可在插件设置里手填 token。'
      : 'Start the B-Link background service (or app) once so the token is exported; or set token manually.',
    'bad-token': zh
      ? '令牌不匹配，请重新复制 App 日志里的最新 token。'
      : 'Token mismatch; copy the latest token from the app log.',
    'bridge-unreachable': zh
      ? '连不上本地桥：确认 B-Link App 正在运行，且本机引擎与 App 共享 127.0.0.1。'
      : 'Cannot reach the bridge: make sure the B-Link app is running and the on-device engine shares 127.0.0.1 with it.',
    'bridge-not-running': zh
      ? '本地桥没有在监听（8738 后台服务 / 8737 App）。插件会尝试自动拉起，失败就手动打开一次 B-Link 后台服务。'
      : 'No local bridge is listening (8738 service / 8737 app). The plugin tries to wake it; otherwise start the B-Link background service once.',
    timeout: zh
      ? '本地桥没有响应。若用的是 App 版，通常是它退到后台被系统冻结：改用后台服务版，或在系统设置里允许 App 后台运行。'
      : 'The bridge did not respond. If using the app, it was likely frozen in background: use the service build or allow background activity.',
    'bad-response': zh
      ? '本地桥返回了无法解析的内容。'
      : 'The bridge returned an unreadable response.',
    'bridge-error': zh
      ? '本地桥拒绝了请求，详见错误信息。'
      : 'The bridge rejected the request; see the error message.',
  }
  return { error: message, code, hint: hints[code] || null }
}

/** 让后台服务断开当前链路并重新扫描（/service/restart，仅服务版支持） */
async function restartService(config, language) {
  const zh = language !== 'en'
  try {
    const data = await request(config, '/service/restart', { method: 'POST', retries: 1 })
    if (data.ok === false) {
      const why = textOf(data.error) || (zh ? '服务拒绝了重启' : 'Restart rejected')
      return {
        ok: false,
        action: 'restart',
        message: why,
        error: why,
        code: 'restart-rejected',
        hint: zh ? '烧录进行中不能重启，等结束后再试。' : 'Cannot restart while burning; retry after it finishes.',
        language,
      }
    }
    return {
      ok: true,
      action: 'restart',
      message: zh
        ? '已重启 B-Link 链路，正在重新扫描并连回上次设备（约 10 秒），可稍后用 blink_status 确认。'
        : 'B-Link link restarted; rescanning and reconnecting (~10s). Use blink_status to confirm.',
      error: null,
      code: null,
      hint: null,
      language,
    }
  } catch (e) {
    const fields = failureFields(e, language)
    const notFound = fields.code === 'bridge-error' && /not found/i.test(fields.error || '')
    if (notFound) {
      fields.error = zh
        ? '当前连的是 App 版桥（8737），它不支持 /service/restart；请装 B-Link 后台服务版。'
        : 'The app bridge (8737) does not support /service/restart; install the B-Link background service.'
      fields.hint = zh ? '后台服务版端口 8738，装好后插件会自动优先使用。' : 'The service build listens on 8738 and is preferred automatically.'
    }
    return { ok: false, action: 'restart', message: fields.error, ...fields, language }
  }
}

function emptyStatus(language) {
  return {
    ok: false,
    connected: false,
    ready: false,
    busy: false,
    target: '',
    phase: 'idle',
    percent: 0,
    message: '',
    error: null,
    code: null,
    hint: null,
    device: '',
    deviceAddress: '',
    imageName: '',
    imageSize: 0,
    imageCrc: '',
    lastAvailable: false,
    lastOk: false,
    language,
  }
}

async function getStatus(config, language) {
  try {
    const data = await request(config, '/status', { retries: 2 })
    const image = data.image && typeof data.image === 'object' ? data.image : {}
    const last = data.last && typeof data.last === 'object' ? data.last : {}
    const dev = data.device && typeof data.device === 'object' ? data.device : {}
    return {
      ok: true,
      connected: Boolean(data.connected),
      ready: Boolean(data.connected),
      busy: Boolean(data.busy),
      target: textOf(data.target),
      device: textOf(dev.name),
      deviceAddress: textOf(dev.address),
      phase: textOf(data.phase) || 'idle',
      percent: percentOf(data.percent),
      message: textOf(data.message),
      error: textOf(data.error) || null,
      code: null,
      hint: null,
      imageName: textOf(image.name),
      imageSize: Math.max(0, Math.round(Number(image.size) || 0)),
      imageCrc: textOf(image.crc),
      lastAvailable: Boolean(last.available),
      lastOk: Boolean(last.ok),
      language,
    }
  } catch (e) {
    return { ...emptyStatus(language), ...failureFields(e, language) }
  }
}

const BURN_WAIT_MS = 90000
const BURN_POLL_MS = 1500
const ACTIVE_PHASES = new Set([
  'preparing',
  'connecting',
  'detect',
  'transfer',
  'program',
  'running',
])

const burnSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 受理后盯到烧录结束，最多等 BURN_WAIT_MS。
 * 只有见过「进行中」或已超过 5 秒才认完成，避免把上一次的旧结果当成这次。
 */
async function waitForBurn(config, startedAt) {
  let sawActivity = false
  let last = null
  while (Date.now() - startedAt < BURN_WAIT_MS) {
    await burnSleep(BURN_POLL_MS)
    let status
    try {
      status = await request(config, '/status', { timeoutMs: 8000 })
    } catch {
      continue
    }
    const phase = textOf(status.phase) || 'idle'
    const busy = Boolean(status.busy)
    if (ACTIVE_PHASES.has(phase) || busy) sawActivity = true
    last = status
    const finished = !busy && (phase === 'done' || phase === 'failed' || phase === 'disconnected')
    if (finished && (sawActivity || Date.now() - startedAt > 5000)) break
  }
  return last
}

/** B-Link 设备侧暂存区上限（IMAGE_MAX_SIZE = 0x3F000 = 252KB），
 *  超过这个尺寸镜像根本存不进 B-Link，会在 BEGIN 阶段被拒。 */
const BURN_MAX_IMAGE = 252 * 1024

async function startBurn(config, args, language) {
  const zh = language !== 'en'
  const url = typeof args.url === 'string' ? args.url.trim() : ''
  const file = typeof args.file === 'string' ? args.file.trim() : ''
  const result = {
    ok: false,
    accepted: false,
    phase: 'idle',
    path: file,
    url,
    percent: 0,
    target: '',
    message: '',
    imageName: '',
    completed: false,
    failed: false,
    error: null,
    code: null,
    hint: null,
    language,
  }

  if (args.confirm !== true) {
    return {
      ...result,
      code: 'confirmation-required',
      error: language === 'en' ? 'confirm=true is required' : '需要 confirm=true',
      hint:
        language === 'en'
          ? 'Ask the user which firmware to flash and get explicit approval before calling again.'
          : '先和用户确认要烧哪个固件，得到明确同意后再调用。',
    }
  }
  if (!url && !file) {
    return {
      ...result,
      code: 'target-missing',
      error: language === 'en' ? 'url or file is required' : 'url 或 file 必须给一个',
      hint:
        language === 'en'
          ? 'Pass a local .bin path as file, or a direct http(s) link as url.'
          : '用 file 指定本机 .bin，或用 url 给一个 http(s) 直链。',
    }
  }

  try {
    let target = file
    let body
    if (file) {
      let buf
      try {
        buf = fs.readFileSync(file)
      } catch (e) {
        return {
          ...result,
          path: file,
          code: 'file-unreadable',
          error: zh ? `读不到本地固件：${e && e.message ? e.message : e}` : `Cannot read local file: ${e && e.message ? e.message : e}`,
          hint: zh ? '确认文件路径存在，且扩展名是 .bin。' : 'Check that the path exists and points to a .bin.',
        }
      }
      if (buf.length === 0) {
        return { ...result, path: file, code: 'file-empty', error: zh ? '文件是空的' : 'The file is empty', hint: null }
      }
      if (buf.length > BURN_MAX_IMAGE) {
        return {
          ...result,
          path: file,
          code: 'file-too-large',
          error: zh
            ? `固件 ${buf.length} 字节，超过 B-Link 暂存区 252KB 上限`
            : `Firmware is ${buf.length} bytes, over the B-Link 252KB staging limit`,
          hint: zh
            ? 'B-Link 先把镜像存进自己的 Flash 再烧，上限 252KB；换一个更小的 .bin 再试。'
            : 'B-Link stages the image in its own flash (252KB max); pick a smaller .bin.',
        }
      }
      target = file
      body = { name: nodePath.basename(file), data: buf.toString('base64'), confirm: true }
    } else {
      body = { url, confirm: true }
    }

    const data = await request(config, '/burn', { method: 'POST', body, timeoutMs: 20000 })
    if (!data || data.accepted !== true) {
      return {
        ...result,
        path: target,
        code: 'not-accepted',
        error: language === 'en' ? 'The bridge did not accept the burn' : '本地桥没有受理烧录',
        hint:
          language === 'en'
            ? 'Open the B-Link app, make sure no burn is running, then try again.'
            : '打开 B-Link App，确认当前没有正在进行的烧录，再试一次。',
      }
    }

    /* 受理后继续盯着，直到出结果或超时，让一次调用就能拿到最终状态 */
    const startedAt = Date.now()
    const status = await waitForBurn(config, startedAt)
    const phase = status ? textOf(status.phase) || 'preparing' : 'preparing'
    const image = status && status.image && typeof status.image === 'object' ? status.image : {}
    const failed = phase === 'failed' || phase === 'disconnected'
    const completed = phase === 'done' || failed

    return {
      ...result,
      path: target,
      ok: true,
      accepted: true,
      phase,
      percent: status ? percentOf(status.percent) : 0,
      target: status ? textOf(status.target) : '',
      message: status ? textOf(status.message) : '',
      imageName: textOf(image.name),
      completed,
      failed,
      hint: completed
        ? null
        : language === 'en'
          ? 'Still flashing after 90s. Call blink_status for the latest progress.'
          : '90 秒后仍在烧录，用 blink_status 查看最新进度。',
    }
  } catch (e) {
    return { ...result, ...failureFields(e, language) }
  }
}

/* ---------------- 串口桥（透明转发目标板 UART） ---------------- */

/** 与 App 端 LocalBridge 的 MAX_BODY 一致 */
const UART_WRITE_MAX = 8192
const UART_READ_CHUNK = 4096
const uartSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 最近一次读到的游标：连续调用 blink_uart_read 不传 since 就从这里续读 */
let uartCursor = 0

function uartHint(error, zh) {
  const text = String(error || '')
  if (text.includes('uart not open')) {
    return zh ? '串口还没打开，先调用 blink_uart_open。' : 'Open the port first with blink_uart_open.'
  }
  if (text.includes('BLE 未连接') || text.includes('not connected')) {
    return zh
      ? 'B-Link 未连接：打开 App 并连上设备后再试。'
      : 'B-Link is not connected: open the app and connect the device first.'
  }
  if (text.includes('busy')) {
    return zh ? '正在烧录，等烧录结束再开串口。' : 'A burn is running; wait for it to finish.'
  }
  if (text.includes('无应答')) {
    return zh ? '设备没有回包，检查 B-Link 连接是否稳定。' : 'No reply from the device; check the BLE link.'
  }
  return null
}

/** 桥的串口接口用 HTTP 200 + ok:false 表示业务失败，这里统一转成视图字段 */
function uartFailure(data, language, extra = {}) {
  const zh = language !== 'en'
  const error = textOf(data && data.error) || (zh ? '串口操作失败' : 'UART operation failed')
  return {
    ok: false,
    error,
    code: 'uart-error',
    hint: uartHint(error, zh),
    language,
    ...extra,
  }
}

function decodeUart(base64, encoding) {
  const buf = Buffer.from(String(base64 || ''), 'base64')
  if (encoding === 'hex') return buf.toString('hex')
  if (encoding === 'base64') return buf.toString('base64')
  return buf.toString('utf8')
}

async function uartCall(config, path, options) {
  return request(config, path, { timeoutMs: 15000, ...options })
}

async function uartOpen(config, args, language) {
  const baud = Math.min(921600, Math.max(1200, Math.round(Number(args.baud) || 115200)))
  const muteLog = args.muteLog !== false
  try {
    const data = await uartCall(config, '/uart/open', {
      method: 'POST',
      body: { baud, muteLog },
      timeoutMs: 20000,
    })
    if (data.ok === false) return uartFailure(data, language, { baud })
    uartCursor = 0
    return {
      ok: true,
      baud: Math.round(Number(data.baud) || baud),
      already: Boolean(data.already),
      muteLog,
      error: null,
      code: null,
      hint: null,
      language,
    }
  } catch (e) {
    return { ok: false, baud, already: false, muteLog, ...failureFields(e, language) }
  }
}

async function uartWrite(config, args, language) {
  let bytes
  if (typeof args.base64 === 'string' && args.base64) {
    bytes = Buffer.from(args.base64, 'base64')
  } else if (typeof args.data === 'string' && args.data.length > 0) {
    bytes = Buffer.from(args.data, 'utf8')
  } else {
    return {
      ok: false,
      written: 0,
      error: language === 'en' ? 'data or base64 is required' : '需要 data 或 base64',
      code: 'data-missing',
      hint: language === 'en' ? 'Pass the bytes to send.' : '把要发送的内容放进 data。',
      language,
    }
  }
  if (args.newline === true) {
    bytes = Buffer.concat([bytes, Buffer.from('\r\n')])
  }
  if (bytes.length > UART_WRITE_MAX) {
    return {
      ok: false,
      written: 0,
      error: language === 'en' ? 'too much data for one call' : '单次写入数据过多',
      code: 'data-too-large',
      hint:
        language === 'en'
          ? `Split into chunks of at most ${UART_WRITE_MAX} bytes.`
          : `请拆成每段不超过 ${UART_WRITE_MAX} 字节多次调用。`,
      language,
    }
  }

  try {
    const data = await uartCall(config, '/uart/write', {
      method: 'POST',
      raw: bytes,
      timeoutMs: 20000 + bytes.length,
    })
    if (data.ok === false) {
      return uartFailure(data, language, { written: Math.round(Number(data.written) || 0) })
    }
    return {
      ok: true,
      written: Math.round(Number(data.written) || bytes.length),
      error: null,
      code: null,
      hint: null,
      language,
    }
  } catch (e) {
    return { ok: false, written: 0, ...failureFields(e, language) }
  }
}

async function uartRead(config, args, language) {
  const waitMs = Math.min(5000, Math.max(0, Math.round(Number(args.waitMs ?? 1500))))
  const since = Number.isFinite(Number(args.since)) ? Math.max(0, Math.round(Number(args.since))) : uartCursor
  const encoding = args.encoding === 'hex' || args.encoding === 'base64' ? args.encoding : 'text'
  try {
    const data = await uartCall(config, `/uart/read?since=${since}&waitMs=${waitMs}`, {
      timeoutMs: waitMs + 10000,
    })
    if (data.ok === false) {
      return uartFailure(data, language, {
        next: since,
        bytes: 0,
        data: '',
        dropped: 0,
        open: false,
        encoding,
        truncated: false,
      })
    }
    const next = Number.isFinite(Number(data.next)) ? Number(data.next) : since
    uartCursor = next
    const text = decodeUart(data.data, encoding)
    return {
      ok: true,
      data: text,
      bytes: Math.max(0, next - since),
      next,
      dropped: Math.round(Number(data.dropped) || 0),
      open: Boolean(data.open),
      encoding,
      truncated: next - since >= UART_READ_CHUNK,
      error: null,
      code: null,
      hint: null,
      language,
    }
  } catch (e) {
    return {
      ok: false,
      data: '',
      bytes: 0,
      next: since,
      dropped: 0,
      open: false,
      encoding,
      truncated: false,
      ...failureFields(e, language),
    }
  }
}

/**
 * 反复读直到匹配 pattern（字符串按正则解释，非法正则退回字面匹配）或超时。
 * 一次调用就能等到目标板把整行输出完，省掉模型自己 sleep 轮询。
 */
async function uartWait(config, args, language) {
  const timeoutMs = Math.min(30000, Math.max(500, Math.round(Number(args.timeoutMs ?? 6000))))
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  let re = null
  if (pattern) {
    try {
      re = new RegExp(pattern)
    } catch {
      re = null
    }
  }
  const startSince = Number.isFinite(Number(args.since))
    ? Math.max(0, Math.round(Number(args.since)))
    : uartCursor
  const deadline = Date.now() + timeoutMs
  let since = startSince
  let text = ''
  let dropped = 0
  let open = true

  try {
    while (Date.now() < deadline) {
      const data = await uartCall(config, `/uart/read?since=${since}&waitMs=400`, {
        timeoutMs: 10000,
      })
      if (data.ok === false) {
        return uartFailure(data, language, {
          matched: false,
          timedOut: false,
          pattern,
          data: text,
          bytes: since - startSince,
          next: since,
          dropped: 0,
          open: false,
        })
      }
      const next = Number.isFinite(Number(data.next)) ? Number(data.next) : since
      if (next > since) {
        text += decodeUart(data.data, 'text')
        since = next
        uartCursor = next
      }
      dropped = Math.round(Number(data.dropped) || 0)
      open = Boolean(data.open)
      const hit = re ? re.test(text) : text.length > 0
      if (hit) {
        return {
          ok: true,
          matched: true,
          timedOut: false,
          pattern,
          data: text,
          bytes: since - startSince,
          next: since,
          dropped,
          open,
          error: null,
          code: null,
          hint: null,
          language,
        }
      }
      if (text.length > 64 * 1024) {
        // 一直等不到就截断，避免把整条串口日志都堆进上下文
        text = text.slice(-32 * 1024)
      }
      await uartSleep(80)
    }
    return {
      ok: true,
      matched: false,
      timedOut: true,
      pattern,
      data: text,
      bytes: since - startSince,
      next: since,
      dropped,
      open,
      error: null,
      code: null,
      hint: language === 'en' ? 'No match before timeout; read again to keep waiting.' : '超时仍未匹配到，可再调用一次继续等。',
      language,
    }
  } catch (e) {
    return {
      ok: false,
      matched: false,
      timedOut: false,
      pattern,
      data: text,
      bytes: since - startSince,
      next: since,
      dropped: 0,
      open: false,
      ...failureFields(e, language),
    }
  }
}

async function uartClose(config, language) {
  try {
    const data = await uartCall(config, '/uart/close', { method: 'POST', timeoutMs: 20000 })
    if (data.ok === false) return uartFailure(data, language)
    uartCursor = 0
    return { ok: true, error: null, code: null, hint: null, language }
  } catch (e) {
    return { ok: false, ...failureFields(e, language) }
  }
}

const languageParam = {
  type: 'string',
  enum: ['zh', 'en'],
  description: '卡片与提示的语言，跟用户消息一致。默认 zh。',
}

export function apply(ctx, config) {
  // 每次调用时重新读一遍，volatile 配置改动无需重启插件
  const settings = () => configOf(config)

  try {
    const s = settings()
    const tokenState = s.tokenSource === 'file' ? 'auto(file)' : s.tokenSource === 'manual' ? 'manual' : 'MISSING'
    console.log(`[dsh-bl-link] bridge=${s.bridgeUrl} token=${tokenState}`)
  } catch {
    /* 加载日志失败不影响工具注册 */
  }

  ctx.tools.register(defineTool({
    name: 'blink_status',
    description:
      '查询 B-Link 烧录器的当前状态：是否已连接、目标芯片、正在进行的阶段与进度、当前固件、上次烧录结果。' +
      '用户问“烧到哪了”“好了吗”“连上了吗”时调用。',
    parameters: { language: languageParam },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          connected: { type: 'boolean', required: true },
          ready: { type: 'boolean', required: true },
          busy: { type: 'boolean', required: true },
          target: { type: 'string', required: true },
          device: { type: 'string', required: true },
          deviceAddress: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          percent: { type: 'integer', required: true },
          message: { type: 'string', required: true },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          code: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          hint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          imageName: { type: 'string', required: true },
          imageSize: { type: 'integer', required: true },
          imageCrc: { type: 'string', required: true },
          lastAvailable: { type: 'boolean', required: true },
          lastOk: { type: 'boolean', required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: statusText(value) }],
      presentationMeta: toolCard((_args, value) => statusView(value)),
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    execute: (args) => getStatus(settings(), languageOf(args)),
  }))

  ctx.tools.register(defineTool({
    name: 'blink_service_restart',
    description:
      '重启 B-Link 后台服务中的连接链路：断开当前 BLE，重新扫描并连回上次的设备（不重启 App 进程，不弹界面）。' +
      '连接卡死、换过目标板、或 blink_status 显示异常时调用。烧录进行中会被拒绝。',
    parameters: { language: languageParam },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          message: { type: 'string', required: true },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          code: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          hint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => false,
    execute: (args) => restartService(settings(), languageOf(args)),
  }))

  ctx.tools.register(defineTool({
    name: 'blink_burn',
    description:
      '让 B-Link 烧录一个固件。用 url 指定任意 .bin 地址，' +
      '或用 file 直接给本机上的 .bin 文件（≤252KB，B-Link 暂存区上限）。' +
      '必须在用户明确要求烧录、并确认目标固件之后调用，且 confirm 必须为 true。' +
      '调用会等到烧录结束（通常十几秒到一分钟，最多 90 秒）再返回最终结果；' +
      '万一 90 秒仍在进行，再用 blink_status 查看。',
    parameters: {
      url: { type: 'string', description: '也可以直接给一个 .bin 的 http(s) 地址。' },
      file: {
        type: 'string',
        description:
          '本机 .bin 的绝对路径（≤252KB）。适合刚编译出来的固件，直接读文件上传。',
      },
      confirm: {
        type: 'boolean',
        required: true,
        description: '用户已明确同意烧录这个固件时才传 true；否则不要调用。',
      },
      language: languageParam,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          accepted: { type: 'boolean', required: true },
          phase: { type: 'string', required: true },
          path: { type: 'string', required: true },
          url: { type: 'string', required: true },
          percent: { type: 'integer', required: true },
          target: { type: 'string', required: true },
          message: { type: 'string', required: true },
          imageName: { type: 'string', required: true },
          completed: { type: 'boolean', required: true },
          failed: { type: 'boolean', required: true },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          code: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          hint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: burnText(value) }],
      presentationMeta: toolCard((_args, value) => burnView(value)),
    },
    timeoutMs: 100000,
    isConcurrencySafe: () => false,
    execute: (args) => startBurn(settings(), args, languageOf(args)),
  }))

  ctx.tools.register(defineTool({
    name: 'blink_uart_open',
    description:
      '打开 B-Link 的目标板串口桥（CH582F 的 UART1，接目标板 TX/RX），之后可收发串口数据。' +
      '默认 115200 8N1，并关闭 B-Link 自身的日志输出以免混进串口数据。' +
      '用户要“看串口输出”“发串口命令”“抓日志”时先调用它。',
    parameters: {
      baud: { type: 'number', description: '波特率，默认 115200（1200~921600）。' },
      muteLog: { type: 'boolean', description: '桥接期间不输出 B-Link 本机日志，默认 true。' },
      language: languageParam,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          baud: { type: 'integer', required: true },
          already: { type: 'boolean', required: true },
          muteLog: { type: 'boolean', required: true },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          code: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          hint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `UART open at ${value.baud} baud${value.already ? ' (already open)' : ''}.`
          : `Cannot open UART: ${value.error}${value.hint ? ` (${value.hint})` : ''}`,
      }],
    },
    timeoutMs: 25000,
    isConcurrencySafe: () => false,
    execute: (args) => uartOpen(settings(), args, languageOf(args)),
  }))

  ctx.tools.register(defineTool({
    name: 'blink_uart_write',
    description:
      '通过已打开的串口桥向目标板发送数据。data 按 UTF-8 发送文本，也可以用 base64 发送任意字节；' +
      'newline=true 会在末尾补 CRLF，适合 AT 指令与命令行交互。单次上限 8KB，多的拆多次。',
    parameters: {
      data: { type: 'string', description: '要发送的文本（UTF-8）。' },
      base64: { type: 'string', description: '要发送的原始字节（base64），与 data 二选一。' },
      newline: { type: 'boolean', description: '末尾是否补 \\r\\n，默认 false。' },
      language: languageParam,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          written: { type: 'integer', required: true },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          code: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          hint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Sent ${value.written} bytes over UART.`
          : `UART write failed: ${value.error}${value.hint ? ` (${value.hint})` : ''}`,
      }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute: (args) => uartWrite(settings(), args, languageOf(args)),
  }))

  ctx.tools.register(defineTool({
    name: 'blink_uart_read',
    description:
      '读取串口桥里目标板发来的数据。不传 since 时从上一次读到的位置继续，所以连续调用不会重复也不会漏。' +
      'waitMs 内没有新数据就返回空。一次最多返回 4KB，truncated=true 表示还有积压，应再读一次。',
    parameters: {
      since: { type: 'number', description: '起始游标（上次返回的 next）；省略则自动续读。' },
      waitMs: { type: 'number', description: '等待新数据的毫秒数，默认 1500，最大 5000。' },
      encoding: {
        type: 'string',
        enum: ['text', 'hex', 'base64'],
        description: '返回 what 编码，默认 text（UTF-8）。二进制协议用 hex 或 base64。',
      },
      language: languageParam,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          data: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          next: { type: 'integer', required: true },
          dropped: { type: 'integer', required: true },
          open: { type: 'boolean', required: true },
          encoding: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          code: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          hint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${value.bytes} bytes from UART (next=${value.next}${value.dropped ? `, dropped=${value.dropped}` : ''}):\n${value.data || '(no new data)'}`
          : `UART read failed: ${value.error}${value.hint ? ` (${value.hint})` : ''}`,
      }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    execute: (args) => uartRead(settings(), args, languageOf(args)),
  }))

  ctx.tools.register(defineTool({
    name: 'blink_uart_wait',
    description:
      '等串口出现指定内容再返回：pattern 按正则匹配（如 "boot ok|READY"），不传 pattern 则等到任意新数据。' +
      '适合“等待目标板启动完成”“等某条日志出现”这类场景，避免反复调用 blink_uart_read 轮询。',
    parameters: {
      pattern: { type: 'string', description: '要等待的内容，正则语法；省略表示等到任意新数据。' },
      since: { type: 'number', description: '起始游标；省略则从上次读到的位置开始。' },
      timeoutMs: { type: 'number', description: '最长等待毫秒数，默认 6000，最大 30000。' },
      language: languageParam,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          matched: { type: 'boolean', required: true },
          timedOut: { type: 'boolean', required: true },
          pattern: { type: 'string', required: true },
          data: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          next: { type: 'integer', required: true },
          dropped: { type: 'integer', required: true },
          open: { type: 'boolean', required: true },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          code: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          hint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `${value.matched ? 'Matched' : 'Timed out'}${value.pattern ? ` (pattern: ${value.pattern})` : ''}, ${value.bytes} bytes:\n${value.data || '(no new data)'}`
          : `UART wait failed: ${value.error}${value.hint ? ` (${value.hint})` : ''}`,
      }],
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => false,
    execute: (args) => uartWait(settings(), args, languageOf(args)),
  }))

  ctx.tools.register(defineTool({
    name: 'blink_uart_close',
    description: '关闭目标板串口桥，把 B-Link 的 UART 还给本机日志输出。串口用完后调用。',
    parameters: { language: languageParam },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          code: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          hint: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? 'UART closed.' : `Cannot close UART: ${value.error}${value.hint ? ` (${value.hint})` : ''}`,
      }],
    },
    timeoutMs: 25000,
    isConcurrencySafe: () => false,
    execute: (args) => uartClose(settings(), languageOf(args)),
  }))
}
