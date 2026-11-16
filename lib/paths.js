/**
 * Каталоги данных плагина.
 *
 * Движки и модели живут вне пакета: установка и обновление плагина заменяют
 * каталог пакета целиком, поэтому 1,7 ГБ внутри него терялись бы при каждом
 * обновлении.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Домашний каталог DSH: переменная DSH_HOME или ~/.dsh. */
export function dshHome(env = process.env, home = homedir()) {
  const configured = String(env.DSH_HOME ?? '').trim()
  return configured || join(home, '.dsh')
}

/**
 * Куда складывать движки и модели.
 * Порядок: `engines.dir` из конфига → `DSH_LOCAL_STT_ENGINES` → `<DSH_HOME>\dsh-local-stt\engines`.
 */
export function resolveEnginesDir({ configured, env = process.env, home = homedir() } = {}) {
  const explicit = String(configured ?? '').trim()
  if (explicit) return resolve(explicit)
  const fromEnv = String(env.DSH_LOCAL_STT_ENGINES ?? '').trim()
  if (fromEnv) return resolve(fromEnv)
  return join(dshHome(env, home), 'dsh-local-stt', 'engines')
}

/** Каталог данных принадлежит плагину, а не пакету. */
export function isInsidePackage(path) {
  return /[\\/]node_modules[\\/]/i.test(path)
}

function isEmptyDir(path) {
  try {
    return readdirSync(path).length === 0
  } catch {
    return false
  }
}

/**
 * Перенести раскладку из старого места внутри пакета в каталог данных.
 *
 * Перенос — переименование на том же диске: 1,7 ГБ не копируются. Если
 * источник лежит не в node_modules (запуск из репозитория), ничего не трогаем.
 * @returns `{ moved, reason }`
 */
export function migrateLegacyEngines({ fromDir, toDir }) {
  if (!fromDir || !toDir) return { moved: false, reason: 'no-path' }
  if (resolve(fromDir) === resolve(toDir)) return { moved: false, reason: 'same' }
  if (!isInsidePackage(fromDir)) return { moved: false, reason: 'not-installed' }
  if (!existsSync(fromDir)) return { moved: false, reason: 'no-source' }
  if (existsSync(toDir) && !isEmptyDir(toDir)) return { moved: false, reason: 'target-exists' }

  try {
    if (!statSync(fromDir).isDirectory()) return { moved: false, reason: 'not-directory' }
    mkdirSync(dirname(toDir), { recursive: true })
    if (existsSync(toDir)) {
      // пустой каталог мешает переименованию
      try {
        rmdirSync(toDir)
      } catch {
        // оставим как есть — rename ниже сообщит об ошибке
      }
    }
    renameSync(fromDir, toDir)
    return { moved: true, reason: 'renamed' }
  } catch (error) {
    return { moved: false, reason: `error: ${error instanceof Error ? error.message : String(error)}` }
  }
}
