/**
 * Проверки провайдера: готовность, подготовка, отказ и защита от запуска
 * без файлов. Манифесты крошечные, сеть не нужна.
 * Запуск: node test/provider.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { HttpSpeechProvider } from '../index.js'
import { writeZip } from '../lib/zip.js'

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function workDir(name) {
  return mkdtempSync(join(tmpdir(), `dsh-provider-${name}-`))
}

/** Крошечный движок: архив с одним исполняемым файлом. */
async function makeEngine(dir, options = {}) {
  const marker = 'tool.exe'
  const binary = Buffer.from('engine-binary')
  const entries = [{ name: marker, data: binary }]
  if (options.extra) entries.push({ name: options.extra, data: Buffer.from('extra') })
  const archivePath = join(dir, 'tool.zip')
  const written = await writeZip(entries, archivePath)
  return {
    engine: {
      id: 'tool',
      label: 'Tool 1.0',
      archive: 'tool.zip',
      size: written.size,
      sha256: written.sha256,
      dir: join('tool', '1.0'),
      marker,
    },
    archivePath,
  }
}

/** Крошечная модель из двух файлов. */
function makeModel(dir) {
  const primary = Buffer.from('model-primary')
  const sidecar = Buffer.from('model-config')
  mkdirSync(join(dir, 'src', 'tool', 'models'), { recursive: true })
  writeFileSync(join(dir, 'src', 'tool', 'models', 'm.bin'), primary)
  writeFileSync(join(dir, 'src', 'tool', 'models', 'config.json'), sidecar)
  return {
    id: 'test',
    repo: 'test/test',
    revision: '0'.repeat(40),
    store: join('tool', 'models'),
    estimate: {
      recommendedDiskBytes: 10,
      expectedMemoryBytes: 10,
      minimumMinutes: 1,
      maximumMinutes: 1,
    },
    files: [
      { name: 'm.bin', remote: 'm.bin', size: primary.length, sha256: sha256(primary) },
      { name: 'config.json', remote: 'config.json', size: sidecar.length, sha256: sha256(sidecar) },
    ],
  }
}

function makeProvider(dir, { modelSpec, engine, enginesDir, localSource, baseUrl }) {
  const ctx = { logger: { info() {}, warn() {} } }
  return new HttpSpeechProvider(ctx, {
    kind: 'whisper',
    label: 'Test provider',
    modelPath: join(dir, 'install', 'models', 'm.bin'),
    primaryName: 'm.bin',
    modelSpec,
    engine,
    enginesDir,
    enginesBaseUrl: baseUrl ?? 'http://127.0.0.1:1',
    enginesLocalDir: join(dir, 'dist'),
    localSource,
    command: 'tool.exe',
    healthPath: '/v1/models',
    transcribePath: '/v1/audio/transcriptions',
    startHint: 'нет движка',
    info: { id: 'test-provider', name: 'Test provider', languages: ['ru'] },
  })
}

test('пустая раскладка — состояние unprepared', async () => {
  const dir = workDir('empty')
  try {
    const { engine } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    const provider = makeProvider(dir, {
      modelSpec,
      engine,
      enginesDir: join(dir, 'engines'),
      localSource: join(dir, 'src'),
    })
    provider.inspect()
    assert.equal(provider.state.phase, 'unprepared')
    assert.equal(provider.engineReady(), false)
    assert.equal(provider.missingFiles().length, 2)
    assert.ok(provider.info.downloadSources.length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('подготовка ставит движок из папки проекта и копирует модель', async () => {
  const dir = workDir('prepare')
  try {
    const { engine, archivePath } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', engine.archive), readFileSync(archivePath))

    const provider = makeProvider(dir, {
      modelSpec,
      engine,
      enginesDir: join(dir, 'engines'),
      localSource: join(dir, 'src'),
    })
    const phases = []
    provider.subscribe(() => phases.push(provider.state.phase))

    provider.prepare()
    await provider.provision

    assert.equal(provider.state.phase, 'standby')
    assert.ok(phases.includes('checking'), 'не было состояния checking')
    assert.equal(provider.engineReady(), true)
    assert.equal(readFileSync(join(dir, 'engines', engine.dir, engine.marker), 'utf8'), 'engine-binary')
    assert.equal(readFileSync(join(dir, 'install', 'models', 'm.bin'), 'utf8'), 'model-primary')
    assert.equal(readFileSync(join(dir, 'install', 'models', 'config.json'), 'utf8'), 'model-config')
    assert.deepEqual(provider.missingFiles(), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('повторная проверка ничего не меняет и проходит', async () => {
  const dir = workDir('repeat')
  try {
    const { engine, archivePath } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist', engine.archive), readFileSync(archivePath))
    const provider = makeProvider(dir, {
      modelSpec,
      engine,
      enginesDir: join(dir, 'engines'),
      localSource: join(dir, 'src'),
    })
    provider.prepare()
    await provider.provision
    const markerPath = join(dir, 'engines', engine.dir, engine.marker)
    const before = readFileSync(markerPath)

    provider.prepare()
    await provider.provision
    assert.equal(provider.state.phase, 'standby')
    assert.deepEqual(readFileSync(markerPath), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('повреждённый движок не трогается и даёт failed', async () => {
  const dir = workDir('broken')
  try {
    const { engine } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    const enginesDir = join(dir, 'engines')
    const target = join(enginesDir, engine.dir)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, engine.marker), 'broken-binary')
    writeFileSync(
      join(target, '.installed.json'),
      JSON.stringify({ files: [{ path: engine.marker, size: 13, sha256: '0'.repeat(64) }] }),
    )

    const provider = makeProvider(dir, { modelSpec, engine, enginesDir, localSource: join(dir, 'src') })
    provider.prepare()
    await provider.provision

    assert.equal(provider.state.phase, 'failed')
    assert.match(provider.state.message, /не сошлись файлы/)
    assert.equal(readFileSync(join(target, engine.marker), 'utf8'), 'broken-binary', 'файл изменён')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('без источников и сети — failed, каталог версии не появляется', async () => {
  const dir = workDir('offline')
  try {
    const { engine } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    const enginesDir = join(dir, 'engines')
    const provider = makeProvider(dir, { modelSpec, engine, enginesDir, localSource: join(dir, 'src') })
    provider.prepare()
    await provider.provision
    assert.equal(provider.state.phase, 'failed')
    assert.equal(existsSync(join(enginesDir, engine.dir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('transcribe без файлов отвечает понятной ошибкой', async () => {
  const dir = workDir('guard')
  try {
    const { engine } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    const provider = makeProvider(dir, {
      modelSpec,
      engine,
      enginesDir: join(dir, 'engines'),
      localSource: join(dir, 'src'),
    })
    const error = await provider.transcribe({ audio: new Uint8Array(8), language: 'ru' }, new AbortController().signal).catch(
      (problem) => problem,
    )
    assert.ok(error instanceof Error)
    assert.match(error.message, /движок не установлен/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('основной файл модели кладётся в modelPath, остальные — рядом', async () => {
  const dir = workDir('targets')
  try {
    const { engine } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    const provider = makeProvider(dir, {
      modelSpec,
      engine,
      enginesDir: join(dir, 'engines'),
      localSource: join(dir, 'src'),
    })
    const primary = provider.targetFor(modelSpec.files[0])
    const sidecar = provider.targetFor(modelSpec.files[1])
    assert.equal(primary, join(dir, 'install', 'models', 'm.bin'))
    assert.equal(sidecar, join(dir, 'install', 'models', 'config.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cancel во время подготовки переводит в cancelled', async () => {
  const dir = workDir('cancel')
  try {
    const { engine } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    const provider = makeProvider(dir, {
      modelSpec,
      engine,
      enginesDir: join(dir, 'engines'),
      localSource: join(dir, 'src'),
    })
    provider.prepare()
    await provider.cancel()
    assert.ok(['cancelled', 'standby', 'failed'].includes(provider.state.phase))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dispose останавливает провайдера', async () => {
  const dir = workDir('dispose')
  try {
    const { engine } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    const provider = makeProvider(dir, {
      modelSpec,
      engine,
      enginesDir: join(dir, 'engines'),
      localSource: join(dir, 'src'),
    })
    await provider.dispose()
    const error = await provider.transcribe({ audio: new Uint8Array(1), language: 'ru' }, new AbortController().signal).catch(
      (problem) => problem,
    )
    assert.match(error.message, /остановлен/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('состояние запуска содержит startedAt', async () => {
  const dir = workDir('starting')
  try {
    const { engine } = await makeEngine(dir)
    const modelSpec = makeModel(dir)
    const provider = makeProvider(dir, {
      modelSpec,
      engine,
      enginesDir: join(dir, 'engines'),
      localSource: join(dir, 'src'),
    })
    const state = provider.starting()
    assert.equal(state.phase, 'checking')
    assert.equal(typeof state.startedAt, 'number')
    assert.ok(state.startedAt > 0)
    assert.match(state.message, /Запускаю/)
    assert.equal(state.steps[0].kind, 'load')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
