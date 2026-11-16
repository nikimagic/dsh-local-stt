/**
 * Локальный ASR для официального голосового ввода DSH.
 *
 * Два провайдера:
 *  - Whisper large-v3-turbo на XDNA2 NPU через FastFlowLM (по умолчанию);
 *  - Orukeet r3 на Radeon 880M через audio.cpp/Vulkan (альтернатива).
 *
 * Плагин не запускает и не скачивает серверы: FastFlowLM и audio.cpp
 * поднимаются отдельно. Он только проверяет их доступность и отправляет WAV
 * на loopback-эндпоинты.
 */

export const name = 'dsh-local-stt'
export const inject = ['speechToText']

const DEFAULT_WHISPER = {
  baseUrl: 'http://127.0.0.1:52626',
  model: 'whisper-v3:turbo',
  language: 'ru',
  requestTimeoutMs: 120_000,
}
const DEFAULT_ORUKEET = {
  baseUrl: 'http://127.0.0.1:8028',
  model: 'orukeet_q8_0',
  language: 'ru',
  requestTimeoutMs: 120_000,
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
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`Некорректный baseUrl: ${baseUrl}`)
  if (!model) throw new Error('Не задана модель')
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('Некорректный requestTimeoutMs')
  return { baseUrl, model, language, requestTimeoutMs }
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
    this.disposed = false
    this.lifetime = new AbortController()
    this.tail = Promise.resolve()
    this.timer = setInterval(() => {
      if (!this.disposed && this.state.phase === 'failed') void this.check()
    }, 5_000)
    this.timer.unref?.()
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

  failure(message) {
    return {
      phase: 'failed',
      message,
      steps: [{ kind: 'check', status: 'failed', startedAt: Date.now() }],
    }
  }

  ready() {
    return {
      phase: 'ready',
      steps: [{ kind: 'check', status: 'complete', startedAt: Date.now() }],
    }
  }

  async check() {
    if (this.disposed) return false
    if (this.checking) return await this.checking
    this.checking = (async () => {
      try {
        const response = await fetch(`${this.options.baseUrl}${this.options.healthPath}`, {
          signal: timeoutSignal(2_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        this.publish(this.ready())
        return true
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.publish(this.failure(`${this.options.label} не отвечает на ${this.options.baseUrl}: ${reason}. ${this.options.startHint}`))
        return false
      } finally {
        this.checking = null
      }
    })()
    return await this.checking
  }

  async prepare() {
    await this.check()
  }

  async cancel() {
    // Подготовка — только проверка доступности; отменять нечего.
  }

  async ensureReady(signal) {
    if (this.state.phase === 'ready') return
    const ok = await this.check()
    if (!ok) throw new Error(this.state.message || `${this.options.label} недоступен`)
    signal.throwIfAborted()
  }

  async transcribe(input, signal) {
    if (this.disposed) throw new Error('Провайдер остановлен')
    const combined = combineSignals([signal, this.lifetime.signal])
    combined.throwIfAborted()
    const language = String(input?.language || this.options.language || 'ru').trim()

    const run = this.tail.then(async () => {
      await this.ensureReady(combined)
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
    })
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.timer)
    this.lifetime.abort(new Error('disposed'))
    this.listeners.clear()
    try {
      await this.tail
    } catch {
      // Остановка не должна падать из-за отменённого запроса.
    }
  }
}

function createProvider(ctx, config, kind) {
  if (kind === 'whisper') {
    return new HttpSpeechProvider(ctx, {
      ...config,
      label: 'FastFlowLM Whisper NPU',
      healthPath: '/v1/models',
      transcribePath: '/v1/audio/transcriptions',
      startHint: 'Запустите FastFlowLM: flm serve --asr whisper-v3:turbo --host 127.0.0.1 --port 52626.',
      info: {
        id: 'whisper-npu',
        name: 'Whisper large-v3-turbo (NPU)',
        languages: ['auto', 'ru', 'en'],
      },
    })
  }
  return new HttpSpeechProvider(ctx, {
    ...config,
    label: 'audio.cpp Orukeet Vulkan',
    healthPath: '/health',
    transcribePath: '/v1/audio/transcriptions',
    startHint: 'Запустите audio.cpp: «Запустить audio.cpp.bat» или audiocpp_server --config ... --ui.',
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
      void provider.check()
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
