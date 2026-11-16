/**
 * Локальный ASR для официального голосового ввода DSH.
 *
 * Провайдеры не держат серверы в фоне. При первом распознавании плагин
 * запускает нужный лаунчер, ждёт готовности, отправляет WAV и останавливает
 * сервер, если запускал его сам.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-local-stt'
export const inject = ['speechToText']

const ROOT = String(process.env.DSH_LOCAL_STT_ROOT || 'C:\\Users\\admin\\Downloads\\dsh_voice').replace(/\\+$/, '')
const DEFAULT_WHISPER = {
  baseUrl: 'http://127.0.0.1:52626',
  model: 'whisper-v3:turbo',
  language: 'ru',
  requestTimeoutMs: 120_000,
  command: `${ROOT}\\flm\\app\\flm.exe`,
  args: ['serve', '--asr', 'whisper-v3:turbo', '--host', '127.0.0.1', '--port', '{port}'],
  cwd: `${ROOT}\\flm\\app`,
  env: { FLM_MODEL_PATH: `${ROOT}\\flm\\models` },
  modelPath: `${ROOT}\\flm\\models\\models\\Whisper-V3-Turbo-NPU2\\model.q4nx`,
  autoStart: true,
  startupTimeoutMs: 90_000,
}
const DEFAULT_ORUKEET = {
  baseUrl: 'http://127.0.0.1:8028',
  model: 'orukeet_q8_0',
  language: 'ru',
  requestTimeoutMs: 120_000,
  command: `${ROOT}\\tts_cpp\\bin\\audio.cpp\\audiocpp_server.exe`,
  args: [
    '--config',
    `${ROOT}\\tts_cpp\\config\\audio-vulkan.json`,
    '--host',
    '127.0.0.1',
    '--port',
    '{port}',
    '--no-ui',
    '--log',
    '--log-file',
    `${ROOT}\\tts_cpp\\logs\\audio-vulkan\\plugin.log`,
  ],
  cwd: `${ROOT}\\tts_cpp`,
  env: {
    TEMP: `${ROOT}\\tts_cpp\\temp`,
    TMP: `${ROOT}\\tts_cpp\\temp`,
    OMP_NUM_THREADS: '8',
  },
  modelPath: `${ROOT}\\tts_cpp\\models\\audio.cpp\\Orukeet-GGUF\\orukeet-q8_0.gguf`,
  autoStart: true,
  startupTimeoutMs: 120_000,
}

function combineSignals(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms)
  timer.unref?.()
  return controller.signal
}

function normalizeEndpoint(raw, fallback) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const baseUrl = String(value.baseUrl || fallback.baseUrl).trim().replace(/\/+$/, '')
  const model = String(value.model || fallback.model).trim()
  const language = String(value.language || fallback.language).trim()
  const requestTimeoutMs = Number(value.requestTimeoutMs ?? fallback.requestTimeoutMs)
  const launcher = String(value.launcher ?? fallback.launcher ?? '').trim()
  const launcherArgs = Array.isArray(value.launcherArgs)
    ? value.launcherArgs.map((arg) => String(arg))
    : fallback.launcherArgs
  const command = String(value.command ?? fallback.command ?? '').trim()
  const args = Array.isArray(value.args) ? value.args.map((arg) => String(arg)) : fallback.args ?? []
  const cwd = String(value.cwd ?? fallback.cwd ?? '').trim()
  const rawEnv = value.env && typeof value.env === 'object' ? value.env : fallback.env ?? {}
  const env = Object.fromEntries(Object.entries(rawEnv).map(([key, item]) => [String(key), String(item)]))
  const modelPath = String(value.modelPath ?? fallback.modelPath ?? '').trim()
  const autoStart = value.autoStart !== false
  const startupTimeoutMs = Number(value.startupTimeoutMs ?? fallback.startupTimeoutMs)
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`Некорректный baseUrl: ${baseUrl}`)
  if (!model) throw new Error('Не задана модель')
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('Некорректный requestTimeoutMs')
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs < 1) throw new Error('Некорректный startupTimeoutMs')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error(`Некорректный baseUrl: ${baseUrl}`)
  }
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  return {
    baseUrl,
    port,
    model,
    language,
    requestTimeoutMs,
    launcher,
    launcherArgs,
    command,
    args,
    cwd,
    env,
    modelPath,
    autoStart,
    startupTimeoutMs,
  }
}

function audioSeconds(audio) {
  try {
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
    if (
      audio.byteLength >= 44 &&
      view.getUint32(0, true) === 0x46464952 &&
      view.getUint32(8, true) === 0x45564157 &&
      view.getUint32(12, true) === 0x20746d66
    ) {
      const channels = view.getUint16(22, true) || 1
      const sampleRate = view.getUint32(24, true) || 16_000
      const bits = view.getUint16(34, true) || 16
      const bytesPerSecond = sampleRate * channels * (bits / 8)
      return Math.max(0, (audio.byteLength - 44) / bytesPerSecond)
    }
  } catch {
    // Ниже — запасной расчёт для канонического 16-кГц WAV.
  }
  return Math.max(0, (audio.byteLength - 44) / 32_000)
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(-1)
    let settled = false
    let timer
    let child
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(code)
    }
    try {
      child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      finish(-1)
      return
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Процесс уже завершился.
      }
      finish(-1)
    }, 8_000)
    child.on('exit', (code) => finish(code ?? -1))
    child.on('error', () => finish(-1))
  })
}

class HttpSpeechProvider {
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.listeners = new Set()
    this.state = {
      phase: 'checking',
      steps: [{ kind: 'check', status: 'running', startedAt: Date.now() }],
    }
    this.checking = null
    this.starting = null
    this.ownedProcess = null
    this.childExited = false
    this.disposed = false
    this.lifetime = new AbortController()
    this.queue = []
    this.active = null
    this.pidFile = join(tmpdir(), `dsh-local-stt-${options.kind}.pid`)
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
        this.ctx.logger?.warn?.(`dsh-local-stt: listener failed`, error)
      }
    }
  }

  standby() {
    return {
      phase: 'standby',
      steps: [{ kind: 'check', status: 'complete', startedAt: Date.now() }],
    }
  }

  ready() {
    return {
      phase: 'ready',
      steps: [{ kind: 'load', status: 'complete', startedAt: Date.now() }],
    }
  }

  failure(message) {
    return {
      phase: 'failed',
      message,
      steps: [{ kind: 'check', status: 'failed', startedAt: Date.now() }],
    }
  }

  initialise() {
    try {
      this.preflight()
      this.publish(this.standby())
      void this.cleanupStale()
    } catch (error) {
      this.publish(this.failure(error instanceof Error ? error.message : String(error)))
    }
  }

  writePid(pid) {
    try {
      writeFileSync(this.pidFile, String(pid), 'utf8')
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-local-stt: не удалось записать PID: ${error instanceof Error ? error.message : error}`)
    }
  }

  clearPid() {
    try {
      unlinkSync(this.pidFile)
    } catch {
      // PID-файла уже нет.
    }
  }

  async cleanupStale() {
    let pid = 0
    try {
      pid = Number(readFileSync(this.pidFile, 'utf8').trim())
    } catch {
      return
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      this.clearPid()
      return
    }

    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }

    if (alive && (await this.probe())) {
      await killTree(pid)
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 300))
        if (!(await this.probe())) break
      }
    }

    if (!alive || !(await this.probe())) this.clearPid()
  }

  preflight() {
    const executable = this.options.command || this.options.launcher
    if (executable && !existsSync(executable)) {
      throw new Error(`Исполняемый файл не найден: ${executable}`)
    }
    if (this.options.modelPath && !existsSync(this.options.modelPath)) {
      throw new Error(`Файл модели не найден: ${this.options.modelPath}`)
    }
  }

  async probe() {
    try {
      const healthResponse = await fetch(`${this.options.baseUrl}${this.options.healthPath}`, {
        signal: timeoutSignal(2_000),
      })
      if (!healthResponse.ok) throw new Error(`HTTP ${healthResponse.status}`)
      const health = await healthResponse.json()

      if (this.options.kind === 'whisper') {
        const rows = Array.isArray(health?.data) ? health.data : []
        if (!rows.some((row) => String(row?.owned_by || '').toLowerCase().includes('fastflow'))) {
          throw new Error('на порту не FastFlowLM')
        }
        return true
      }

      if (health?.status !== 'ok' || health?.backend !== 'vulkan') {
        throw new Error('audio.cpp не в состоянии ready/vulkan')
      }
      const modelsResponse = await fetch(`${this.options.baseUrl}/v1/models`, { signal: timeoutSignal(2_000) })
      if (!modelsResponse.ok) throw new Error(`models HTTP ${modelsResponse.status}`)
      const models = await modelsResponse.json()
      const rows = Array.isArray(models?.data) ? models.data : []
      if (!rows.some((row) => row?.id === this.options.model)) {
        throw new Error(`в audio.cpp нет модели ${this.options.model}`)
      }
      return true
    } catch (error) {
      this.lastProbeError = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  async launch() {
    if (this.ownedProcess) return
    this.preflight()

    if (this.options.command) {
      if (!existsSync(this.options.command)) throw new Error(`Исполняемый файл не найден: ${this.options.command}`)
      const args = this.options.args.map((arg) => arg.replaceAll('{port}', this.options.port))
      await new Promise((resolve, reject) => {
        const child = spawn(this.options.command, args, {
          cwd: this.options.cwd || undefined,
          env: { ...process.env, ...this.options.env },
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
        })
        child.once('spawn', () => {
          this.childExited = false
          this.ownedProcess = child
          this.writePid(child.pid)
          child.once('exit', () => {
            this.childExited = true
            if (this.ownedProcess === child) this.ownedProcess = null
          })
          child.unref()
          resolve()
        })
        child.once('error', reject)
      })
      return
    }

    if (!this.options.launcher) throw new Error('Не настроены command или launcher')
    if (!existsSync(this.options.launcher)) throw new Error(`Лаунчер не найден: ${this.options.launcher}`)
    const quoted = this.options.launcherArgs.map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(' ')
    const commandLine = `"${this.options.launcher}"${quoted ? ` ${quoted}` : ''}`
    await new Promise((resolve, reject) => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
        cwd: dirname(this.options.launcher),
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      })
      child.once('spawn', () => {
        this.ownedProcess = child
        child.unref()
        resolve()
      })
      child.once('error', reject)
    })
  }

  async startServer(signal) {
    if (await this.probe()) {
      this.publish(this.ready())
      return false
    }

    if (!this.options.autoStart) throw new Error(`${this.options.label} не запущен`)
    this.preflight()
    this.publish({
      phase: 'checking',
      message: `Запускаю ${this.options.label}…`,
      steps: [{ kind: 'load', status: 'running', startedAt: Date.now() }],
    })

    try {
      await this.launch()
      const deadline = Date.now() + this.options.startupTimeoutMs
      while (!this.disposed && Date.now() < deadline) {
        signal.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        if (this.childExited) {
          throw new Error('сервер завершился сразу после запуска; смотрите plugin.log')
        }
        if (await this.probe()) {
          this.publish(this.ready())
          return true
        }
      }
      throw new Error(`сервер не поднялся за ${Math.round(this.options.startupTimeoutMs / 1000)} с`)
    } catch (error) {
      await this.stopOwned()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`${this.options.label}: ${reason}. ${this.options.startHint}`)
    }
  }

  async stopOwned() {
    const child = this.ownedProcess
    this.ownedProcess = null
    if (!child?.pid) {
      this.clearPid()
      return
    }

    await killTree(child.pid)
    let stopped = false
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (!(await this.probe())) {
        stopped = true
        break
      }
    }

    if (!stopped) {
      await killTree(child.pid)
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (!(await this.probe())) {
          stopped = true
          break
        }
      }
    }

    if (stopped) {
      this.clearPid()
      this.publish(this.standby())
      return
    }

    const message = `${this.options.label}: процесс не остановился, порт ${this.options.port} всё ещё отвечает`
    this.ctx.logger?.warn?.(`dsh-local-stt: ${message}`)
    this.publish(this.failure(message))
  }

  async prepare() {
    this.initialise()
  }

  async cancel() {
    if (!this.ownedProcess) return
    await this.stopOwned()
  }

  enqueue(task, signal) {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('Провайдер остановлен'))
        return
      }
      if (signal.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Запрос отменён'))
        return
      }

      const entry = { task, signal, resolve, reject, started: false, cleanup: null }
      const onAbort = () => {
        if (entry.started) return
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        entry.cleanup?.()
        reject(signal.reason instanceof Error ? signal.reason : new Error('Запрос отменён'))
      }
      entry.cleanup = () => signal.removeEventListener('abort', onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
      this.pump()
    })
  }

  pump() {
    if (this.active || this.disposed) return
    const entry = this.queue.shift()
    if (!entry) return

    if (entry.signal.aborted) {
      entry.cleanup?.()
      entry.reject(entry.signal.reason instanceof Error ? entry.signal.reason : new Error('Запрос отменён'))
      this.pump()
      return
    }

    entry.started = true
    this.active = entry
    Promise.resolve()
      .then(() => entry.task())
      .then(entry.resolve, entry.reject)
      .finally(() => {
        entry.cleanup?.()
        if (this.active === entry) this.active = null
        this.pump()
      })
  }

  async transcribe(input, signal) {
    if (this.disposed) throw new Error('Провайдер остановлен')
    const combined = combineSignals([signal, this.lifetime.signal])
    combined.throwIfAborted()
    const language = String(input?.language || this.options.language || 'ru').trim()

    return await this.enqueue(async () => {
      let started = false
      try {
        started = await this.startServer(combined)
        const form = new FormData()
        form.append('file', new Blob([input.audio], { type: 'audio/wav' }), 'audio.wav')
        form.append('model', this.options.model)
        if (language && language !== 'auto') form.append('language', language)

        const startedAt = performance.now()
        const response = await fetch(`${this.options.baseUrl}${this.options.transcribePath}`, {
          method: 'POST',
          body: form,
          signal: combineSignals([combined, timeoutSignal(this.options.requestTimeoutMs)]),
        })
        const body = await response.text()
        if (!response.ok) {
          throw new Error(`${this.options.label}: HTTP ${response.status}: ${body.slice(0, 400)}`)
        }
        let payload
        try {
          payload = JSON.parse(body)
        } catch {
          throw new Error(`${this.options.label}: некорректный JSON: ${body.slice(0, 200)}`)
        }
        if (typeof payload?.text !== 'string') {
          throw new Error(`${this.options.label}: в ответе нет text`)
        }
        const durationMs = Number(payload?.timing?.audio_duration_ms)
        return {
          text: payload.text.trim(),
          audioSeconds: Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : audioSeconds(input.audio),
          inferenceSeconds: Math.max(0, (performance.now() - startedAt) / 1000),
        }
      } finally {
        if (started) await this.stopOwned()
      }
    }, combined)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(new Error('disposed'))
    for (const entry of this.queue) {
      entry.cleanup?.()
      entry.reject(new Error('Провайдер остановлен'))
    }
    this.queue = []
    await this.stopOwned()
    this.listeners.clear()
  }
}

function createProvider(ctx, config, kind) {
  if (kind === 'whisper') {
    return new HttpSpeechProvider(ctx, {
      ...config,
      kind: 'whisper',
      label: 'FastFlowLM Whisper NPU',
      healthPath: '/v1/models',
      transcribePath: '/v1/audio/transcriptions',
      startHint: 'Проверьте FLM_MODEL_PATH в start-flm.bat и запустите flm pull whisper-v3:turbo.',
      info: {
        id: 'whisper-npu',
        name: 'Whisper large-v3-turbo (NPU)',
        languages: ['auto', 'ru', 'en'],
      },
    })
  }
  return new HttpSpeechProvider(ctx, {
    ...config,
    kind: 'orukeet',
    label: 'audio.cpp Orukeet Vulkan',
    healthPath: '/health',
    transcribePath: '/v1/audio/transcriptions',
    startHint: 'Проверьте, что модели audio.cpp лежат в tts_cpp/models.',
    info: {
      id: 'orukeet-vulkan',
      name: 'Orukeet r3 (Vulkan)',
      languages: ['auto', 'ru', 'en'],
    },
  })
}

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const whisperConfig = normalizeEndpoint(config.whisper, DEFAULT_WHISPER)
  const orukeetConfig = normalizeEndpoint(config.orukeet, DEFAULT_ORUKEET)

  const whisper = createProvider(ctx, whisperConfig, 'whisper')
  const orukeet = createProvider(ctx, orukeetConfig, 'orukeet')

  ctx.effect(() => {
    const disposers = []
    const register = (provider) => {
      disposers.push(ctx.speechToText.register({
        info: {
          ...provider.options.info,
          location: 'host-local',
          downloadSources: [],
        },
        preparation: provider,
        transcribe: (input, signal) => provider.transcribe(input, signal),
      }))
      provider.initialise()
    }
    register(whisper)
    register(orukeet)
    return async () => {
      await whisper.dispose()
      await orukeet.dispose()
      await Promise.allSettled(disposers.map((dispose) => dispose()))
    }
  })
}
