/**
 * Движки: манифест архивов, скачивание и распаковка при первом запуске.
 *
 * Архивы публикуются отдельным релизом GitHub, чтобы не раздувать историю
 * репозитория. Размер и SHA-256 записываются scripts/pack-engines.mjs.
 */
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  },
  orukeet: {
    id: 'audiocpp',
    label: 'audio.cpp 0.9.4',
    archive: 'audiocpp-0.9.4-win-x64.zip',
    size: 35679037,
    sha256: '080e9e695b6868ebe30cdee8afefb8b5dc23dc3f7cb314f1435f5d4cb829b868',
    dir: join('audio-cpp', '0.9.4'),
    marker: 'audiocpp_server.exe',
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

function hashFile(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
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
      sha256: hashFile(join(dir, name)),
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
export function verifyEngine(engine, enginesDir) {
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
    if (fileSize(path) !== file.size || hashFile(path) !== file.sha256) broken.push(file.path)
  }
  return { state: broken.length === 0 ? 'ok' : 'broken', broken }
}

/** @returns {Promise<{ installed: boolean, bytes: number }>} */
export async function provisionEngine({ engine, enginesDir, baseUrl, signal, onProgress, onExtract }) {
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
    const bytes = await downloadFile({
      urls: [url],
      target: archivePath,
      size: engine.size || 0,
      sha256: engine.sha256 || '',
      resource: engine.archive,
      signal,
      onProgress,
    })

    onExtract?.({ resource: engine.archive, completedBytes: 0, totalBytes: 0 })
    const archive = await readZip(archivePath)
    const staging = join(cacheDir, `${engine.id}-staging`)
    await fsp.rm(staging, { recursive: true, force: true })
    await fsp.mkdir(staging, { recursive: true })
    await extractZip(archive, staging, { signal, onProgress: onExtract })

    const target = join(enginesDir, engine.dir)
    await fsp.mkdir(dirname(target), { recursive: true })
    // Каталог версии не занят: ставим рядом, ничего не удаляя.
    await fsp.rename(staging, target)
    await fsp.rm(archivePath, { force: true })

    if (!engineReady(engine, enginesDir)) {
      throw new AssetError(`В архиве ${engine.archive} нет ${engine.marker}`, 'integrity')
    }
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
