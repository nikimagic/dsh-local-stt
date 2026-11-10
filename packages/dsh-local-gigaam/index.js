/**
 * Local GigaAM v3 provider for the official DeepSeek Harness speech-to-text
 * service. It registers next to SenseVoice and local-whisper, so the stock
 * Voice Input bundle owns the microphone, WAV capture and provider switcher.
 *
 * The provider spawns `gigastt serve`, posts the canonical 16 kHz mono PCM16 WAV
 * to /v1/transcribe, and returns the transcript object the official API expects.
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

export const name = 'dsh-local-gigaam'
export const inject = ['speechToText']

const VARIANTS = {
  rnnt: {
    model: 'gigaam-v3-rnnt',
    name: 'GigaAM v3 RNNT (локально)',
    languages: ['ru'],
  },
  e2e_rnnt: {
    model: 'gigaam-v3-e2e-rnnt',
    name: 'GigaAM v3 E2E RNNT (локально)',
    languages: ['ru'],
  },
  ml_ctc: {
    model: 'gigaam-multilingual-ctc',
    name: 'GigaAM Multilingual CTC (локально)',
    languages: ['auto', 'ru', 'en', 'kk', 'ky', 'uz'],
  },
  ml_ctc_large: {
    model: 'gigaam-multilingual-large-ctc',
    name: 'GigaAM Multilingual Large (локально)',
    languages: ['auto', 'ru', 'en', 'kk', 'ky', 'uz'],
  },
}

const DEFAULTS = {
  providerId: 'gigaam-local',
  providerName: '',
  gigasttBin: join(DSH_HOME, 'bin', 'gigastt', 'gigastt.exe'),
  modelDir: join(DSH_HOME, 'models', 'gigaam'),
  punctModelDir: join(DSH_HOME, 'models', 'gigaam', 'punct'),
  modelVariant: 'rnnt',
  port: 9876,
  poolSize: 1,
  punctuation: 'on',
  itn: 'on',
  hotwordsFile: '',
  autoStart: true,
  startupTimeoutMs: 180_000,
  requestTimeoutMs: 120_000,
  idleTimeoutMs: 0,
  maxPending: 4,
  extraArgs: [],
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
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

function absoluteDirectory(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${field} is not configured`
  }
  if (!isAbsolute(value)) return `${field} must be an absolute path: ${value}`
  if (!isDirectory(value)) return `${field} not found: ${value}`
  return null
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
  config.gigasttBin = String(config.gigasttBin || '').trim()
  config.modelDir = String(config.modelDir || '').trim()
  config.punctModelDir = String(config.punctModelDir || '').trim()
  config.modelVariant = String(config.modelVariant || 'rnnt').trim()
  if (!Object.hasOwn(VARIANTS, config.modelVariant)) {
    throw new Error(
      `modelVariant must be one of ${Object.keys(VARIANTS).join(', ')}: ${config.modelVariant}`,
    )
  }
  const variant = VARIANTS[config.modelVariant]
  config.providerName = String(config.providerName || variant.name).trim()
  config.port = Number(config.port)
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error(`port must be an integer from 1 to 65535: ${raw.port}`)
  }
  config.poolSize = Number(config.poolSize)
  if (!Number.isInteger(config.poolSize) || config.poolSize < 1) {
    throw new Error('poolSize must be a positive integer')
  }
  for (const field of ['startupTimeoutMs', 'requestTimeoutMs', 'idleTimeoutMs']) {
    config[field] = Number(config[field])
    if (!Number.isFinite(config[field]) || config[field] < 0) {
      throw new Error(`${field} must be a non-negative number`)
    }
  }
  config.maxPending = Number(config.maxPending)
  if (!Number.isInteger(config.maxPending) || config.maxPending < 1) {
    throw new Error('maxPending must be a positive integer')
  }
  config.punctuation = String(config.punctuation || 'on').trim()
  if (!['on', 'off', 'auto'].includes(config.punctuation)) {
    throw new Error(`punctuation must be on, off or auto: ${config.punctuation}`)
  }
  config.itn = String(config.itn || 'on').trim()
  if (!['on', 'off', 'auto'].includes(config.itn)) {
    throw new Error(`itn must be on, off or auto: ${config.itn}`)
  }
  config.hotwordsFile = String(config.hotwordsFile || '').trim()
  config.autoStart = Boolean(config.autoStart)
  config.extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs.map(String) : []
  return config
}

class LocalGigaamProvider {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.variant = VARIANTS[config.modelVariant]
    this.listeners = new Set()
    this.child = null
    this.starting = null
    this.ready = false
    this.logPath = join(
      tmpdir(),
      `dsh-local-gigaam-${process.pid}-${config.port}.log`,
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
        this.ctx.logger?.warn?.('dsh-local-gigaam: state listener failed', error)
      }
    }
  }

  fileProblem() {
    const binary = absoluteFile(this.config.gigasttBin, 'gigasttBin')
    if (binary) return binary
    const model = absoluteDirectory(this.config.modelDir, 'modelDir')
    if (model) return model
    if (
      this.config.punctModelDir &&
      !isAbsolute(this.config.punctModelDir)
    ) {
      return `punctModelDir must be an absolute path: ${this.config.punctModelDir}`
    }
    if (
      this.config.hotwordsFile &&
      absoluteFile(this.config.hotwordsFile, 'hotwordsFile')
    ) {
      return absoluteFile(this.config.hotwordsFile, 'hotwordsFile')
    }
    return null
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
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger?.warn?.(`dsh-local-gigaam: ${message}`)
        this.publish({ phase: 'failed', message })
      })
    }
  }

  async prepare() {
    await this.inspect()
    if (this.state.phase !== 'ready') return
    try {
      await this.startServer()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.publish({ phase: 'failed', message })
    }
  }

  async cancel() {
    await this.starting?.catch(() => {})
  }

  serverBase() {
    return `http://127.0.0.1:${this.config.port}`
  }

  async healthProbe() {
    try {
      const response = await fetch(`${this.serverBase()}/health`, {
        signal: timeoutSignal(2_000),
      })
      if (!response.ok) return null
      const payload = await response.json()
      return payload && typeof payload.status === 'string' ? payload : null
    } catch {
      return null
    }
  }

  async readyProbe() {
    try {
      const response = await fetch(`${this.serverBase()}/ready`, {
        signal: timeoutSignal(2_000),
      })
      if (!response.ok) return false
      const payload = await response.json()
      return payload?.status === 'ready'
    } catch {
      return false
    }
  }

  compatibility(health) {
    if (!health) return 'absent'
    if (health.model === 'loading') return 'loading'
    if (health.model === this.variant.model) return 'ours'
    return 'foreign'
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
    if (this.disposed) throw new Error('GigaAM provider is disposed')
    if (this.ready && (await this.readyProbe())) return
    if (this.starting) return await this.starting
    this.starting = this.launchServer()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  async waitReady(child) {
    const deadline = Date.now() + this.config.startupTimeoutMs
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('GigaAM provider is disposed')
      if (child && child.exitCode !== null) {
        throw new Error(`gigastt exited during startup: ${this.logTail()}`)
      }
      if (await this.readyProbe()) {
        this.ready = true
        this.publish({ phase: 'ready' })
        this.ctx.logger?.info?.('dsh-local-gigaam: gigastt is ready')
        return
      }
      const health = await this.healthProbe()
      if (health && this.compatibility(health) === 'foreign') {
        throw new Error(
          `port ${this.config.port} is occupied by ${health.model} (expected ${this.variant.model})`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    this.stopChild()
    throw new Error(
      `gigastt did not become ready within ${this.config.startupTimeoutMs} ms: ${this.logTail()}`,
    )
  }

  async launchServer() {
    const problem = this.fileProblem()
    if (problem) throw new Error(problem)

    const health = await this.healthProbe()
    const compatibility = this.compatibility(health)
    if (compatibility === 'foreign') {
      throw new Error(
        `port ${this.config.port} is occupied by ${health.model} (expected ${this.variant.model})`,
      )
    }
    if (compatibility !== 'absent') {
      await this.waitReady(null)
      return
    }

    await this.stopChildAndWait()

    const args = [
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      String(this.config.port),
      '--model-dir',
      this.config.modelDir,
      '--model-variant',
      this.config.modelVariant,
      '--pool-size',
      String(this.config.poolSize),
      '--punctuation',
      this.config.punctuation,
      '--itn',
      this.config.itn,
      '--inference-timeout-secs',
      String(Math.max(1, Math.ceil(this.config.requestTimeoutMs / 1000))),
      ...this.config.punctModelDir
        ? ['--punct-model-dir', this.config.punctModelDir]
        : [],
      ...this.config.hotwordsFile
        ? ['--hotwords-file', this.config.hotwordsFile]
        : [],
      ...this.config.extraArgs,
    ]
    this.ctx.logger?.info?.(
      `dsh-local-gigaam: starting ${this.config.gigasttBin} on ${this.serverBase()}`,
    )
    writeFileSync(this.logPath, '')
    const logFd = openSync(this.logPath, 'a')
    let child
    try {
      child = spawn(this.config.gigasttBin, args, {
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
      this.ctx.logger?.warn?.(
        `dsh-local-gigaam: gigastt failed to start: ${error.message}`,
      )
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null
        this.ready = false
      }
      if (this.expectedExits.delete(child)) return
      if (this.disposed) return
      const message = `gigastt exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}): ${this.logTail()}`
      this.ctx.logger?.warn?.(`dsh-local-gigaam: ${message}`)
      this.publish({ phase: 'failed', message })
    })
    await this.waitReady(child)
  }

  async ensureServer(signal) {
    if (this.disposed) throw new Error('GigaAM provider is disposed')
    if (this.ready && (await this.readyProbe())) return
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

  async request(audio, signal) {
    if (!(audio instanceof Uint8Array) || audio.byteLength < 46) {
      throw new Error('GigaAM provider received invalid audio')
    }
    const combined = combineSignals([signal, timeoutSignal(this.config.requestTimeoutMs)])
    const startedAt = performance.now()
    const response = await fetch(`${this.serverBase()}/v1/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: audio,
      signal: combined,
    })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(
        `gigastt HTTP ${response.status}: ${body.slice(0, 500).trim()}`,
      )
    }
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      throw new Error(`gigastt returned invalid JSON: ${body.slice(0, 300)}`)
    }
    if (typeof payload?.text !== 'string') {
      throw new Error('gigastt response has no text field')
    }
    const computedAudioSeconds = Math.max(0, (audio.byteLength - 44) / 32_000)
    return {
      text: cleanTranscript(payload.text),
      audioSeconds:
        typeof payload.duration === 'number' && payload.duration >= 0
          ? payload.duration
          : computedAudioSeconds,
      inferenceSeconds: Math.max(0, (performance.now() - startedAt) / 1000),
    }
  }

  async transcribe(input, signal) {
    if (this.disposed) throw new Error('GigaAM provider is disposed')
    const combined = combineSignals([signal, this.lifetime.signal])
    combined.throwIfAborted()

    if (this.pending >= this.config.maxPending) {
      throw new Error('GigaAM transcription queue is full')
    }
    this.pending += 1
    const run = this.tail.then(async () => {
      combined.throwIfAborted()
      await this.ensureServer(combined)
      return await this.request(input.audio, combined)
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
      void this.stopChildAndWait()
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
      // The process may have exited between the check and kill.
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
    this.lifetime.abort(new Error('GigaAM provider disposed'))
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
 * Register the local GigaAM recognizer next to SenseVoice and local-whisper.
 * @param ctx - Host context with the speechToText service.
 * @param rawConfig - profile override; paths are absolute local files.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const provider = new LocalGigaamProvider(ctx, config)

  ctx.effect(() => {
    const unregister = ctx.speechToText.register({
      info: {
        id: config.providerId,
        name: config.providerName,
        location: 'host-local',
        languages: VARIANTS[config.modelVariant].languages,
        downloadSources: [],
        setupEstimate: {
          recommendedDiskBytes: 320 * 1024 * 1024,
          expectedMemoryBytes: 800 * 1024 * 1024,
          minimumMinutes: 1,
          maximumMinutes: 10,
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

export { LocalGigaamProvider, VARIANTS, normalizeConfig }
