/**
 * Модели ASR: манифест, проверка наличия и первая загрузка.
 *
 * Два источника:
 *   1) Hugging Face по закреплённой ревизии;
 *   2) локальная папка с исходниками (каталог engines), копирование без сети.
 *
 * Файл пишется в `<имя>.part`, хешируется по ходу записи и переименовывается
 * только после совпадения размера и SHA-256. Недокачанный `.part` продолжается
 * с места обрыва, если сервер поддерживает Range.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fsp, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const HUGGINGFACE = 'https://huggingface.co'
export const HUGGINGFACE_MIRROR = 'https://hf-mirror.com'

/** Ревизии закреплены: содержимое по ним неизменно, хеши не разъедутся. */
export const MODELS = {
  whisper: {
    id: 'whisper',
    repo: 'FastFlowLM/Whisper-V3-Turbo-NPU2',
    revision: '594eecd2d80b20cbb04ef0099162335d1dd1899a',
    store: join('fastflowlm', 'models', 'Whisper-V3-Turbo-NPU2'),
    estimate: {
      recommendedDiskBytes: 660_000_000,
      expectedMemoryBytes: 2_500_000_000,
      minimumMinutes: 1,
      maximumMinutes: 15,
    },
    files: [
      {
        name: 'config.json',
        remote: 'config.json',
        size: 1283,
        sha256: '54481b3c31d2fc953ed383ec5670109bb4cbcaf1892e73ba568cbd23583688aa',
      },
      {
        name: 'tokenizer.json',
        remote: 'tokenizer.json',
        size: 2710337,
        sha256: '297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd',
      },
      {
        name: 'tokenizer_config.json',
        remote: 'tokenizer_config.json',
        size: 282897,
        sha256: 'c5486679eb96d17356cc53c6c3533009cc151d0015075f2eef482dfe8484c863',
      },
      {
        name: 'model.q4nx',
        remote: 'model.q4nx',
        size: 650175128,
        sha256: '8fb97604bf5762ee26efa696cfc9eb70724110358c7b4ca628a7973bf8a16291',
      },
    ],
  },
  orukeet: {
    id: 'orukeet',
    repo: 'audio-cpp/audio.cpp-gguf',
    revision: '7a103b33f04120535bdfe97b5f65b79d3c90d708',
    store: join('audio-cpp', 'models', 'Orukeet-GGUF'),
    estimate: {
      recommendedDiskBytes: 920_000_000,
      expectedMemoryBytes: 3_500_000_000,
      minimumMinutes: 1,
      maximumMinutes: 20,
    },
    files: [
      {
        name: 'orukeet-q8_0.gguf',
        remote: 'Orukeet-GGUF/orukeet-q8_0.gguf',
        size: 915908144,
        sha256: '420d78f2cb9c570127bfcef36c0e2b8f95e07f81c3722fece598d8c88fbd11ce',
      },
    ],
  },
}

/** Загрузка модели не удалась; `reason` совпадает с причиной в состоянии подготовки DSH. */
export class ModelDownloadError extends Error {
  constructor(message, reason, extra = {}) {
    super(message)
    this.name = 'ModelDownloadError'
    this.reason = reason
    Object.assign(this, extra)
  }
}

const STALL_MS = 60_000
const PROGRESS_INTERVAL_MS = 300

/** @returns размер файла или -1, если файла нет. */
export function fileSize(path) {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.size : -1
  } catch {
    return -1
  }
}

/**
 * Файлы, которых нет или размер которых не совпал.
 * @param model - запись манифеста.
 * @param targetFor - абсолютный путь для файла манифеста.
 * @returns недостающие файлы в порядке манифеста.
 */
export function missingFiles(model, targetFor) {
  return model.files.filter((file) => fileSize(targetFor(file)) !== file.size)
}

/** @returns true, если в локальной папке с исходниками лежат все файлы модели. */
export function localSourceReady(model, localDir) {
  if (!localDir) return false
  return model.files.every((file) => fileSize(join(localDir, model.store, file.name)) === file.size)
}

/** Суммарный объём файлов модели в байтах. */
export function modelBytes(model) {
  return model.files.reduce((total, file) => total + file.size, 0)
}

function reasonOf(error) {
  if (error instanceof ModelDownloadError) return error.reason
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' ? String(error.code || '') : ''
  if (/ENOSPC|EDQUOT|EACCES|EPERM|EROFS/i.test(code) || /no space|space left/i.test(message)) {
    return 'storage'
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(code) || /\bdns\b/i.test(message)) return 'dns'
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(message)) return 'certificate'
  if (/timeout|stall|ETIMEDOUT/i.test(message)) return 'timeout'
  return 'network'
}

async function hashExisting(path, hash) {
  for await (const chunk of createReadStream(path)) hash.update(chunk)
}

/**
 * Скачать или скопировать один файл, проверяя SHA-256 по ходу записи.
 * @returns число байтов файла.
 */
async function placeFile({ file, target, sourcePath, origin, model, signal, onProgress }) {
  const part = `${target}.part`
  let offset = fileSize(part)
  if (offset < 0) offset = 0
  if (offset > file.size) {
    await fsp.rm(part, { force: true })
    offset = 0
  }

  /** @type {ReadableStream<Uint8Array> | undefined} */
  let body
  if (!sourcePath && offset < file.size) {
    const origins = origin === HUGGINGFACE ? [HUGGINGFACE, HUGGINGFACE_MIRROR] : [origin]
    let response
    let failure
    for (const base of origins) {
      try {
        response = await fetch(`${base}/${model.repo}/resolve/${model.revision}/${file.remote}`, {
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
          signal,
          redirect: 'follow',
        })
        break
      } catch (error) {
        if (signal?.aborted) throw error
        failure = error
      }
    }
    if (!response) throw failure ?? new ModelDownloadError(`Нет ответа для ${file.name}`, 'network')
    if (response.status === 416 && offset > 0) {
      await fsp.rm(part, { force: true })
      throw new ModelDownloadError(`Сервер не отдал остаток ${file.name}`, 'network')
    }
    if (!response.ok && response.status !== 206) {
      throw new ModelDownloadError(`HTTP ${response.status} для ${file.name}`, 'http', {
        status: response.status,
      })
    }
    if (offset > 0 && response.status !== 206) {
      // Сервер не поддержал Range — качаем файл заново.
      await fsp.rm(part, { force: true })
      offset = 0
    }
    if (!response.body) throw new ModelDownloadError(`Пустой ответ для ${file.name}`, 'network')
    body = response.body
  }

  const hash = createHash('sha256')
  if (offset > 0) await hashExisting(part, hash)

  let written = offset
  let lastReport = 0
  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return
    lastReport = now
    onProgress?.({
      resource: file.name,
      completedBytes: Math.min(written, file.size),
      totalBytes: file.size,
    })
  }

  if (offset < file.size) {
    const stall = new AbortController()
    const combined = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal
    let timer = setTimeout(() => stall.abort(new Error('stall')), STALL_MS)
    const touch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => stall.abort(new Error('stall')), STALL_MS)
    }
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk)
        written += chunk.length
        touch()
        report()
        callback(null, chunk)
      },
    })
    const sink = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' })
    const source = sourcePath ? createReadStream(sourcePath) : Readable.fromWeb(body)
    try {
      await pipeline(source, counter, sink, { signal: combined })
    } catch (error) {
      if (stall.signal.aborted && !signal?.aborted) {
        throw new ModelDownloadError(`Загрузка ${file.name} остановилась`, 'timeout')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    report(true)
  }

  const digest = hash.digest('hex')
  const size = fileSize(part)
  if (size !== file.size) {
    await fsp.rm(part, { force: true })
    throw new ModelDownloadError(`Размер ${file.name} не совпал: ${size} вместо ${file.size}`, 'integrity')
  }
  if (digest !== file.sha256) {
    await fsp.rm(part, { force: true })
    throw new ModelDownloadError(`SHA-256 ${file.name} не совпал`, 'integrity')
  }
  await fsp.rename(part, target)
  return file.size
}

/**
 * Подготовить модели: скопировать из локальной папки или скачать с Hugging Face.
 * @param options.model - запись манифеста.
 * @param options.targetFor - абсолютный путь для файла манифеста.
 * @param options.localDir - корень локальных исходников (каталог engines) или пусто.
 * @param options.source - origin Hugging Face, `file:` нашего каталога или undefined (авто).
 * @param options.signal - отмена.
 * @param options.onProgress - прогресс по текущему файлу.
 * @returns { files, bytes } — сколько файлов и байтов записано.
 */
export async function provisionModels({ model, targetFor, localDir, source, signal, onProgress }) {
  const pending = missingFiles(model, targetFor)
  if (pending.length === 0) return { files: 0, bytes: 0 }

  const localReady = localSourceReady(model, localDir)
  let local = false
  let origin = HUGGINGFACE
  if (source && /^file:/i.test(source)) {
    if (!localReady) {
      throw new ModelDownloadError('Локальная папка с исходниками неполная', 'storage', {
        resource: 'local',
        source: 'local',
      })
    }
    local = true
  } else if (source) {
    origin = source
  } else {
    local = localReady
  }

  let bytes = 0
  for (const file of pending) {
    signal?.throwIfAborted()
    const target = targetFor(file)
    await fsp.mkdir(dirname(target), { recursive: true })
    const sourcePath = local ? join(localDir, model.store, file.name) : undefined
    try {
      bytes += await placeFile({
        file,
        target,
        sourcePath,
        origin,
        model,
        signal,
        onProgress,
      })
    } catch (error) {
      if (error instanceof ModelDownloadError) throw error
      throw new ModelDownloadError(error instanceof Error ? error.message : String(error), reasonOf(error), {
        resource: file.name,
        source: local ? 'local' : origin,
      })
    }
  }
  return { files: pending.length, bytes }
}
