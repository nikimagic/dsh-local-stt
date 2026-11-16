/**
 * Модели ASR: манифест, проверка наличия и первая загрузка.
 *
 * Два источника:
 *   1) Hugging Face по закреплённой ревизии (резерв — hf-mirror.com);
 *   2) локальная папка с исходниками (каталог engines), копирование без сети.
 *
 * Файлы проверяются по размеру и SHA-256; недокачанный `.part` продолжается.
 */
import { createHash } from 'node:crypto'
import { createReadStream, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { AssetError } from './errors.js'
import { downloadFile, fileSize } from './fetch-file.js'

export const HUGGINGFACE = 'https://huggingface.co'
export const HUGGINGFACE_MIRROR = 'https://hf-mirror.com'

/** Ошибка подготовки модели; историческое имя экспортируется для совместимости. */
export class ModelDownloadError extends AssetError {}

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

export { fileSize }

/**
 * Файлы, которых нет или размер которых не совпал.
 * @param model - запись манифеста.
 * @param targetFor - абсолютный путь для файла манифеста.
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

/**
 * Пересчитать хеши уже лежащих файлов: подмена или обрезанный файл будут
 * удалены, чтобы следующая подготовка скачала их заново.
 * @returns `{ missing, broken }` — чего нет и что не сошлось по SHA-256.
 */
export async function verifyModels(model, targetFor, { signal } = {}) {
  const missing = []
  const broken = []
  for (const file of model.files) {
    signal?.throwIfAborted()
    const path = targetFor(file)
    if (fileSize(path) !== file.size) {
      missing.push(file)
      continue
    }
    const digest = await hashFile(path)
    if (digest !== file.sha256) {
      broken.push(file)
      await fsp.rm(path, { force: true })
    }
  }
  return { missing, broken }
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Скопировать файл из локальной папки с исходниками, сверив SHA-256. */
async function copyLocal({ file, target, sourcePath }) {
  const part = `${target}.part`
  await fsp.mkdir(dirname(target), { recursive: true })
  await fsp.copyFile(sourcePath, part)
  const digest = await hashFile(part)
  if (digest !== file.sha256) {
    await fsp.rm(part, { force: true })
    throw new AssetError(`SHA-256 ${file.name} в локальной папке не совпал`, 'integrity')
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
      throw new AssetError('Локальная папка с исходниками неполная', 'storage', {
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
    try {
      if (local) {
        bytes += await copyLocal({
          file,
          target,
          sourcePath: join(localDir, model.store, file.name),
        })
      } else {
        const bases = origin === HUGGINGFACE ? [HUGGINGFACE, HUGGINGFACE_MIRROR] : [origin]
        bytes += await downloadFile({
          urls: bases.map((base) => `${base}/${model.repo}/resolve/${model.revision}/${file.remote}`),
          target,
          size: file.size,
          sha256: file.sha256,
          resource: file.name,
          signal,
          onProgress,
        })
      }
    } catch (error) {
      if (error instanceof AssetError) throw error
      throw new AssetError(error instanceof Error ? error.message : String(error), 'network', {
        resource: file.name,
        source: local ? 'local' : origin,
      })
    }
  }
  return { files: pending.length, bytes }
}
