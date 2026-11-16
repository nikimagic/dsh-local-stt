/**
 * Собрать архивы движков и записать их размер и SHA-256 в lib/engines.js.
 *
 * Запуск: node scripts/pack-engines.mjs
 * Результат: dist/flm-1.0.13-win-x64.zip, dist/audiocpp-0.9.4-win-x64.zip
 * и обновлённый манифест. Архивы загружаются в релиз GitHub вручную.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINES } from '../lib/engines.js'
import { writeZip } from '../lib/zip.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')

/** Служебные каталоги и логи в архив не попадают. */
const SKIP_DIRS = new Set(['.cache', 'temp'])
const SKIP_FILES = /\.log$|^\.installed\.json$/i

function collect(dir, base, entries) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) continue
      collect(path, base, entries)
      continue
    }
    if (!item.isFile() || SKIP_FILES.test(item.name)) continue
    entries.push({ name: relative(base, path).replaceAll('\\', '/'), data: readFileSync(path) })
  }
}

function patchManifest(results) {
  const manifestPath = join(ROOT, 'lib', 'engines.js')
  const lines = readFileSync(manifestPath, 'utf8').split('\n')
  for (const result of results) {
    const header = lines.findIndex((line) => line.includes(`archive: '${result.archive}'`))
    if (header < 0) throw new Error(`в манифесте нет архива ${result.archive}`)
    for (let index = header; index < Math.min(header + 8, lines.length); index++) {
      if (/^\s*size:/.test(lines[index])) lines[index] = `    size: ${result.size},`
      if (/^\s*sha256:/.test(lines[index])) lines[index] = `    sha256: '${result.sha256}',`
    }
  }
  writeFileSync(manifestPath, lines.join('\n'), 'utf8')
}

const only = process.argv[2]
const results = []
mkdirSync(DIST, { recursive: true })

for (const [kind, engine] of Object.entries(ENGINES)) {
  if (only && only !== kind) continue
  const sourceDir = join(ROOT, 'engines', engine.dir)
  if (!existsSync(sourceDir)) {
    console.log(`- ${kind}: нет ${relative(ROOT, sourceDir)}, пропуск`)
    continue
  }
  const entries = []
  collect(sourceDir, sourceDir, entries)
  const bytes = entries.reduce((sum, entry) => sum + entry.data.length, 0)
  const result = await writeZip(entries, join(DIST, engine.archive))
  results.push({ archive: engine.archive, size: result.size, sha256: result.sha256 })
  console.log(
    `${engine.archive}: ${entries.length} файлов, ${(bytes / 1e6).toFixed(1)} МБ → ` +
      `${(result.size / 1e6).toFixed(1)} МБ, sha256 ${result.sha256}`,
  )
}

if (results.length > 0) {
  patchManifest(results)
  console.log('манифест lib/engines.js обновлён')
}

const total = results.reduce((sum, result) => sum + result.size, 0)
console.log(`итого архивов: ${(total / 1e6).toFixed(1)} МБ в ${relative(ROOT, DIST)}`)
