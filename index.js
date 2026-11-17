/**
 * Host half of the Task end notifications bundle.
 *
 * The plugin watches the post-commit session feed for `turn/end` and shows one OS-level
 * notification for a finished turn. It never appends session events: all state kept here is an
 * in-memory cache for previews, turn start times, and duplicate suppression.
 *
 * Notification delivery:
 * - Windows: Windows PowerShell runs an encoded script that first tries a Windows toast under the
 *   Desktop app's AppUserModelID, and falls back to a tray balloon when the toast API rejects the
 *   caller.
 * - macOS: `osascript` posts a notification banner.
 * - Linux: `notify-send` posts a desktop notification.
 *
 * @module @local/dsh-task-notify
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Fallback configuration merged with the Loader row's `config`. */
const DEFAULTS = {
  enabled: true,
  notifyOnCompleted: true,
  notifyOnError: true,
  notifyOnAborted: false,
  minDurationMs: 3000,
  includeSubagents: false,
  previewChars: 120,
  silent: false,
  titleCompleted: '任务完成',
  titleError: '任务失败',
  titleAborted: '任务已中止',
  bodyTemplate: '{session} · {duration} · {tokens}',
  windowsAppId: 'com.deepseek.dsh',
  windowsChannel: 'auto',
}

/** Windows PowerShell, used when the packaged system path cannot be resolved. */
const POWERSHELL = 'powershell.exe'

/** Longest a caller waits for one helper process before reporting success as unknown. */
const DELIVERY_TIMEOUT_MS = 15000

/**
 * Resolve the Windows PowerShell executable, preferring the packaged system path so the channel
 * does not depend on the Host process PATH.
 * @returns an absolute executable path when it exists, else the plain command name.
 */
function powershellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const candidate = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : POWERSHELL
}

/**
 * Copy recognized fields from one Loader row config over the defaults.
 * Unknown fields are ignored, and non-matching types keep the default so a partially written row
 * still activates.
 * @param raw - the row's `config` value.
 * @returns the effective configuration.
 */
function resolveConfig(raw) {
  const config = { ...DEFAULTS }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const value = raw[key]
      if (value === undefined) continue
      if (typeof fallback === 'boolean' && typeof value === 'boolean') config[key] = value
      else if (typeof fallback === 'number' && typeof value === 'number' && Number.isFinite(value)) config[key] = value
      else if (typeof fallback === 'string' && typeof value === 'string') config[key] = value
    }
  }
  config.minDurationMs = Math.max(0, Math.trunc(config.minDurationMs))
  config.previewChars = Math.min(500, Math.max(0, Math.trunc(config.previewChars)))
  return config
}

/**
 * Group one durable turn-end reason into the notification classes this plugin offers.
 * @param reason - the `turn/end` reason value.
 * @returns the notification class.
 */
function classifyReason(reason) {
  if (reason === null || typeof reason !== 'object') return 'other'
  switch (reason.kind) {
    case 'completed': return 'completed'
    case 'error': return 'error'
    case 'aborted':
    case 'interrupted':
    case 'blocked': return 'aborted'
    default: return 'other'
  }
}

/** Human description of one notification class, used by `{reason}`. */
const REASON_LABELS = {
  completed: '完成',
  error: '出错',
  aborted: '已中止',
  other: '已结束',
}

/**
 * Collect the visible text of one assistant message without depending on a single block field
 * name, because a message may carry `blocks` or `content` depending on its producer.
 * @param message - one session event's assistant message value.
 * @returns trimmed text, or an empty string when the message has no text blocks.
 */
function textOfMessage(message) {
  if (message === null || typeof message !== 'object') return ''
  const blocks = Array.isArray(message.blocks)
    ? message.blocks
    : Array.isArray(message.content)
      ? message.content
      : []
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Collapse whitespace and cut one preview string to the configured length.
 * @param text - raw text.
 * @param limit - maximum characters; `0` disables the preview.
 * @returns the preview, or an empty string.
 */
function makePreview(text, limit) {
  if (limit <= 0 || typeof text !== 'string') return ''
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return ''
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '')}…`
}

/**
 * Format an elapsed duration for humans.
 * @param milliseconds - elapsed time, or `undefined` when unknown.
 * @returns a duration, or an empty string when the elapsed time is unknown.
 */
function formatDuration(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return ''
  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
}

/**
 * Format one token count compactly: `999`, `1.2k`, `12k`, `1.2M`.
 * @param value - a token count.
 * @returns the compact text, or an empty string for a zero or unusable value.
 */
function compactCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return ''
  if (value < 1000) return String(Math.round(value))
  if (value < 10_000) return `${Math.round(value / 100) / 10}k`
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`
  return `${Math.round(value / 100_000) / 10}M`
}

/**
 * Render the token usage of one turn. Cache reads are reported separately because they measure
 * re-read context rather than newly billed prompt tokens.
 * @param usage - summed usage of the turn, or `undefined` when the turn reported none.
 * @returns the `{tokens}` text, or an empty string.
 */
function formatTokens(usage) {
  if (usage === null || typeof usage !== 'object') return ''
  const parts = []
  const input = compactCount(usage.input)
  const output = compactCount(usage.output)
  const cacheRead = compactCount(usage.cacheRead)
  if (input.length > 0) parts.push(`输入 ${input}`)
  if (output.length > 0) parts.push(`输出 ${output}`)
  if (cacheRead.length > 0) parts.push(`缓存 ${cacheRead}`)
  return parts.join(' · ')
}

/**
 * Add one assistant message's reported usage to the running total of its turn.
 * @param total - the session's running total, mutated in place.
 * @param usage - one `TokenUsage` value from the session log.
 * @returns nothing.
 */
function addUsage(total, usage) {
  if (usage === null || typeof usage !== 'object') return
  for (const [key, field] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cacheReadTokens'], ['cacheWrite', 'cacheWriteTokens']]) {
    const value = usage[field]
    if (typeof value === 'number' && Number.isFinite(value)) total[key] += value
  }
}

/**
 * Read the turn that just ended from the session log: its start time and the summed token usage of
 * its assistant responses. Reading the log keeps the numbers correct even when this plugin was
 * reloaded during the turn and therefore missed the live `turn/start` and `assistant/message`
 * events.
 * @param session - the session whose turn ended.
 * @param endSeq - the `turn/end` event's seq.
 * @returns the observed window, or `undefined` when the session cannot be read.
 */
function readTurnWindow(session, endSeq) {
  if (typeof session?.eventAt !== 'function' || typeof endSeq !== 'number') return undefined
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let text = ''
  for (let seq = endSeq - 1; seq >= 0; seq -= 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return undefined
    }
    if (event === undefined || event === null) continue
    if (event.type === 'turn/start') return { startedAt: event.time, usage, text }
    if (event.type === 'assistant/message') {
      addUsage(usage, event.data?.usage)
      // Walking backwards, the first message with text is the latest reply of the turn.
      if (text.length === 0) {
        const message = textOfMessage(event.data?.message)
        if (message.length > 0) text = message
      }
    }
  }
  return { startedAt: undefined, usage, text }
}

/**
 * Report whether a summed usage record carries any tokens.
 * @param usage - a summed usage record, or `undefined`.
 * @returns `true` when at least one counter is positive.
 */
function hasUsage(usage) {
  if (usage === undefined || usage === null || typeof usage !== 'object') return false
  return (usage.input + usage.output + usage.cacheRead + usage.cacheWrite) > 0
}

/**
 * Render the `{session}`, `{duration}`, `{reason}`, and `{tokens}` placeholders of one body
 * template, then drop separators left dangling by a value that is unavailable.
 * @param template - configured template.
 * @param values - replacement values, already human formatted.
 * @returns the rendered body.
 */
function renderBody(template, values) {
  return template
    .replaceAll('{session}', values.session)
    .replaceAll('{duration}', values.duration)
    .replaceAll('{reason}', values.reason)
    .replaceAll('{tokens}', values.tokens ?? '')
    .replace(/(\s*·\s*){2,}/gu, ' · ')
    .replace(/^\s*·\s*/u, '')
    .replace(/\s*·\s*$/u, '')
    .trim()
}

/**
 * Base64 a string as UTF-8 so an encoded PowerShell command stays pure ASCII.
 * @param value - any string.
 * @returns base64 text.
 */
function utf8Base64(value) {
  return Buffer.from(value, 'utf8').toString('base64')
}

/**
 * Quote one string for a single-quoted PowerShell literal.
 * @param value - any string.
 * @returns a body safe inside `'...'`.
 */
function psLiteral(value) {
  return value.replaceAll("'", "''")
}

/**
 * Build the encoded PowerShell program that shows one notification.
 * `auto` prefers a Windows toast under the configured AppUserModelID and falls back to a tray
 * balloon, because a process without package identity cannot always raise a toast. `toast` and
 * `balloon` pin one channel, which lets a user whose Windows settings hide one of them keep the
 * other. The program exits non-zero when the selected channel fails.
 * Exported so the encoded program can be inspected and exercised without touching the event feed.
 * @param payload - notification text and channel options.
 * @returns the UTF-16LE base64 command body for `-EncodedCommand`.
 */
export function buildWindowsCommand(payload) {
  const appId = psLiteral(payload.appId)
  const channel = payload.channel === 'toast' || payload.channel === 'balloon' ? payload.channel : 'auto'
  const tail = channel === 'balloon'
    ? 'try { Show-Balloon; exit 0 } catch { exit 1 }'
    : channel === 'toast'
      ? 'try { Show-Toast; exit 0 } catch { exit 1 }'
      : 'try { Show-Toast; exit 0 } catch { try { Show-Balloon; exit 0 } catch { exit 1 } }'
  const script = `
$ErrorActionPreference = 'Stop'
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${utf8Base64(payload.title)}'))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${utf8Base64(payload.body)}'))
$preview = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${utf8Base64(payload.preview)}'))
$appId = '${appId}'
$silent = $${payload.silent ? 'true' : 'false'}

function Esc([string] $value) { [System.Security.SecurityElement]::Escape($value) }

function Show-Toast {
  if ([string]::IsNullOrWhiteSpace($appId)) { throw 'no AppUserModelID configured' }
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $texts = '<text>' + (Esc $title) + '</text><text>' + (Esc $body) + '</text>'
  if ($preview) { $texts = $texts + '<text>' + (Esc $preview) + '</text>' }
  $audio = if ($silent) { '<audio silent="true"/>' } else { '' }
  $xml = '<toast scenario="default"><visual><binding template="ToastGeneric">' + $texts + '</binding></visual>' + $audio + '</toast>'
  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($xml)
  $notification = [Windows.UI.Notifications.ToastNotification]::new($document)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($notification)
}

function Show-Balloon {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
  $icon.BalloonTipTitle = $title
  $icon.BalloonTipText = if ($preview) { $body + ' ' + $preview } else { $body }
  $icon.Visible = $true
  $icon.ShowBalloonTip(10000)
  Start-Sleep -Milliseconds 4000
  $icon.Visible = $false
  $icon.Dispose()
}

${tail}
`
  return Buffer.from(script.replace(/^\n/u, ''), 'utf16le').toString('base64')
}

/**
 * Settle one spawned helper into a delivery observation, capped by {@link DELIVERY_TIMEOUT_MS}.
 * @param child - the spawned helper process.
 * @returns `ok`, or a failure description.
 */
function awaitDelivery(child) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => finish({ ok: false, message: 'helper did not finish in time' }), DELIVERY_TIMEOUT_MS)
    child.on('error', (error) => finish({ ok: false, message: error?.message ?? String(error) }))
    child.on('close', (code) => {
      finish(code === 0 ? { ok: true } : { ok: false, message: `helper exited with code ${code}` })
    })
  })
}

/**
 * Show one notification on the current platform.
 * The helper is deliberately not detached: Windows silently drops a toast raised from a detached
 * helper process (the call still succeeds), while a normal child inside the Host's process group
 * shows it. The caller awaits {@link awaitDelivery}, so the child keeps a handle until it exits.
 * @param payload - notification text and channel options.
 * @returns the delivery observation; an unsupported platform reports failure.
 */
function showNotification(payload) {
  const text = payload.preview.length > 0 ? `${payload.body}\n${payload.preview}` : payload.body
  try {
    if (process.platform === 'win32') {
      const child = spawn(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', buildWindowsCommand(payload)],
        { stdio: 'ignore', windowsHide: true },
      )
      return awaitDelivery(child)
    }
    if (process.platform === 'darwin') {
      const lines = [
        'on run argv',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        'end run',
      ]
      const child = spawn('osascript', [...lines.flatMap((line) => ['-e', line]), payload.title, text], {
        stdio: 'ignore',
      })
      return awaitDelivery(child)
    }
    if (process.platform === 'linux') {
      const child = spawn(
        'notify-send',
        ['--urgency=normal', '--app-name', 'DeepSeek Harness', payload.title, text],
        { stdio: 'ignore' },
      )
      return awaitDelivery(child)
    }
    return { ok: false, message: `no notification channel for platform ${process.platform}` }
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) }
  }
}

/**
 * Resolve the label that identifies one session in a notification body: its folded session title,
 * else its working-directory name, else a short id.
 * @param ctx - plugin context used to reach the optional title service.
 * @param session - the session whose turn ended.
 * @returns the label.
 */
function sessionLabel(ctx, session) {
  try {
    const titles = ctx.get('sessionTitle')
    const snapshot = titles?.get?.(session)
    const title = typeof snapshot?.title === 'string' ? snapshot.title.trim() : ''
    if (title.length > 0) return title
  } catch {}
  const directory = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
  const name = directory.length > 0 ? basename(directory) : ''
  if (name.length > 0 && name !== '.' && name !== '/') return name
  const id = typeof session?.id === 'string' ? session.id : ''
  return id.length > 0 ? `会话 ${id.slice(0, 8)}` : '当前会话'
}

/**
 * Register the notification feed and the `/notify-test` command.
 * @param ctx - plugin context.
 * @param rawConfig - the Loader row's `config`.
 * @returns nothing; every listener is disposed with the plugin.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  /** Session id → start time of the turn now running. */
  const turnStarts = new Map()
  /** Session id → last assistant text observed for that session. */
  const previews = new Map()
  /** Session id → summed token usage of the turn now running. */
  const turnUsage = new Map()

  const reportFailure = (error) => {
    try {
      console.error('[task-notify] notification channel failed:', error)
    } catch {}
  }

  const notify = async (payload) => {
    const result = await showNotification({
      ...payload,
      silent: config.silent,
      appId: config.windowsAppId,
      channel: config.windowsChannel,
    })
    if (!result.ok) reportFailure(result.message)
    return result
  }

  const describeTurn = (session, duration, kind, usage, fallbackText) => ({
    title: kind === 'completed'
      ? config.titleCompleted
      : kind === 'error'
        ? config.titleError
        : config.titleAborted,
    body: renderBody(config.bodyTemplate, {
      session: sessionLabel(ctx, session),
      duration: formatDuration(duration),
      reason: REASON_LABELS[kind] ?? REASON_LABELS.other,
      tokens: formatTokens(usage),
    }),
    preview: makePreview(previews.get(session?.id) ?? fallbackText ?? '', config.previewChars),
  })

  const onTurnEnd = (session, event) => {
    const kind = classifyReason(event?.data?.reason)
    if (kind === 'completed' && !config.notifyOnCompleted) return
    if (kind === 'error' && !config.notifyOnError) return
    if (kind === 'aborted' && !config.notifyOnAborted) return
    if (kind === 'other') return

    const header = session?.header
    if (!config.includeSubagents) {
      const isSubagent = header?.origin === 'subagent' || header?.parentSession !== undefined
      if (isSubagent) return
    }

    const sessionId = session?.id
    const endSeq = typeof event?.seq === 'number' ? event.seq : session?.seq
    const window = readTurnWindow(session, endSeq)
    const liveStarted = turnStarts.get(sessionId)
    const liveUsage = turnUsage.get(sessionId)
    turnStarts.delete(sessionId)
    turnUsage.delete(sessionId)

    const started = typeof window?.startedAt === 'number' ? window.startedAt : liveStarted
    const usage = hasUsage(window?.usage) ? window.usage : hasUsage(liveUsage) ? liveUsage : window?.usage
    const duration = typeof started === 'number' && typeof event.time === 'number' ? event.time - started : undefined
    if (duration !== undefined && duration < config.minDurationMs) return

    const payload = describeTurn(session, duration, kind, usage, window?.text)
    previews.delete(sessionId)
    notify(payload).catch(reportFailure)
  }

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      if (type === 'turn/start') {
        if (typeof event.time === 'number') turnStarts.set(session.id, event.time)
        turnUsage.set(session.id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
        return
      }
      if (type === 'assistant/message') {
        const text = textOfMessage(event?.data?.message)
        if (text.length > 0) previews.set(session.id, text)
        let usage = turnUsage.get(session.id)
        if (usage === undefined) {
          usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          turnUsage.set(session.id, usage)
        }
        addUsage(usage, event?.data?.usage)
        return
      }
      if (type === 'turn/end') onTurnEnd(session, event)
    } catch (error) {
      reportFailure(error)
    }
  })

  ctx.on('session/disposed', (session) => {
    turnStarts.delete(session?.id)
    previews.delete(session?.id)
    turnUsage.delete(session?.id)
  })

  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'notify-test',
      description: '发送一条测试系统通知',
      handler: async () => {
        const result = await notify({
          title: config.titleCompleted,
          body: renderBody(config.bodyTemplate, {
            session: '测试会话',
            duration: '1 秒',
            reason: REASON_LABELS.completed,
            tokens: formatTokens({ input: 18432, output: 1024, cacheRead: 496896, cacheWrite: 0 }),
          }),
          preview: makePreview('如果你看到这条通知，说明系统通知通道可用。', config.previewChars),
        })
        return result.ok
          ? { kind: 'success', text: '已请求发送系统通知，请确认它是否出现。' }
          : { kind: 'error', text: `系统通知发送失败：${result.message}` }
      },
    }))
  }
}
