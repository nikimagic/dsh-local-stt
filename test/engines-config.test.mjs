/**
 * Проверки официального архива audio.cpp: в нём нет конфига плагина,
 * поэтому конфиг создаётся при установке.
 * Запуск: node test/engines-config.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { engineReady, provisionEngine, verifyEngine } from '../lib/engines.js'
import { writeZip } from '../lib/zip.js'

async function serveFile(path, name) {
  const body = readFileSync(path)
  const server = createServer((request, response) => {
    if (request.url !== `/${name}`) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Length': String(body.length) })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** Как в официальном архиве: бинарник и каталог спецификаций, без конфига. */
async function officialLikeArchive(dir) {
  const entries = [
    { name: 'audiocpp_server.exe', data: Buffer.from('server-binary') },
    { name: 'model_specs/parakeet_tdt.json', data: Buffer.from('{"family":"parakeet_tdt"}') },
  ]
  const archivePath = join(dir, 'audio-official.zip')
  const written = await writeZip(entries, archivePath)
  return { archivePath, ...written }
}

const audioEngine = (size, sha256) => ({
  id: 'audiocpp',
  label: 'audio.cpp 0.9.4',
  archive: 'audiocpp-0.9.4-win-x64.zip',
  size,
  sha256,
  dir: join('audio-cpp', '0.9.4'),
  marker: 'audiocpp_server.exe',
  required: ['audiocpp_server.exe', join('config', 'audio-vulkan.json')],
  config: {
    file: join('config', 'audio-vulkan.json'),
    model: '../../models/Orukeet-GGUF/orukeet-q8_0.gguf',
    port: 8028,
  },
})

test('конфиг создаётся, если официальный архив его не содержит', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audio-config-'))
  const serverState = {}
  try {
    const { archivePath, size, sha256 } = await officialLikeArchive(dir)
    const server = await serveFile(archivePath, 'audiocpp-0.9.4-win-x64.zip')
    serverState.close = server.close
    const engine = audioEngine(size, sha256)
    const enginesDir = join(dir, 'engines')

    const result = await provisionEngine({ engine, enginesDir, baseUrl: server.url })
    assert.equal(result.installed, true)
    assert.equal(engineReady(engine, enginesDir), true)

    const configPath = join(enginesDir, engine.dir, 'config', 'audio-vulkan.json')
    assert.equal(existsSync(configPath), true, 'конфиг не создан')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(config.port, 8028)
    assert.equal(config.backend, 'vulkan')
    assert.equal(config.models[0].path, '../../models/Orukeet-GGUF/orukeet-q8_0.gguf')
    assert.equal(config.models[0].task, 'asr')

    const verification = await verifyEngine(engine, enginesDir)
    assert.equal(verification.state, 'ok')
  } finally {
    await serverState.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('установленный движок без конфига ремонтируется, ничего не удаляя', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audio-repair-'))
  try {
    const engine = audioEngine(1, '0'.repeat(64))
    const enginesDir = join(dir, 'engines')
    const target = join(enginesDir, engine.dir)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'audiocpp_server.exe'), 'already-installed')

    const result = await provisionEngine({ engine, enginesDir, baseUrl: 'http://127.0.0.1:1' })
    assert.equal(result.installed, false)
    assert.equal(result.repaired, true)
    assert.equal(existsSync(join(target, 'config', 'audio-vulkan.json')), true)
    assert.equal(readFileSync(join(target, 'audiocpp_server.exe'), 'utf8'), 'already-installed')
    assert.equal(engineReady(engine, enginesDir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
