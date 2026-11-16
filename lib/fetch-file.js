/**
 * Загрузка файла с докачкой и проверкой размера и SHA-256.
 * Общий механизм для моделей и архивов движков.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, promises as fsp, statSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AssetError } from './errors.js'

const STALL_MS = 60_000
/** Ожидание заголовков ответа: зависшее соединение не должно блокировать загрузку. */
const HEADERS_TIMEOUT_MS = 20_000
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

async function hashExisting(path, hash) {
  for await (const chunk of createReadStream(path)) hash.update(chunk)
}

/**
 * Скачать файл, продолжив `.part`, и проверить целостность.
 * @param options.urls - кандидаты по порядку: следующий берётся при сетевой ошибке.
 * @param options.target - итоговый путь.
 * @param options.size - ожидаемый размер.
 * @param options.sha256 - ожидаемый SHA-256.
 * @param options.signal - отмена.
 * @param options.onProgress - `{ resource, completedBytes, totalBytes }`.
 * @returns число байтов файла.
 */
export async function downloadFile({ urls, target, size, sha256, resource, signal, onProgress, headersTimeoutMs = HEADERS_TIMEOUT_MS }) {
  const part = `${target}.part`
  await fsp.mkdir(target.replace(/[\\/][^\\/]+$/, ''), { recursive: true })

  let offset = fileSize(part)
  if (offset < 0) offset = 0
  if (offset > size) {
    await fsp.rm(part, { force: true })
    offset = 0
  }

  /** @type {ReadableStream<Uint8Array> | undefined} */
  let body
  if (offset < size) {
    let response
    let failure
    let source = urls[0]
    for (const [index, url] of urls.entries()) {
      const last = index === urls.length - 1
      // Таймер ждёт только заголовки: после ответа он снимается, иначе он
      // оборвал бы чтение тела на долгих загрузках.
      const headers = new AbortController()
      const timer = setTimeout(() => headers.abort(new Error('headers-timeout')), headersTimeoutMs)
      const attempt = signal ? AbortSignal.any([signal, headers.signal]) : headers.signal
      try {
        response = await fetch(url, {
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
          signal: attempt,
          redirect: 'follow',
        })
      } catch (error) {
        if (signal?.aborted) throw error
        failure = headers.signal.aborted
          ? new AssetError(`Сервер ${url} не ответил за ${headersTimeoutMs} мс`, 'timeout', {
              resource,
              source: url,
            })
          : error
        response = undefined
        continue
      } finally {
        clearTimeout(timer)
      }
      // Неудачный ответ — повод перейти к следующему адресу, если он есть.
      if ((!response.ok && response.status !== 206) || (response.status === 416 && offset > 0)) {
        if (!last) {
          failure = new AssetError(`HTTP ${response.status} для ${resource}`, 'http', {
            status: response.status,
            resource,
            source: url,
          })
          response = undefined
          continue
        }
      }
      source = url
      break
    }
    if (!response) {
      if (failure instanceof AssetError) throw failure
      throw failure ?? new AssetError(`Нет ответа для ${resource}`, 'network', { resource, source: urls[0] })
    }
    if (response.status === 416 && offset > 0) {
      await fsp.rm(part, { force: true })
      throw new AssetError(`Сервер не отдал остаток ${resource}`, 'network', { resource, source })
    }
    if (!response.ok && response.status !== 206) {
      throw new AssetError(`HTTP ${response.status} для ${resource}`, 'http', {
        status: response.status,
        resource,
        source,
      })
    }
    if (offset > 0 && response.status !== 206) {
      // Сервер не поддержал Range — качаем заново.
      await fsp.rm(part, { force: true })
      offset = 0
    }
    if (!response.body) throw new AssetError(`Пустой ответ для ${resource}`, 'network', { resource, source })
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
      resource,
      completedBytes: Math.min(written, size),
      totalBytes: size,
    })
  }

  if (offset < size) {
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
    try {
      await pipeline(Readable.fromWeb(body), counter, createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }), {
        signal: combined,
      })
    } catch (error) {
      if (stall.signal.aborted && !signal?.aborted) {
        throw new AssetError(`Загрузка ${resource} остановилась`, 'timeout')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    report(true)
  }

  const digest = hash.digest('hex')
  const actual = fileSize(part)
  if (actual !== size) {
    await fsp.rm(part, { force: true })
    throw new AssetError(`Размер ${resource} не совпал: ${actual} вместо ${size}`, 'integrity')
  }
  if (sha256 && digest !== sha256) {
    await fsp.rm(part, { force: true })
    throw new AssetError(`SHA-256 ${resource} не совпал`, 'integrity')
  }
  await fsp.rename(part, target)
  return size
}

/** Проверить, что файл на месте и нужного размера. */
export function fileReady(path, size) {
  return fileSize(path) === size
}
