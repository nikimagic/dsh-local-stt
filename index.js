/**
 * Локальный ASR для официального голосового ввода DSH.
 *
 * Провайдеры не держат серверы в фоне. При первом распознавании плагин
 * запускает нужный лаунчер, ждёт готовности, отправляет WAV и останавливает
 * сервер, если запускал его сам.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  HUGGINGFACE,
  MODELS,
  missingFiles,
  localSourceReady,
  provisionModels as provisionModelFiles,
} from './lib/models.js'

export const name = 'dsh-local-stt'
export const inject = ['speechToText']

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const ENGINES_DIR = String(process.env.DSH_LOCAL_STT_ENGINES || join(PACKAGE_DIR, 'engines')).replace(/[\\/]+$/, '')
const FLM_DIR = join(ENGINES_DIR, 'fastflowlm', '1.0.13')
const FLM_MODELS_DIR = join(ENGINES_DIR, 'fastflowlm')
const AUDIO_DIR = join(ENGINES_DIR, 'audio-cpp', '0.9.4')
const AUDIO_MODELS_DIR = join(ENGINES_DIR, 'audio-cpp', 'models')

const DEFAULT_WHISPER = {
  baseUrl: 'http://127.0.0.1:52626',
  model: 'whisper-v3:turbo',
  language: 'ru',
  requestTimeoutMs: 120_000,
  command: join(FLM_DIR, 'flm.exe'),
  args: ['serve', '--asr', 'whisper-v3:turbo', '--host', '127.0.0.1', '--port', '{port}'],
  cwd: FLM_DIR,
  env: { FLM_MODEL_PATH: FLM_MODELS_DIR },
  modelPath: join(FLM_MODELS_DIR, 'models', 'Whisper-V3-Turbo-NPU2', 'model.q4nx'),
  logPath: join(FLM_DIR, 'plugin.log'),
  autoStart: true,
  startupTimeoutMs: 90_000,
}
const DEFAULT_ORUKEET = {
  baseUrl: 'http://127.0.0.1:8028',
  model: 'orukeet_q8_0',
  language: 'ru',
  requestTimeoutMs: 120_000,
  command: join(AUDIO_DIR, 'audiocpp_server.exe'),
  args: [
    '--config',
    join(AUDIO_DIR, 'config', 'audio-vulkan.json'),
    '--host',
    '127.0.0.1',
    '--port',
    '{port}',
    '--no-ui',
    '--log',
    '--log-file',
    join(AUDIO_DIR, 'plugin.log'),
  ],
  cwd: AUDIO_DIR,
  env: {
    TEMP: join(AUDIO_DIR, 'temp'),
    TMP: join(AUDIO_DIR, 'temp'),
    OMP_NUM_THREADS: '8',
  },
  modelPath: join(AUDIO_MODELS_DIR, 'Orukeet-GGUF', 'orukeet-q8_0.gguf'),
  logPath: join(AUDIO_DIR, 'plugin-stdout.log'),
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
  const logPath = String(value.logPath ?? fallback.logPath ?? '').trim()
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
  const allowRemote = value.allowRemote === true
  const host = parsed.hostname.toLowerCase()
  if (!allowRemote && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(`baseUrl должен указывать на loopback (${host}); для внешнего адреса задайте allowRemote: true`)
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
    logPath,
    autoStart,
    allowRemote,
    startupTimeoutMs,
  }
}

function audioSeconds(audio) {
  try {
    const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
    if (
      audio.byteLength >= 12 &&
      view.getUint32(0, true) === 0x46464952 &&
      view.getUint32(8, true) === 0x45564157
    ) {
      let offset = 12
      let channels = 0
      let sampleRate = 0
      let bits = 0
      let dataSize = 0

      while (offset + 8 <= audio.byteLength) {
        const id = view.getUint32(offset, true)
        const size = view.getUint32(offset + 4, true)
        const body = offset + 8
        if (id === 0x20746d66 && size >= 16 && body + 16 <= audio.byteLength) {
          channels = view.getUint16(body + 2, true) || 0
          sampleRate = view.getUint32(body + 4, true) || 0
          bits = view.getUint16(body + 14, true) || 0
        } else if (id === 0x61746164) {
          dataSize = Math.min(size, Math.max(0, audio.byteLength - body))
          break
        }
        offset = body + size + (size & 1)
      }

      if (channels > 0 && sampleRate > 0 && bits > 0 && dataSize > 0) {
        const bytesPerSecond = sampleRate * channels * (bits / 8)
        return dataSize / bytesPerSecond
      }
    }
  } catch {
    // Ниже — запасной расчёт для канонического 16-кГц WAV.
  }
  return Math.max(0, (audio.byteLength - 44) / 32_000)
}

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function capturePowerShell(script, outputPath) {
  return new Promise((resolvePromise) => {
    let fd
    try {
      fd = openSync(outputPath, 'w')
    } catch {
      resolvePromise(false)
      return
    }
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      try {
        closeSync(fd)
      } catch {
        // Файл уже закрыт.
      }
      resolvePromise(ok)
    }
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      })
    } catch {
      finish(false)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Процесс уже завершился.
      }
      finish(false)
    }, 5_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      finish(code === 0)
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(false)
    })
  })
}

async function processIdentity(pid, port) {
  const output = join(tmpdir(), `dsh-local-stt-identity-${process.pid}-${pid}-${Date.now()}.json`)
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" -ErrorAction SilentlyContinue`,
    `$created = $null; if ($p) { $created = $p.CreationDate.ToUniversalTime().ToString('o') }`,
    `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue`,
    `[pscustomobject]@{ path = $p.ExecutablePath; createdAt = $created; portPid = @($c)[0].OwningProcess } | ConvertTo-Json -Compress`,
  ].join('; ')
  const ok = await capturePowerShell(script, output)
  try {
    if (!ok) return null
    const raw = readFileSync(output, 'utf8').trim()
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return {
      path: typeof parsed?.path === 'string' ? parsed.path : '',
      createdAt: typeof parsed?.createdAt === 'string' ? parsed.createdAt : '',
      portPid: Number(parsed?.portPid) || 0,
    }
  } catch {
    return null
  } finally {
    try {
      unlinkSync(output)
    } catch {
      // Файл уже удалён.
    }
  }
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
    this.model = options.model
    this.primaryName = options.primaryName
    this.primaryPath = options.modelPath
    this.modelsDir = dirname(options.modelPath)
    this.localSource = options.localSource || ''
    this.info = {
      id: options.info.id,
      name: options.info.name,
      location: 'host-local',
      languages: options.info.languages,
      downloadSources: [],
      setupEstimate: options.model.estimate,
    }
    this.info.downloadSources = this.downloadSources()
    this.listeners = new Set()
    this.state = {
      phase: 'checking',
      startedAt: Date.now(),
      steps: [{ kind: 'check', status: 'running', startedAt: Date.now() }],
    }
    this.checking = null
    this.starting = null
    this.ownedProcess = null
    this.childExited = false
    this.childCreatedAt = ''
    this.disposed = false
    this.lifetime = new AbortController()
    this.startAbort = new AbortController()
    this.provision = null
    this.provisionAbort = null
    this.queue = []
    this.active = null
    const profile = String(process.env.DSH_PROFILE || 'default').replace(/[^A-Za-z0-9._-]/g, '_')
    this.pidFile = join(tmpdir(), `dsh-local-stt-${profile}-${options.kind}.pid`)
    this.cleanupPromise = null
    this.cleanupBlocked = ''
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

  /** Модель ещё не лежит на диске: DSH сам предложит «Скачать и подготовить». */
  unprepared() {
    return {
      phase: 'unprepared',
      steps: [{ kind: 'model', status: 'pending', startedAt: Date.now() }],
    }
  }

  downloading({ resource, completedBytes, totalBytes }) {
    return {
      phase: 'downloading',
      resource,
      completedBytes,
      ...(totalBytes ? { totalBytes } : {}),
      steps: [{ kind: 'model', status: 'running', startedAt: Date.now() }],
    }
  }

  cancelledState() {
    return {
      phase: 'cancelled',
      steps: [{ kind: 'model', status: 'cancelled', startedAt: Date.now() }],
    }
  }

  downloadFailure(error) {
    const resource = typeof error?.resource === 'string' ? error.resource : 'model'
    const source = typeof error?.source === 'string' ? error.source : HUGGINGFACE
    const reason = typeof error?.reason === 'string' ? error.reason : 'unknown'
    const status = Number(error?.status)
    return {
      phase: 'failed',
      message: error instanceof Error ? error.message : String(error),
      download: { resource, source, reason, ...(status > 0 ? { status } : {}) },
      steps: [{ kind: 'model', status: 'failed', startedAt: Date.now() }],
    }
  }

  /** Куда положить файл манифеста: основной файл остаётся на месте `modelPath`. */
  targetFor(file) {
    return file.name === this.primaryName ? this.primaryPath : join(this.modelsDir, file.name)
  }

  /** Источники моделей: Hugging Face и, если файлы есть, локальная папка с исходниками. */
  downloadSources() {
    const sources = [HUGGINGFACE]
    if (localSourceReady(this.model, this.localSource)) {
      sources.push(pathToFileURL(this.localSource).href)
    }
    return sources
  }

  /** Пересчитать готовность моделей и опубликовать её. */
  inspect() {
    this.info.downloadSources = this.downloadSources()
    if (missingFiles(this.model, (file) => this.targetFor(file)).length === 0) {
      if (this.state.phase !== 'ready') this.publish(this.standby())
      return
    }
    this.publish(this.unprepared())
  }

  initialise() {
    if (this.ownedProcess || this.state.phase === 'ready' || this.cleanupPromise) return
    try {
      this.preflight()
      this.inspect()
      this.cleanupPromise = this.cleanupStale().catch((error) => {
        this.ctx.logger?.warn?.(`dsh-local-stt: cleanup failed: ${error instanceof Error ? error.message : error}`)
      })
    } catch (error) {
      this.publish(this.failure(error instanceof Error ? error.message : String(error)))
    }
  }

  writePid(pid, identity = {}) {
    try {
      this.childCreatedAt = identity.createdAt || ''
      const record = {
        pid,
        ownerPid: process.pid,
        command: this.options.command || '',
        port: this.options.port,
        createdAt: identity.createdAt || '',
      }
      writeFileSync(this.pidFile, JSON.stringify(record), 'utf8')
    } catch (error) {
      this.ctx.logger?.warn?.(`dsh-local-stt: не удалось записать PID: ${error instanceof Error ? error.message : error}`)
    }
  }

  async recordProcessIdentity(pid, child) {
    const identity = await processIdentity(pid, this.options.port)
    if (!identity?.createdAt) return
    if (this.ownedProcess !== child || !isAlive(pid)) return
    const expected = this.options.command ? resolve(this.options.command).toLowerCase() : ''
    const actual = identity.path ? resolve(identity.path).toLowerCase() : ''
    if (expected && actual !== expected) return
    this.childCreatedAt = identity.createdAt
    this.writePid(pid, identity)
  }

  clearPid() {
    this.childCreatedAt = ''
    try {
      unlinkSync(this.pidFile)
    } catch {
      // PID-файла уже нет.
    }
  }

  async cleanupStale() {
    this.cleanupBlocked = ''
    let record
    try {
      const raw = readFileSync(this.pidFile, 'utf8').trim()
      record = raw.startsWith('{') ? JSON.parse(raw) : { pid: Number(raw), createdAt: '' }
    } catch {
      return
    }

    const pid = Number(record?.pid)
    if (!Number.isInteger(pid) || pid <= 0) {
      this.clearPid()
      return
    }
    if (!isAlive(pid)) {
      this.clearPid()
      return
    }

    const ownerPid = Number(record?.ownerPid) || 0
    if (ownerPid && ownerPid !== process.pid && isAlive(ownerPid)) {
      if (!(await this.probe())) {
        this.cleanupBlocked = `PID-файл принадлежит другому экземпляру DSH (PID ${ownerPid}), сервер не отвечает; новый сервер не запускаю`
        this.ctx.logger?.warn?.(`dsh-local-stt: ${this.cleanupBlocked}`)
      }
      return
    }

    const identity = await processIdentity(pid, this.options.port)
    if (!identity?.path) {
      this.cleanupBlocked = `Не удалось проверить владельца PID ${pid}; новый сервер не запускаю`
      this.ctx.logger?.warn?.(`dsh-local-stt: ${this.cleanupBlocked}`)
      return
    }

    const expected = this.options.command ? resolve(this.options.command).toLowerCase() : ''
    const actual = resolve(identity.path).toLowerCase()
    if (expected && actual !== expected) {
      this.ctx.logger?.warn?.(`dsh-local-stt: PID ${pid} принадлежит ${identity.path}, а не серверу; файл удалён`)
      this.clearPid()
      return
    }

    const recordedCreatedAt = typeof record?.createdAt === 'string' ? record.createdAt : ''
    if (recordedCreatedAt) {
      if (!identity.createdAt || identity.createdAt !== recordedCreatedAt) {
        this.ctx.logger?.warn?.(
          `dsh-local-stt: PID ${pid} переиспользован другим экземпляром (createdAt не совпал); файл удалён`,
        )
        this.clearPid()
        return
      }
    } else if (identity.portPid !== pid) {
      this.cleanupBlocked = `Старый PID-файл без createdAt, порт ${this.options.port} не принадлежит PID ${pid}; новый сервер не запускаю`
      this.ctx.logger?.warn?.(`dsh-local-stt: ${this.cleanupBlocked}`)
      return
    }

    if (identity.portPid && identity.portPid !== pid) {
      this.cleanupBlocked = `Порт ${this.options.port} принадлежит PID ${identity.portPid}, а PID-файл указывает на ${pid}; новый сервер не запускаю`
      this.ctx.logger?.warn?.(`dsh-local-stt: ${this.cleanupBlocked}`)
      return
    }

    await killTree(pid)
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
      if (!isAlive(pid)) {
        this.cleanupBlocked = ''
        this.clearPid()
        return
      }
    }

    this.ctx.logger?.warn?.(`dsh-local-stt: не удалось остановить старый сервер PID ${pid}; файл оставлен`)
  }

  preflight() {
    const executable = this.options.command || this.options.launcher
    if (executable && !existsSync(executable)) {
      throw new Error(`Исполняемый файл не найден: ${executable}`)
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
      let logFd
      try {
        if (this.options.env.TEMP) mkdirSync(this.options.env.TEMP, { recursive: true })
        if (this.options.env.TMP) mkdirSync(this.options.env.TMP, { recursive: true })
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-local-stt: не удалось создать temp: ${error instanceof Error ? error.message : error}`)
      }
      if (this.options.logPath) {
        try {
          mkdirSync(dirname(this.options.logPath), { recursive: true })
          logFd = openSync(this.options.logPath, 'a')
        } catch (error) {
          this.ctx.logger?.warn?.(`dsh-local-stt: не удалось открыть лог: ${error instanceof Error ? error.message : error}`)
        }
      }
      await new Promise((resolve, reject) => {
        let closed = false
        const closeLog = () => {
          if (closed || !logFd) return
          closed = true
          try {
            closeSync(logFd)
          } catch {
            // Файл уже закрыт.
          }
        }
        let child
        try {
          child = spawn(this.options.command, args, {
            cwd: this.options.cwd || undefined,
            env: { ...process.env, ...this.options.env },
            windowsHide: true,
            stdio: logFd ? ['ignore', logFd, logFd] : 'ignore',
          })
        } catch (error) {
          closeLog()
          reject(error)
          return
        }
        child.once('spawn', () => {
          closeLog()
          this.childExited = false
          this.ownedProcess = child
          this.writePid(child.pid)
          void this.recordProcessIdentity(child.pid, child)
          child.once('exit', () => {
            this.childExited = true
            if (this.ownedProcess === child) this.ownedProcess = null
          })
          child.unref()
          resolve()
        })
        child.once('error', (error) => {
          closeLog()
          reject(error)
        })
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
    this.startAbort = new AbortController()
    const startSignal = combineSignals([signal, this.startAbort.signal])
    if (this.cleanupPromise) await this.cleanupPromise
    startSignal.throwIfAborted()
    if (await this.probe()) {
      this.publish(this.ready())
      return false
    }
    if (this.cleanupBlocked) throw new Error(this.cleanupBlocked)

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
        startSignal.throwIfAborted()
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
    if (child.exitCode !== null) {
      this.clearPid()
      return
    }

    await killTree(child.pid)
    let stopped = false
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (!isAlive(child.pid) && !(await this.probe())) {
        stopped = true
        break
      }
    }

    if (!stopped) {
      await killTree(child.pid)
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (!isAlive(child.pid) && !(await this.probe())) {
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

  async prepare(options = {}) {
    if (this.disposed) return
    if (this.cleanupBlocked) {
      this.publish(this.failure(this.cleanupBlocked))
      return
    }
    try {
      this.preflight()
    } catch (error) {
      this.publish(this.failure(error instanceof Error ? error.message : String(error)))
      return
    }
    this.info.downloadSources = this.downloadSources()
    if (missingFiles(this.model, (file) => this.targetFor(file)).length === 0) {
      if (this.state.phase !== 'ready' && this.state.phase !== 'standby') this.publish(this.standby())
      return
    }
    if (this.provision) return
    const source = typeof options?.downloadSource === 'string' ? options.downloadSource : undefined
    this.provision = this.runProvision(source)
  }

  /** Скачать модели с Hugging Face или скопировать их из локальной папки с исходниками. */
  async runProvision(source) {
    const controller = new AbortController()
    this.provisionAbort = controller
    const signal = combineSignals([controller.signal, this.lifetime.signal])
    try {
      const result = await provisionModelFiles({
        model: this.model,
        targetFor: (file) => this.targetFor(file),
        localDir: this.localSource,
        source,
        signal,
        onProgress: (progress) => {
          if (!this.disposed) this.publish(this.downloading(progress))
        },
      })
      this.ctx.logger?.info?.(
        `dsh-local-stt: модели ${this.options.label} подготовлены (${result.files} файлов, ${result.bytes} байт)`,
      )
      this.publish(this.standby())
    } catch (error) {
      if (signal.aborted) {
        this.publish(this.cancelledState())
      } else {
        this.ctx.logger?.warn?.(
          `dsh-local-stt: модели не подготовлены: ${error instanceof Error ? error.message : error}`,
        )
        this.publish(this.downloadFailure(error))
      }
    } finally {
      this.provisionAbort = null
      this.provision = null
    }
  }

  async cancel() {
    this.startAbort.abort(new Error('Подготовка отменена'))
    this.provisionAbort?.abort(new Error('Подготовка отменена'))
    if (this.provision) {
      try {
        await this.provision
      } catch {
        // Ошибка уже опубликована в состоянии подготовки.
      }
    }
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
    const missing = missingFiles(this.model, (file) => this.targetFor(file))
    if (missing.length > 0) {
      throw new Error(
        `${this.options.label}: модели не подготовлены (${missing.map((file) => file.name).join(', ')}). ` +
          'Откройте «Голосовой ввод» и нажмите «Скачать и подготовить».',
      )
    }
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
    this.startAbort.abort(new Error('disposed'))
    this.provisionAbort?.abort(new Error('disposed'))
    if (this.provision) {
      try {
        await this.provision
      } catch {
        // Отмена уже обработана в runProvision.
      }
    }
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
  const model = MODELS[kind]
  const shared = {
    ...config,
    kind,
    model,
    primaryName: kind === 'whisper' ? 'model.q4nx' : 'orukeet-q8_0.gguf',
  }
  if (kind === 'whisper') {
    return new HttpSpeechProvider(ctx, {
      ...shared,
      label: 'FastFlowLM Whisper NPU',
      healthPath: '/v1/models',
      transcribePath: '/v1/audio/transcriptions',
      startHint: 'Проверьте, что движок FastFlowLM разложен в engines\\fastflowlm.',
      info: {
        id: 'whisper-npu',
        name: 'Whisper large-v3-turbo (NPU)',
        languages: ['auto', 'ru', 'en'],
      },
    })
  }
  return new HttpSpeechProvider(ctx, {
    ...shared,
    label: 'audio.cpp Orukeet Vulkan',
    healthPath: '/health',
    transcribePath: '/v1/audio/transcriptions',
    startHint: 'Проверьте, что движок audio.cpp разложен в engines\\audio-cpp.',
    info: {
      id: 'orukeet-vulkan',
      name: 'Orukeet r3 (Vulkan)',
      languages: ['auto', 'ru', 'en'],
    },
  })
}

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const localSource = String(config.localSource ?? process.env.DSH_LOCAL_STT_SOURCES ?? '').trim()
  const whisperConfig = normalizeEndpoint(config.whisper, DEFAULT_WHISPER)
  const orukeetConfig = normalizeEndpoint(config.orukeet, DEFAULT_ORUKEET)

  const whisper = createProvider(ctx, { ...whisperConfig, localSource }, 'whisper')
  const orukeet = createProvider(ctx, { ...orukeetConfig, localSource }, 'orukeet')

  ctx.effect(() => {
    const disposers = []
    const register = (provider) => {
      disposers.push(
        ctx.speechToText.register({
          info: provider.info,
          preparation: provider,
          transcribe: (input, signal) => provider.transcribe(input, signal),
        }),
      )
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
