// B-Link 本地桥（只监听 127.0.0.1:8737）的最小客户端。
// 本机引擎与 B-Link App 共享同一个网络栈，所以可以直接访问回环地址。

export class BridgeError extends Error {
  /**
   * @param {string} code 机器可读的错误码，供视图层挑选提示文案
   * @param {string} message 给人看的一句话
   */
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '')
}

/** 单次请求，不做重试。 */
async function once(config, base, path, options, timeoutMs) {
  // 串口写要走原始字节；其余接口仍然是 JSON
  const raw = options.raw instanceof Uint8Array ? options.raw : null
  const body = raw ? raw : options.body === undefined ? undefined : JSON.stringify(options.body)
  const headers = { 'X-Token': config.token }
  if (body !== undefined) headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json'

  let response
  try {
    response = await fetch(base + path, {
      method: options.method || 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new BridgeError('timeout', '连接本地桥超时')
    }
    const cause = e && e.cause && e.cause.code
    if (cause === 'ECONNREFUSED') {
      // 端口没人监听：App 没启动或桥没起来，和"被冻结"是两种不同处理
      throw new BridgeError('bridge-not-running', '本地桥没有在监听')
    }
    throw new BridgeError('bridge-unreachable', `连接本地桥失败：${e && e.message ? e.message : e}`)
  }

  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }

  if (!response.ok) {
    const detail = data && typeof data.error === 'string' && data.error ? data.error : `HTTP ${response.status}`
    throw new BridgeError(response.status === 401 ? 'bad-token' : 'bridge-error', detail)
  }
  if (data === null || typeof data !== 'object') {
    throw new BridgeError('bad-response', '本地桥返回了无法解析的内容')
  }
  return data
}

/**
 * 调一次本地桥。
 *
 * `retries` 只对超时/连不上生效：App 刚被系统冻结时，第一次可能救不回来，
 * 但连着试两次往往能撞上它被唤醒的窗口。鉴权与参数错误不重试。
 *
 * @param {{ bridgeUrl: string, token: string, timeoutMs: number }} config
 * @param {string} path 例如 /status
 * @param {{ method?: string, body?: unknown, timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function request(config, path, options = {}) {
  const base = trimBase(config.bridgeUrl)
  if (!base) {
    throw new BridgeError('bridge-url-missing', '没有配置本地桥地址')
  }
  if (!config.token) {
    throw new BridgeError('token-missing', '没有配置本地桥令牌')
  }

  const timeoutMs = options.timeoutMs || config.timeoutMs || 15000
  const retries = Math.max(0, Math.min(3, options.retries || 0))

  let last = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt))
    }
    try {
      return await once(config, base, path, options, timeoutMs)
    } catch (e) {
      last = e
      const retryable =
        e instanceof BridgeError &&
        (e.code === 'timeout' || e.code === 'bridge-not-running' || e.code === 'bridge-unreachable')
      if (!retryable) {
        throw e
      }
    }
  }
  throw last
}
