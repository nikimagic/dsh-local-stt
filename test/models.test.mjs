/**
 * Проверки подготовки моделей: сеть, локальная копия, докачка, целостность.
 * Запуск: node --test test/models.test.mjs
 */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MODELS,
  ModelDownloadError,
  fileSize,
  localSourceReady,
  missingFiles,
  provisionModels,
} from '../lib/models.js'

const ENGINES = new URL('../engines/', import.meta.url)

/** Манифест без модели на 650 МБ: остальные файлы крошечные, хеши настоящие. */
function smallWhisper() {
  return {
    ...MODELS.whisper,
    store: join('src', 'whisper'),
    files: MODELS.whisper.files.filter((file) => file.name !== 'model.q4nx'),
  }
}

function workDir(name) {
  return mkdtempSync(join(tmpdir(), `dsh-stt-${name}-`))
}

function targetFor(dir) {
  return (file) => join(dir, file.name)
}

function realWhisperFile(name) {
  return join(fileURLToPath(ENGINES), 'fastflowlm', 'models', 'Whisper-V3-Turbo-NPU2', name)
}

test('скачивание с Hugging Face: файлы совпадают по SHA-256', async (t) => {
  const model = smallWhisper()
  const dir = workDir('hf')
  const progress = []
  try {
    const result = await provisionModels({
      model,
      targetFor: targetFor(dir),
      localDir: '',
      source: 'https://huggingface.co',
      onProgress: (item) => progress.push(item),
    }).catch((error) => {
      if (error?.reason === 'network' || error?.reason === 'dns') {
        t.skip('нет сети до huggingface.co')
        return null
      }
      throw error
    })
    if (result === null) return
    assert.equal(result.files, model.files.length)
    assert.deepEqual(missingFiles(model, targetFor(dir)), [])
    for (const file of model.files) assert.equal(fileSize(join(dir, file.name)), file.size)
    assert.ok(progress.length > 0, 'прогресс не публиковался')
    assert.ok(progress.at(-1).totalBytes > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('копия из локальной папки с исходниками: без сети и с проверкой хешей', async (t) => {
  const model = smallWhisper()
  const local = workDir('local-src')
  const dir = workDir('local-dst')
  try {
    const staged = join(local, model.store)
    mkdirSync(staged, { recursive: true })
    let prepared = true
    for (const file of model.files) {
      const source = realWhisperFile(file.name)
      if (!existsSync(source)) {
        prepared = false
        break
      }
      copyFileSync(source, join(staged, file.name))
    }
    if (!prepared) {
      t.skip('нет engines для локального источника')
      return
    }
    assert.equal(localSourceReady(model, local), true)

    const result = await provisionModels({
      model,
      targetFor: targetFor(dir),
      localDir: local,
      source: undefined,
    })
    assert.equal(result.files, model.files.length)
    assert.deepEqual(missingFiles(model, targetFor(dir)), [])
    for (const file of model.files) {
      assert.equal(readFileSync(join(dir, file.name)).length, file.size)
    }
  } finally {
    rmSync(local, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('докачка: недокачанный .part продолжается, а не начинается заново', async (t) => {
  const model = smallWhisper()
  const file = model.files.find((item) => item.name === 'tokenizer.json')
  const one = { ...model, files: [file] }
  const dir = workDir('resume')
  try {
    const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.remote}`
    const response = await fetch(url).catch(() => null)
    if (!response?.ok) {
      t.skip('нет сети до huggingface.co')
      return
    }
    const full = Buffer.from(await response.arrayBuffer())
    const half = Math.floor(full.length / 2)
    writeFileSync(join(dir, `${file.name}.part`), full.subarray(0, half))

    const progress = []
    const result = await provisionModels({
      model: one,
      targetFor: targetFor(dir),
      localDir: '',
      source: 'https://huggingface.co',
      onProgress: (item) => progress.push(item.completedBytes),
    })
    assert.equal(result.files, 1)
    assert.ok(progress.length > 0, 'прогресс не публиковался')
    assert.ok(progress[0] >= half, `ожидалась докачка с ${half}, а первое событие ${progress[0]}`)
    assert.equal(fileSize(join(dir, file.name)), file.size)
    assert.deepEqual(readFileSync(join(dir, file.name)), full)
    assert.equal(existsSync(join(dir, `${file.name}.part`)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('подменённый файл не принимается', async () => {
  const model = smallWhisper()
  const file = model.files.find((item) => item.name === 'config.json')
  const one = { ...model, files: [file] }
  const dir = workDir('integrity')
  try {
    writeFileSync(join(dir, `${file.name}.part`), Buffer.alloc(file.size, 1))
    const error = await provisionModels({
      model: one,
      targetFor: targetFor(dir),
      localDir: '',
      source: 'https://huggingface.co',
    }).catch((problem) => problem)
    assert.ok(error instanceof ModelDownloadError, 'ожидалась ошибка')
    assert.equal(error.reason, 'integrity')
    assert.equal(existsSync(join(dir, `${file.name}.part`)), false, 'битый .part не удалён')
    assert.equal(existsSync(join(dir, file.name)), false, 'файл не должен появиться')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('файлы на месте: ничего не качается', async () => {
  const model = smallWhisper()
  const file = model.files.find((item) => item.name === 'config.json')
  const one = { ...model, files: [file] }
  const dir = workDir('ready')
  try {
    writeFileSync(join(dir, file.name), readFileSync(realWhisperFile(file.name)))
    const result = await provisionModels({
      model: one,
      targetFor: targetFor(dir),
      localDir: '',
      source: 'https://huggingface.co',
    })
    assert.equal(result.files, 0)
    assert.equal(result.bytes, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('манифест: оба провайдера, закреплённые ревизии, хеши в документации', () => {
  const readme = readFileSync(new URL('../docs/ENGINES.md', import.meta.url), 'utf8')
  for (const [id, model] of Object.entries(MODELS)) {
    assert.equal(model.id, id)
    assert.match(model.revision, /^[0-9a-f]{40}$/)
    assert.ok(model.files.length > 0)
    for (const file of model.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/)
      assert.ok(file.size > 0)
      if (file.size < 1_000_000) continue
      assert.ok(
        readme.toUpperCase().includes(file.sha256.toUpperCase()),
        `хеш ${file.name} не указан в docs/ENGINES.md`,
      )
    }
  }
})
