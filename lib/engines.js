/**
 * Движки: манифест архивов, скачивание и распаковка при первом запуске.
 *
 * Архивы публикуются отдельным релизом GitHub, чтобы не раздувать историю
 * репозитория. Размер и SHA-256 записываются scripts/pack-engines.mjs.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fsp, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { AssetError } from './errors.js'
import { downloadFile, fileSize } from './fetch-file.js'
import { extractZip, readZip } from './zip.js'

/** Базовый адрес архивов движков; переопределяется полем `engines.baseUrl`. */
export const ENGINES_RELEASE = 'https://github.com/nikimagic/dsh-local-stt/releases/download/engines-1'

export const ENGINES = {
  whisper: {
    id: 'flm',
    label: 'FastFlowLM 1.0.13',
    archive: 'flm-1.0.13-win-x64.zip',
    size: 39142780,
    sha256: 'c1b84d8f6aa49aaa6248af05bddeae4b6d5780f9765ddc349cdfb0eb2afe4e1d',
    dir: join('fastflowlm', '1.0.13'),
    marker: 'flm.exe',
    /** Официальная сборка — главный источник, наш архив остаётся резервом. */
    official: {
      url: 'https://github.com/ROCm/FastFlowLM/releases/download/v1.0.13/fastflowlm_1.0.13_windows_amd64.zip',
      size: 38382193,
      sha256: 'a88117407c0115168b5beb7b7710d0cb61dd3e0187a3289f23396dd1b5011133',
    },
  },
  orukeet: {
    id: 'audiocpp',
    label: 'audio.cpp 0.9.4',
    archive: 'audiocpp-0.9.4-win-x64.zip',
    size: 35679037,
    sha256: '080e9e695b6868ebe30cdee8afefb8b5dc23dc3f7cb314f1435f5d4cb829b868',
    dir: join('audio-cpp', '0.9.4'),
    marker: 'audiocpp_server.exe',
    official: {
      url: 'https://github.com/0xShug0/audio.cpp/releases/download/v0.9.4/audio-v0.9.4-bin-windows-x64-vulkan.zip',
      size: 84083745,
      sha256: '804f70cf47c7b8450ef37e76fc04ecee71728345061f6e749a412932dd7db7a7',
    },
  },
}

/** Движок уже разложен: есть исполняемый файл нужного размера. */
export function engineReady(engine, enginesDir) {
  return fileSize(join(enginesDir, engine.dir, engine.marker)) > 0
}

const MANIFEST_NAME = '.installed.json'
/** Служебные файлы, которые движок создаёт сам: в манифест и проверку не входят. */
const IGNORED = /(^|[\\/])(temp|\.cache)([\\/]|$)|\.log$|^\.installed\.json$/i

function walkFiles(dir, base, out) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.test(item.name)) continue
    const path = join(dir, item.name)
    if (item.isDirectory()) walkFiles(path, base, out)
    else if (item.isFile()) out.push(relative(base, path).replaceAll('\\', '/'))
  }
  return out
}

function hashFileSync(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

/** Асинхронный хеш: не блокирует event loop на больших файлах. */
async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Запомнить состав и хеши разложенного движка. */
export function writeManifest(dir, extra = {}) {
  const files = walkFiles(dir, dir, [])
    .filter((name) => name !== MANIFEST_NAME)
    .sort()
    .map((name) => ({
      path: name,
      size: statSync(join(dir, name)).size,
      sha256: hashFileSync(join(dir, name)),
    }))
  writeFileSync(
    join(dir, MANIFEST_NAME),
    JSON.stringify({ ...extra, createdAt: new Date().toISOString(), files }),
    'utf8',
  )
  return files.length
}

/**
 * Проверить движок по записанному манифесту: размер и SHA-256 каждого файла.
 *
 * Только чтение: ничего не пишет, не перемещает и не удаляет. Если манифеста
 * нет (движок разложен вручную), состояние `unknown`, а не ошибка.
 * @returns `{ state: 'ok' | 'missing' | 'broken' | 'unknown', broken }`
 */
export async function verifyEngine(engine, enginesDir) {
  const dir = join(enginesDir, engine.dir)
  if (fileSize(join(dir, engine.marker)) < 0) return { state: 'missing', broken: [] }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8'))
  } catch {
    return { state: 'unknown', broken: [] }
  }
  if (!manifest || !Array.isArray(manifest.files)) return { state: 'unknown', broken: [] }

  const broken = []
  for (const file of manifest.files) {
    const path = join(dir, file.path)
    if (fileSize(path) !== file.size || (await hashFile(path)) !== file.sha256) broken.push(file.path)
  }
  return { state: broken.length === 0 ? 'ok' : 'broken', broken }
}

/** @returns {Promise<{ installed: boolean, bytes: number }>} */
export async function provisionEngine({ engine, enginesDir, baseUrl, localArchive, signal, onProgress, onExtract }) {
  if (engineReady(engine, enginesDir)) return { installed: false, bytes: 0 }

  const target = join(enginesDir, engine.dir)
  if (existsSync(target)) {
    throw new AssetError(
      `Каталог ${engine.dir} уже существует, но файла ${engine.marker} в нём нет. ` +
        'Удалите каталог вручную: проверка ничего не удаляет.',
      'storage',
      { resource: engine.archive, source: String(baseUrl || ENGINES_RELEASE) },
    )
  }

  const cacheDir = join(enginesDir, '.cache')
  const archivePath = join(cacheDir, engine.archive)
  const url = `${String(baseUrl || ENGINES_RELEASE).replace(/\/+$/, '')}/${engine.archive}`

  try {
    await fsp.mkdir(cacheDir, { recursive: true })

    // Альтернатива сети: готовый архив из папки проекта.
    let archive
    let bytes = 0
    let usedLocal = false
    let usedSource = localArchive || url
    if (localArchive && existsSync(localArchive)) {
      const size = fileSize(localArchive)
      if (engine.size > 0 && size !== engine.size) {
        throw new AssetError(
          `Локальный архив ${engine.archive} другого размера: ${size} вместо ${engine.size}`,
          'integrity',
          { resource: engine.archive, source: localArchive },
        )
      }
      if (engine.sha256 && (await hashFile(localArchive)) !== engine.sha256) {
        throw new AssetError(`SHA-256 локального архива ${engine.archive} не совпал`, 'integrity', {
          resource: engine.archive,
          source: localArchive,
        })
      }
      archive = await readZip(localArchive)
      bytes = size
      usedLocal = true
      usedSource = localArchive
    } else {
      // Сначала официальная сборка, затем наш архив как резерв.
      const candidates = []
      if (engine.official?.url) candidates.push(engine.official)
      candidates.push({ url, size: engine.size, sha256: engine.sha256 })
      let failure
      for (const candidate of candidates) {
        try {
          bytes = await downloadFile({
            urls: [candidate.url],
            target: archivePath,
            size: candidate.size || 0,
            sha256: candidate.sha256 || '',
            resource: engine.archive,
            signal,
            onProgress,
          })
          archive = await readZip(archivePath)
          usedSource = candidate.url
          break
        } catch (error) {
          if (signal?.aborted) throw error
          failure = error
          await fsp.rm(`${archivePath}.part`, { force: true })
        }
      }
      if (!archive) {
        throw failure ?? new AssetError(`Не удалось получить архив ${engine.archive}`, 'network', {
          resource: engine.archive,
          source: url,
        })
      }
    }

    onExtract?.({ resource: engine.archive, completedBytes: 0, totalBytes: 0 })
    const staging = join(cacheDir, `${engine.id}-staging`)
    await fsp.rm(staging, { recursive: true, force: true })
    await fsp.mkdir(staging, { recursive: true })
    await extractZip(archive, staging, { signal, onProgress: onExtract })

    // Проверяем содержимое до переноса: нерабочий архив не должен занять каталог версии.
    if (fileSize(join(staging, engine.marker)) < 0) {
      await fsp.rm(staging, { recursive: true, force: true })
      throw new AssetError(`В архиве ${engine.archive} нет ${engine.marker}`, 'integrity', {
        resource: engine.archive,
        source: usedSource,
      })
    }

    const target = join(enginesDir, engine.dir)
    await fsp.mkdir(dirname(target), { recursive: true })
    // Каталог версии не занят: ставим рядом, ничего не удаляя.
    await fsp.rename(staging, target)
    if (!usedLocal) await fsp.rm(archivePath, { force: true })

    writeManifest(target, { archive: engine.archive, sha256: engine.sha256 })
    return { installed: true, bytes }
  } catch (error) {
    if (error instanceof AssetError) throw error
    const code = error && typeof error === 'object' ? String(error.code || '') : ''
    const reason = /ENOSPC|EACCES|EPERM|EROFS/i.test(code) ? 'storage' : 'unknown'
    throw new AssetError(error instanceof Error ? error.message : String(error), reason, {
      resource: engine.archive,
      source: url,
    })
  }
}
