/**
 * Дополнительные проверки моделей: проверка хешей ничего не удаляет,
 * а подготовка чинит только испорченный файл.
 * Запуск: node test/models-extra.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { provisionModels, verifyModels } from '../lib/models.js'

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

const PRIMARY = Buffer.from('model-primary')
const SIDECAR = Buffer.from('model-config')

function makeModel(dir) {
  mkdirSync(join(dir, 'src', 'tool', 'models'), { recursive: true })
  writeFileSync(join(dir, 'src', 'tool', 'models', 'm.bin'), PRIMARY)
  writeFileSync(join(dir, 'src', 'tool', 'models', 'config.json'), SIDECAR)
  return {
    id: 'test',
    repo: 'test/test',
    revision: '0'.repeat(40),
    store: join('tool', 'models'),
    estimate: { recommendedDiskBytes: 1, expectedMemoryBytes: 1, minimumMinutes: 1, maximumMinutes: 1 },
    files: [
      { name: 'm.bin', remote: 'm.bin', size: PRIMARY.length, sha256: sha(PRIMARY) },
      { name: 'config.json', remote: 'config.json', size: SIDECAR.length, sha256: sha(SIDECAR) },
    ],
  }
}

test('проверка находит испорченный файл и не удаляет его', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-models-verify-'))
  try {
    const model = makeModel(dir)
    const targetDir = join(dir, 'install')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'm.bin'), Buffer.alloc(PRIMARY.length, 0))
    writeFileSync(join(targetDir, 'config.json'), SIDECAR)
    const targetFor = (file) => join(targetDir, file.name)

    const state = await verifyModels(model, targetFor)
    assert.deepEqual(state.broken.map((file) => file.name), ['m.bin'])
    assert.deepEqual(state.missing, [])
    assert.equal(existsSync(join(targetDir, 'm.bin')), true, 'файл не должен удаляться проверкой')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('подготовка перекачивает только указанный файл', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-models-repair-'))
  try {
    const model = makeModel(dir)
    const targetDir = join(dir, 'install')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'm.bin'), Buffer.alloc(PRIMARY.length, 0))
    writeFileSync(join(targetDir, 'config.json'), SIDECAR)
    const targetFor = (file) => join(targetDir, file.name)

    const state = await verifyModels(model, targetFor)
    const result = await provisionModels({
      model,
      targetFor,
      localDir: join(dir, 'src'),
      files: [...state.missing, ...state.broken],
    })
    assert.equal(result.files, 1)
    assert.deepEqual(readFileSync(join(targetDir, 'm.bin')), PRIMARY)
    assert.deepEqual(readFileSync(join(targetDir, 'config.json')), SIDECAR)
    assert.deepEqual(await verifyModels(model, targetFor), { missing: [], broken: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('без указания файлов качается всё недостающее', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-models-all-'))
  try {
    const model = makeModel(dir)
    const targetDir = join(dir, 'install')
    const result = await provisionModels({
      model,
      targetFor: (file) => join(targetDir, file.name),
      localDir: join(dir, 'src'),
    })
    assert.equal(result.files, 2)
    assert.deepEqual(readFileSync(join(targetDir, 'm.bin')), PRIMARY)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
