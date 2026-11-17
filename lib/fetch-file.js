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

async function hashExisting(path, hash, signal) {
  signal?.throwIfAborted()
  for await (const chunk of createReadStream(path, { signal })) {
    signal?.throwIfAborted()
    hash.update(chunk)
  }
  signal?.throwIfAborted()
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
  signal?.throwIfAborted()
  const part = `${target}.part`
  await fsp.mkdir(target.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
  signal?.throwIfAborted()

  let offset = Math.max(0, fileSize(part))
  if (offset > size) {
    await fsp.rm(part, { force: true })
    offset = 0
  }

  let lastReport = 0
  const report = (written, force = false) => {
    const now = Date.now()
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return
    lastReport = now
    onProgress?.({ resource, completedBytes: written, totalBytes: size })
  }

  // Ошибка тела тоже относится к попытке: pipeline уже закрыл файл, поэтому
  // следующий источник продолжает только реально сохранённый префикс.
  let failure
  for (let index = 0; index < Math.max(1, urls.length); index++) {
    signal?.throwIfAborted()
    offset = Math.max(0, fileSize(part))
    const source = urls[index]
    let response
    try {
      if (offset < size) {
        const headers = new AbortController()
        const timer = setTimeout(() => headers.abort(new Error('headers-timeout')), headersTimeoutMs)
        const attempt = signal ? AbortSignal.any([signal, headers.signal]) : headers.signal
        try {
          response = await fetch(source, {
            headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
            signal: attempt,
            redirect: 'follow',
          })
        } catch (error) {
          signal?.throwIfAborted()
          if (headers.signal.aborted) {
            throw new AssetError(`Сервер ${source} не ответил за ${headersTimeoutMs} мс`, 'timeout', { resource, source })
          }
          throw error
        } finally {
          // Только заголовки, а не вся долгая передача тела.
          clearTimeout(timer)
        }
        signal?.throwIfAborted()
        if (!response.ok) {
          throw new AssetError(`HTTP ${response.status} для ${resource}`, 'http', {
            status: response.status, resource, source,
          })
        }
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
          const length = response.headers.get('content-length')
          if (!range || Number(range[1]) !== offset || Number(range[2]) !== size - 1 ||
              Number(range[3]) !== size || (length !== null && Number(length) !== size - offset)) {
            throw new AssetError(`Неверный Content-Range для ${resource}`, 'network', { resource, source })
          }
        } else if (offset > 0) {
          // Сервер проигнорировал Range: старый префикс нельзя дописывать.
          await fsp.rm(part, { force: true })
          offset = 0
        }
        if (!response.body) throw new AssetError(`Пустой ответ для ${resource}`, 'network', { resource, source })
      }

      const hash = createHash('sha256')
      if (offset > 0) await hashExisting(part, hash, signal)
      signal?.throwIfAborted()
      let written = offset
      if (offset < size) {
        const stall = new AbortController()
        const combined = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal
        let timer = setTimeout(() => stall.abort(new Error('stall')), STALL_MS)
        const counter = new Transform({
          transform(chunk, _encoding, callback) {
            // Проверяем ДО передачи чанка writer: ни байта сверх лимита на диске.
            if (chunk.length > size - written) {
              callback(new AssetError(`Размер ${resource} превышает ${size}`, 'integrity'))
              return
            }
            hash.update(chunk)
            written += chunk.length
            clearTimeout(timer)
            timer = setTimeout(() => stall.abort(new Error('stall')), STALL_MS)
            report(written)
            callback(null, chunk)
          },
        })
        try {
          await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }), {
            signal: combined,
          })
        } catch (error) {
          signal?.throwIfAborted()
          if (stall.signal.aborted) throw new AssetError(`Загрузка ${resource} остановилась`, 'timeout')
          throw error
        } finally {
          clearTimeout(timer)
        }
        report(written, true)
      }

      signal?.throwIfAborted()
      const digest = hash.digest('hex')
      const actual = fileSize(part)
      if (actual !== size) {
        // Чистый EOF до ожидаемого размера также позволяет докачку с зеркала.
        if (index < urls.length - 1) {
          failure = new AssetError(`Размер ${resource} не совпал: ${actual} вместо ${size}`, 'integrity')
          continue
        }
        throw new AssetError(`Размер ${resource} не совпал: ${actual} вместо ${size}`, 'integrity')
      }
      if (sha256 && digest !== sha256) throw new AssetError(`SHA-256 ${resource} не совпал`, 'integrity')
      signal?.throwIfAborted()
      await fsp.rename(part, target)
      return size
    } catch (error) {
      // Пользовательская отмена никогда не превращается в fallback.
      signal?.throwIfAborted()
      if (error instanceof AssetError && error.reason === 'integrity') {
        await fsp.rm(part, { force: true })
        throw error
      }
      failure = error
    } finally {
      // Освобождаем непрочитанные тела (HTTP/Range error, ошибка hashing).
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
    }
  }
  signal?.throwIfAborted()
  throw failure ?? new AssetError(`Нет ответа для ${resource}`, 'network', { resource, source: urls[0] })
}

/** Проверить, что файл на месте и нужного размера. */
export function fileReady(path, size) {
  return fileSize(path) === size
}
