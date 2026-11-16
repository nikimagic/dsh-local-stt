/**
 * Ремонт движка через обычную подготовку провайдера: конфиг audio.cpp
 * дописывается, когда манифест старый или файл удалён.
 * Запуск: node test/provider-repair.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { HttpSpeechProvider } from '../index.js'

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

const CONFIG_FILE = join('config', 'audio-vulkan.json')

function makeEngine() {
  return {
    id: 'audiocpp',
    label: 'audio.cpp test',
    archive: 'audiocpp-test.zip',
    size: 1,
    sha256: '0'.repeat(64),
    dir: join('audio-cpp', '0.9.4'),
    marker: 'audiocpp_server.exe',
    required: ['audiocpp_server.exe', CONFIG_FILE],
    config: {
      file: CONFIG_FILE,
      model: '../../models/Orukeet-GGUF/orukeet-q8_0.gguf',
      port: 8028,
    },
  }
}

function makeModel(dir) {
  const primary = Buffer.from('model-primary')
  mkdirSync(join(dir, 'src', 'tool', 'models'), { recursive: true })
  writeFileSync(join(dir, 'src', 'tool', 'models', 'm.bin'), primary)
  return {
    id: 'test',
    repo: 'test/test',
    revision: '0'.repeat(40),
    store: join('tool', 'models'),
    estimate: { recommendedDiskBytes: 1, expectedMemoryBytes: 1, minimumMinutes: 1, maximumMinutes: 1 },
    files: [{ name: 'm.bin', remote: 'm.bin', size: primary.length, sha256: sha(primary) }],
  }
}

function makeProvider(dir) {
  return new HttpSpeechProvider(
    { logger: { info() {}, warn() {} } },
    {
      kind: 'orukeet',
      label: 'Test provider',
      modelPath: join(dir, 'install', 'orukeet-q8_0.gguf'),
      primaryName: 'orukeet-q8_0.gguf',
      modelSpec: makeModel(dir),
      engine: makeEngine(),
      enginesDir: join(dir, 'engines'),
      enginesBaseUrl: 'http://127.0.0.1:1',
      localSource: join(dir, 'src'),
      command: 'audiocpp_server.exe',
      healthPath: '/health',
      transcribePath: '/v1/audio/transcriptions',
      startHint: 'нет движка',
      info: { id: 'test-provider', name: 'Test provider', languages: ['ru'] },
    },
  )
}

function installEngineWithoutConfig(dir) {
  const engine = makeEngine()
  const target = join(dir, 'engines', engine.dir)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'audiocpp_server.exe'), 'server-binary')
  writeFileSync(
    join(target, '.installed.json'),
    JSON.stringify({
      files: [
        {
          path: 'audiocpp_server.exe',
          size: 13,
          sha256: sha(Buffer.from('server-binary')),
        },
      ],
    }),
  )
  return target
}

test('подготовка дописывает конфиг в старый манифест', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repair-stale-'))
  try {
    const target = installEngineWithoutConfig(dir)
    const provider = makeProvider(dir)
    assert.equal(provider.engineReady(), false, 'без конфига движок не готов')

    provider.prepare()
    await provider.provision

    assert.equal(provider.state.phase, 'standby')
    assert.equal(existsSync(join(target, CONFIG_FILE)), true)
    const manifest = JSON.parse(readFileSync(join(target, '.installed.json'), 'utf8'))
    assert.ok(
      manifest.files.some((file) => file.path.endsWith('audio-vulkan.json')),
      'конфиг не попал в манифест',
    )
    assert.equal(provider.engineReady(), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('удалённый конфиг из манифеста восстанавливается', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repair-deleted-'))
  try {
    const target = installEngineWithoutConfig(dir)
    const configPath = join(target, CONFIG_FILE)
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, '{"port":8028}')
    const manifestPath = join(target, '.installed.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.files.push({
      path: CONFIG_FILE.replaceAll('\\', '/'),
      size: 12,
      sha256: sha(Buffer.from('{"port":8028}')),
    })
    writeFileSync(manifestPath, JSON.stringify(manifest))
    rmSync(configPath)

    const provider = makeProvider(dir)
    provider.prepare()
    await provider.provision

    assert.equal(provider.state.phase, 'standby')
    assert.equal(existsSync(configPath), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('испорченный бинарник по-прежнему не ремонтируется', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repair-broken-'))
  try {
    const target = installEngineWithoutConfig(dir)
    writeFileSync(join(target, 'audiocpp_server.exe'), 'подменённый файл')
    const provider = makeProvider(dir)
    provider.prepare()
    await provider.provision

    assert.equal(provider.state.phase, 'failed')
    assert.equal(readFileSync(join(target, 'audiocpp_server.exe'), 'utf8'), 'подменённый файл')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
