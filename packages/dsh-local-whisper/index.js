/**
 * Local whisper.cpp provider for the official DeepSeek Harness speech-to-text
 * service. It registers next to `sensevoice-local`, so the stock Voice Input
 * bundle owns the microphone, WAV capture, settings, and provider switcher.
 *
 * The provider deliberately has no runtime dependencies outside Node built-ins:
 * it spawns `whisper-server`, posts the canonical 16 kHz mono PCM16 WAV that the
 * official API already produced, and returns the transcript.
 */
import { spawn } from 'node:child_process'
import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const DSH_HOME = join(homedir(), '.dsh')

export const name = 'dsh-local-whisper'
export const inject = ['speechToText']

/** Language hints exposed in the official Voice Input dropdown. */
const LANGUAGES = [
  'auto',
  'ru',
  'en',
  'uk',
  'de',
  'fr',
  'es',
  'it',
  'pl',
  'pt',
  'tr',
  'zh',
  'yue',
  'ja',
  'ko',
]

const DEFAULTS = {
  providerId: 'local-whisper',
  providerName: 'Whisper large-v3-turbo q5_0 (local)',
  whisperBin: join(DSH_HOME, 'bin', 'whisper', 'whisper-server.exe'),
  whisperModel: join(DSH_HOME, 'models', 'ggml-large-v3-turbo-q5_0.bin'),
  host: '127.0.0.1',
  port: 8001,
  threads: 8,
  processors: 1,
  autoStart: true,
  startupTimeoutMs: 120_000,
  requestTimeoutMs: 120_000,
  idleTimeoutMs: 0,
  maxPending: 4,
  initialPrompt: '',
  extraArgs: [],
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function absoluteFile(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${field} is not configured`
  }
  if (!isAbsolute(value)) return `${field} must be an absolute path: ${value}`
  if (!isFile(value)) return `${field} not found: ${value}`
  return null
}

function normalizeLanguage(value) {
  const language = String(value || 'auto').trim().toLowerCase()
  if (language === 'yue') return 'zh'
  return LANGUAGES.includes(language) ? language : 'auto'
}

function combineSignals(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  const abort = (signal) => controller.abort(signal.reason)
  for (const signal of signals) {
    if (signal.aborted) {
      abort(signal)
      break
    }
    signal.addEventListener('abort', () => abort(signal), { once: true })
  }
  return controller.signal
}

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timed out')), ms)
  timer.unref?.()
  return controller.signal
}

function cleanTranscript(value) {
  let text = String(value ?? '').trim()
  text = text
    .replace(/\[(?:blank_audio|silence|music|noise|applause|inaudible)\]/gi, ' ')
    .replace(/\((?:silence|music|noise|applause|inaudible)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text
}

function normalizeConfig(raw = {}) {
  const config = { ...DEFAULTS, ...raw }
  config.providerId = String(config.providerId || DEFAULTS.providerId).trim()
  config.providerName = String(config.providerName || DEFAULTS.providerName).trim()
  config.whisperBin = String(config.whisperBin || '').trim()
  config.whisperModel = String(config.whisperModel || '').trim()
  config.host = '127.0.0.1'
  config.port = Number(config.port)
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`port must be an integer from 1 to 65535: ${raw.port}`)
  }
  for (const field of ['threads', 'processors', 'maxPending']) {
    config[field] = Number(config[field])
    if (!Number.isInteger(config[field]) || config[field] < 1) {
      throw new Error(`${field} must be a positive integer`)
    }
  }
  for (const field of ['startupTimeoutMs', 'requestTimeoutMs', 'idleTimeoutMs']) {
    config[field] = Number(config[field])
    if (!Number.isFinite(config[field]) || config[field] < 0) {
      throw new Error(`${field} must be a non-negative number`)
    }
  }
  config.autoStart = Boolean(config.autoStart)
  config.initialPrompt = String(config.initialPrompt || '').trim()
  config.extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs.map(String) : []
  return config
}

class LocalWhisperProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.listeners = new Set()
    this.child = null
    this.starting = null
    this.ready = false
    this.serverError = ''
    this.logPath = join(
      tmpdir(),
      `dsh-local-whisper-${process.pid}-${config.port}.log`,
    )
    this.state = {
      phase: 'checking',
      steps: [{ kind: 'check', status: 'running', startedAt: Date.now() }],
    }
    this.disposed = false
    this.lifetime = new AbortController()
    this.tail = Promise.resolve()
    this.pending = 0
    this.idleTimer = null
    this.lastUsed = 0
    this.expectedExits = new WeakSet()
  }

  snapshot() {
    return this.state
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(state) {
    if (this.disposed) return
    this.state = state
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.ctx.logger?.warn?.('dsh-local-whisper: state listener failed', error)
      }
    }
  }

  fileProblem() {
    return (
      absoluteFile(this.config.whisperBin, 'whisperBin') ||
      absoluteFile(this.config.whisperModel, 'whisperModel')
    )
  }

  async inspect() {
    if (this.disposed) return
    this.publish({
      phase: 'checking',
      steps: [{ kind: 'check', status: 'running', startedAt: Date.now() }],
    })
    const problem = this.fileProblem()
    if (problem) {
      this.publish({
        phase: 'failed',
        message: problem,
        steps: [{ kind: 'check', status: 'failed', startedAt: Date.now() }],
      })
      return
    }
    this.publish({
      phase: 'ready',
      steps: [{ kind: 'check', status: 'complete', startedAt: Date.now() }],
    })
    if (this.config.autoStart) {
      this.startServer().catch((error) => {
        this.serverError = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn?.(`dsh-local-whisper: ${this.serverError}`)
        this.publish({ phase: 'failed', message: this.serverError })
      })
    }
  }

  async prepare() {
    await this.inspect()
    if (this.state.phase !== 'ready') return
    try {
      await this.startServer()
    } catch (error) {
      this.serverError = error instanceof Error ? error.message : String(error)
      this.publish({ phase: 'failed', message: this.serverError })
    }
  }

  async cancel() {
    // Preparation only checks local files and starts the local server; there is
    // no download to cancel. Waiting for a spawn that is already in flight keeps
    // the service contract honest without killing a working server.
    await this.starting?.catch(() => {})
  }

  serverBase() {
    return `http://${this.config.host}:${this.config.port}`
  }

  async health() {
    try {
      const response = await fetch(`${this.serverBase()}/`, {
        signal: timeoutSignal(2_000),
      })
      if (!response.ok) return false
      const body = await response.text()
      return body.includes('Whisper.cpp Server') || body.includes('whisper.cpp')
    } catch {
      return false
    }
  }

  logTail() {
    try {
      const text = readFileSync(this.logPath, 'utf8')
      return text.trim().split(/\r?\n/).slice(-8).join(' | ').slice(0, 1_200)
    } catch {
      return ''
    }
  }

  async startServer() {
    if (this.disposed) throw new Error('Whisper provider is disposed')
    if (this.ready && (await this.health())) return
    if (this.starting) return await this.starting
    this.starting = this.launchServer()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  async launchServer() {
    const problem = this.fileProblem()
    if (problem) throw new Error(problem)
    if (await this.health()) {
      this.ready = true
      this.serverError = ''
      this.publish({ phase: 'ready' })
      return
    }
    await this.stopChildAndWait()

    const args = [
      '-m',
      this.config.whisperModel,
      '--host',
      this.config.host,
      '--port',
      String(this.config.port),
      '-t',
      String(this.config.threads),
      '-p',
      String(this.config.processors),
      '-l',
      'auto',
      ...this.config.extraArgs,
    ]
    this.ctx.logger?.info?.(
      `dsh-local-whisper: starting ${this.config.whisperBin} on ${this.serverBase()}`,
    )
    writeFileSync(this.logPath, '')
    const logFd = openSync(this.logPath, 'a')
    let child
    try {
      child = spawn(this.config.whisperBin, args, {
        windowsHide: true,
        // Piped stdio would ask the DSH Windows sandbox for a named pipe and
        // fail with EPERM. A regular log file keeps diagnostics without pipes.
        stdio: ['ignore', logFd, logFd],
      })
    } finally {
      closeSync(logFd)
    }
    this.child = child
    child.on('error', (error) => {
      this.serverError = `whisper-server failed to start: ${error.message}`
      this.ctx.logger?.warn?.(`dsh-local-whisper: ${this.serverError}`)
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null
        this.ready = false
      }
      if (this.expectedExits.delete(child)) return
      if (this.disposed) return
      this.serverError = `whisper-server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}): ${this.logTail()}`
      this.ctx.logger?.warn?.(`dsh-local-whisper: ${this.serverError}`)
      this.publish({ phase: 'failed', message: this.serverError })
    })

    const deadline = Date.now() + this.config.startupTimeoutMs
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('Whisper provider is disposed')
      if (child.exitCode !== null) {
        throw new Error(`whisper-server exited during startup: ${this.logTail()}`)
      }
      if (await this.health()) {
        this.ready = true
        this.serverError = ''
        this.publish({ phase: 'ready' })
        this.ctx.logger?.info?.('dsh-local-whisper: whisper-server is ready')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    this.stopChild()
    throw new Error(
      `whisper-server did not become ready within ${this.config.startupTimeoutMs} ms: ${this.logTail()}`,
    )
  }

  async ensureServer(signal) {
    if (this.disposed) throw new Error('Whisper provider is disposed')
    if (this.ready && (await this.health())) return
    const start = this.startServer()
    let onAbort
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(signal.reason ?? new Error('cancelled'))
      if (signal.aborted) {
        fail()
        return
      }
      onAbort = fail
      signal.addEventListener('abort', fail, { once: true })
    })
    try {
      await Promise.race([start, aborted])
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }

  async request(audio, language, signal) {
    if (!(audio instanceof Uint8Array) || audio.byteLength < 46) {
      throw new Error('Whisper provider received invalid audio')
    }
    const form = new FormData()
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav')
    form.append('response_format', 'json')
    form.append('language', language)
    form.append('temperature', '0')
    if (this.config.initialPrompt) form.append('prompt', this.config.initialPrompt)

    const combined = combineSignals([signal, timeoutSignal(this.config.requestTimeoutMs)])
    const startedAt = performance.now()
    const response = await fetch(`${this.serverBase()}/inference`, {
      method: 'POST',
      body: form,
      signal: combined,
    })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(
        `whisper-server HTTP ${response.status}: ${body.slice(0, 500).trim()}`,
      )
    }
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      throw new Error(`whisper-server returned invalid JSON: ${body.slice(0, 300)}`)
    }
    if (typeof payload?.text !== 'string') {
      throw new Error('whisper-server response has no text field')
    }
    // The official API and client require this exact result shape; returning a
    // bare string makes the client call `result.text.replace(...)` on undefined.
    return {
      text: cleanTranscript(payload.text),
      audioSeconds: Math.max(0, (audio.byteLength - 44) / 32_000),
      inferenceSeconds: Math.max(0, (performance.now() - startedAt) / 1000),
    }
  }

  async transcribe(input, signal) {
    if (this.disposed) throw new Error('Whisper provider is disposed')
    const language = normalizeLanguage(input?.language ?? this.config.language)
    const combined = combineSignals([signal, this.lifetime.signal])
    combined.throwIfAborted()

    if (this.pending >= this.config.maxPending) {
      throw new Error('Whisper transcription queue is full')
    }
    this.pending += 1
    const run = this.tail.then(async () => {
      combined.throwIfAborted()
      await this.ensureServer(combined)
      this.lastUsed = Date.now()
      return await this.request(input.audio, language, combined)
    })
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    try {
      return await run
    } finally {
      this.pending -= 1
      this.scheduleIdleStop()
    }
  }

  scheduleIdleStop() {
    if (this.config.idleTimeoutMs <= 0 || this.pending > 0 || this.disposed) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.stopChild()
    }, this.config.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  stopChild() {
    clearTimeout(this.idleTimer)
    this.idleTimer = null
    const child = this.child
    this.child = null
    this.ready = false
    if (!child || child.exitCode !== null) return null
    this.expectedExits.add(child)
    try {
      child.kill()
    } catch {
      // The process may have exited between the check and kill; exit handler
      // clears the remaining state.
    }
    return child
  }

  async stopChildAndWait(timeoutMs = 2_000) {
    const child = this.stopChild()
    if (!child) return
    await Promise.race([
      new Promise((resolve) => {
        if (child.exitCode !== null) resolve()
        else child.once('exit', resolve)
      }),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(new Error('Whisper provider disposed'))
    this.listeners.clear()
    await this.stopChildAndWait()
    try {
      await this.tail
    } catch {
      // Pending work was aborted above; disposal must not reject.
    }
  }
}

/**
 * Register the local Whisper recognizer next to the stock SenseVoice provider.
 * @param ctx - Host context with the speechToText service.
 * @param rawConfig - profile override; paths are absolute local files.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const provider = new LocalWhisperProvider(ctx, config)

  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: {
        id: config.providerId,
        name: config.providerName,
        location: 'host-local',
        languages: LANGUAGES,
        downloadSources: [],
        setupEstimate: {
          recommendedDiskBytes: 640 * 1024 * 1024,
          expectedMemoryBytes: 1536 * 1024 * 1024,
          minimumMinutes: 1,
          maximumMinutes: 15,
        },
      },
      preparation: provider,
      transcribe: async (input, signal) => await provider.transcribe(input, signal),
    })
    void provider.inspect()
    return async () => {
      await provider.dispose()
      await unregister()
    }
  })
}

export { LocalWhisperProvider, LANGUAGES, normalizeConfig }
