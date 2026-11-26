// 纯投影：把工具返回值变成模型读的文字和 dsh-go 原生工具卡。
// 不做 I/O，可以在单测和 presentationMeta 里直接调用。

/** 工具卡要写进对话记录，必须小。 */
const CARD_MAX_BYTES = 8 * 1024

/**
 * 把视图函数包成 presentationMeta。
 * 视图抛错、不是无损 JSON 或超过 8 KiB 时返回空对象，让工具结果照常返回。
 */
export function toolCard(build) {
  return (args, value) => {
    try {
      const text = JSON.stringify(build(args, value))
      if (text === undefined || Buffer.byteLength(text, 'utf8') > CARD_MAX_BYTES) return {}
      return { 'dsh-go/view': JSON.parse(text) }
    } catch {
      return {}
    }
  }
}

const PHASES = {
  idle: { zh: '空闲', en: 'Idle', tone: 'muted' },
  preparing: { zh: '准备固件', en: 'Preparing firmware', tone: 'info' },
  connecting: { zh: '连接 B-Link', en: 'Connecting to B-Link', tone: 'info' },
  detect: { zh: '读取设备信息', en: 'Reading device info', tone: 'info' },
  transfer: { zh: '传输固件', en: 'Transferring firmware', tone: 'info' },
  program: { zh: '设备烧录中', en: 'Programming device', tone: 'info' },
  running: { zh: '处理中', en: 'Running', tone: 'info' },
  done: { zh: '烧录完成', en: 'Flash complete', tone: 'good' },
  failed: { zh: '烧录失败', en: 'Flash failed', tone: 'bad' },
  disconnected: { zh: '链路断开', en: 'Link lost', tone: 'warn' },
}

function phaseInfo(phase) {
  return PHASES[phase] || PHASES.idle
}

function sizeText(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

/** 烧录四个阶段当前走到哪一步；失败时把当前步标红。 */
function burnSteps(phase, zh) {
  const labels = zh
    ? ['准备固件', '连接 B-Link', '传输固件', '设备烧录']
    : ['Prepare firmware', 'Connect B-Link', 'Transfer', 'Program']
  const rank = { preparing: 0, connecting: 1, detect: 2, transfer: 2, program: 3, running: 3, done: 4 }[phase]
  const failed = phase === 'failed' || phase === 'disconnected'
  const current = rank === undefined ? 0 : rank
  return labels.map((label, index) => {
    let status
    if (failed) {
      status = index === current ? 'failed' : index < current ? 'done' : 'todo'
    } else if (rank === 4) {
      status = 'done'
    } else {
      status = index < current ? 'done' : index === current ? 'current' : 'todo'
    }
    return { label, status }
  })
}

/** 状态卡：目标 / 阶段 / 进度 / 固件 / 上次结果 */
export function statusView(value) {
  const zh = value.language !== 'en'
  const info = phaseInfo(value.phase)
  const phaseLabel = zh ? info.zh : info.en
  const title = value.connected
    ? `B-Link · ${value.device ? `${value.device} · ` : ''}${value.target || (zh ? '已连接' : 'Connected')}${value.busy ? (zh ? ' · 烧录中' : ' · Flashing') : ''}`
    : `B-Link · ${zh ? '未连接' : 'Not connected'}`

  const phaseMetric = { type: 'metric', label: zh ? '阶段' : 'Phase', value: phaseLabel }
  const phaseProgress = { type: 'progress', value: value.percent, label: phaseLabel }
  if (info.tone !== 'muted') {
    phaseMetric.tone = info.tone
    phaseProgress.tone = info.tone
  }

  const children = [
    {
      type: 'row',
      children: [
        { type: 'metric', label: zh ? '目标' : 'Target', value: value.target || '—' },
        phaseMetric,
        { type: 'metric', label: zh ? '进度' : 'Progress', value: `${value.percent}%` },
      ],
    },
    phaseProgress,
  ]

  const kv = [[zh ? '固件' : 'Firmware', value.imageName || '—']]
  if (value.imageSize > 0) kv.push([zh ? '大小' : 'Size', sizeText(value.imageSize)])
  if (value.imageCrc) kv.push(['CRC32', value.imageCrc])
  if (value.lastAvailable) {
    kv.push([zh ? '上次结果' : 'Last result', value.lastOk ? (zh ? '成功' : 'OK') : (zh ? '失败' : 'Failed')])
  }
  children.push({ type: 'keyValue', items: kv })

  if (value.error) {
    children.push({ type: 'callout', text: value.error, tone: 'bad' })
  } else if (value.message) {
    children.push({ type: 'text', text: value.message, tone: 'muted' })
  }
  if (value.hint) {
    children.push({ type: 'text', text: value.hint, tone: 'muted' })
  }

  return { type: 'stack', title, children }
}

/** 烧录结果卡：完成 / 失败 / 仍在进行三种形态。 */
export function burnView(value) {
  const zh = value.language !== 'en'
  if (!value.ok) {
    const children = [{ type: 'callout', text: value.error || (zh ? '未能开始' : 'Not started'), tone: 'bad' }]
    if (value.hint) children.push({ type: 'text', text: value.hint, tone: 'muted' })
    return { type: 'stack', title: zh ? '烧录未开始' : 'Burn not started', children }
  }

  const name = value.path || value.url || ''
  const percent = Math.min(100, Math.max(0, Math.round(Number(value.percent) || 0)))

  if (value.failed) {
    const children = [
      { type: 'steps', items: burnSteps('failed', zh) },
      { type: 'callout', text: value.message || (zh ? '烧录失败' : 'Flash failed'), tone: 'bad' },
    ]
    if (value.hint) children.push({ type: 'text', text: value.hint, tone: 'muted' })
    return {
      type: 'stack',
      title: zh ? `烧录失败 · ${value.target || name}` : `Flash failed · ${value.target || name}`,
      children,
    }
  }

  if (value.completed) {
    return {
      type: 'stack',
      title: zh ? `烧录完成 · ${value.target || name}` : `Flash complete · ${value.target || name}`,
      children: [
        { type: 'steps', items: burnSteps('done', zh) },
        {
          type: 'row',
          children: [
            { type: 'metric', label: zh ? '目标' : 'Target', value: value.target || '—' },
            { type: 'metric', label: zh ? '进度' : 'Progress', value: '100%', tone: 'good' },
          ],
        },
        { type: 'progress', value: 100, label: zh ? '烧录完成' : 'Complete', tone: 'good' },
        { type: 'keyValue', items: [[zh ? '固件' : 'Firmware', value.imageName || name || '—']] },
        {
          type: 'text',
          text: value.message || (zh ? '烧录成功，目标板已复位' : 'Done; target reset'),
          tone: 'muted',
        },
      ],
    }
  }

  return {
    type: 'stack',
    title: zh ? `烧录中 · ${percent}%` : `Flashing · ${percent}%`,
    children: [
      { type: 'steps', items: burnSteps(value.phase, zh) },
      { type: 'progress', value: percent, label: zh ? '进行中' : 'In progress', tone: 'info' },
      {
        type: 'text',
        text: zh ? '仍在进行，用 blink_status 查看最新进度' : 'Still flashing; call blink_status for progress',
        tone: 'muted',
      },
    ],
  }
}

/** 模型读的状态摘要 */
export function statusText(value) {
  if (!value.ok) {
    return `B-Link bridge unavailable: ${value.error}${value.hint ? ` (${value.hint})` : ''}`
  }
  const parts = [
    `connected=${value.connected}`,
    `busy=${value.busy}`,
    `phase=${value.phase}`,
    `percent=${value.percent}`,
  ]
  if (value.target) parts.push(`target=${value.target}`)
  if (value.device) parts.push(`device=${value.device}`)
  if (value.imageName) parts.push(`image=${value.imageName} (${value.imageSize} B, CRC32 ${value.imageCrc})`)
  if (value.lastAvailable) parts.push(`lastResult=${value.lastOk ? 'ok' : 'failed'}`)
  if (value.error) parts.push(`error=${value.error}`)
  else if (value.message) parts.push(`message=${value.message}`)
  return `B-Link status: ${parts.join('; ')}.`
}

/** 模型读的烧录结果 */
export function burnText(value) {
  if (!value.ok) {
    return `Burn not started: ${value.error}${value.hint ? ` (${value.hint})` : ''}`
  }
  const name = value.path || value.url || ''
  const percent = Math.round(Number(value.percent) || 0)
  if (value.failed) {
    return `Burn failed for ${name}: phase=${value.phase}${value.message ? `; ${value.message}` : ''}.`
  }
  if (value.completed) {
    return `Burn complete for ${name}: target=${value.target || 'unknown'}, 100%${
      value.message ? `; ${value.message}` : ''
    }.`
  }
  return `Burn still running for ${name}: phase=${value.phase}, ${percent}%. Call blink_status for progress.`
}
