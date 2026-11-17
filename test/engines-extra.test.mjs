/**
 * Дополнительные проверки движков: отказ официального источника, неверный
 * локальный архив, занятый каталог, состояния проверки.
 * Запуск: node test/engines-extra.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AssetError } from '../lib/errors.js'
import { engineReady, provisionEngine, verifyEngine } from '../lib/engines.js'
import { writeZip } from '../lib/zip.js'

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function serve(routes) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    const body = routes[request.url]
    if (!body) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Length': String(body.length) })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function archiveWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-extra-'))
  const entries = Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) }))
  const path = join(dir, 'engine.zip')
  const written = await writeZip(entries, path)
  return { dir, path, buffer: readFileSync(path), ...written }
}

const engineOf = (written) => ({
  id: 'flm',
  label: 'FastFlowLM test',
  archive: 'engine.zip',
  size: written.size,
  sha256: written.sha256,
  dir: join('fastflowlm', '1.0.13'),
  marker: 'flm.exe',
  required: ['flm.exe'],
})

test('официальный источник 404 — берётся резервный', async () => {
  const { dir, buffer, size, sha256 } = await archiveWith({ 'flm.exe': 'reserve-binary' })
  const site = await serve({ '/engine.zip': buffer })
  try {
    const engine = {
      ...engineOf({ size, sha256 }),
      official: { url: `${site.url}/missing-official.zip`, size, sha256 },
    }
    const enginesDir = join(dir, 'engines')
    const result = await provisionEngine({ engine, enginesDir, baseUrl: site.url })
    assert.equal(result.installed, true)
    assert.equal(readFileSync(join(enginesDir, engine.dir, 'flm.exe'), 'utf8'), 'reserve-binary')
    assert.deepEqual(site.requests, ['/missing-official.zip', '/engine.zip'])
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('локальный архив с неверным хешем отвергается и не ставится', async () => {
  const { dir, path, size, buffer } = await archiveWith({ 'flm.exe': 'binary' })
  const site = await serve({ '/engine.zip': buffer })
  try {
    const engine = { ...engineOf({ size, sha256: '0'.repeat(64) }) }
    const enginesDir = join(dir, 'engines')
    const error = await provisionEngine({ engine, enginesDir, localArchive: path, baseUrl: site.url }).catch((problem) => problem)
    assert.ok(error instanceof AssetError)
    assert.equal(error.reason, 'integrity')
    assert.equal(existsSync(join(enginesDir, engine.dir)), false)
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('занятый каталог без исполняемого файла не перезаписывается', async () => {
  const { dir, path, size, sha256 } = await archiveWith({ 'flm.exe': 'binary' })
  try {
    const engine = engineOf({ size, sha256 })
    const enginesDir = join(dir, 'engines')
    const target = join(enginesDir, engine.dir)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'мусор.txt'), 'не наш файл')

    const error = await provisionEngine({ engine, enginesDir, localArchive: path }).catch((problem) => problem)
    assert.ok(error instanceof AssetError)
    assert.equal(error.reason, 'storage')
    assert.equal(readFileSync(join(target, 'мусор.txt'), 'utf8'), 'не наш файл')
    assert.equal(existsSync(join(target, 'flm.exe')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('проверка различает missing, unknown и broken', async () => {
  const { dir, size, sha256 } = await archiveWith({ 'flm.exe': 'binary' })
  try {
    const engine = engineOf({ size, sha256 })
    const enginesDir = join(dir, 'engines')
    assert.equal((await verifyEngine(engine, enginesDir)).state, 'missing')

    const target = join(enginesDir, engine.dir)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, engine.marker), 'binary')
    assert.equal((await verifyEngine(engine, enginesDir)).state, 'unknown')

    writeFileSync(
      join(target, '.installed.json'),
      JSON.stringify({ files: [{ path: engine.marker, size: 6, sha256: '0'.repeat(64) }] }),
    )
    const broken = await verifyEngine(engine, enginesDir)
    assert.equal(broken.state, 'broken')
    assert.deepEqual(broken.broken, [engine.marker])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('engineReady требует все обязательные файлы', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-required-'))
  try {
    const engine = {
      id: 'audiocpp',
      label: 'audio.cpp',
      archive: 'x.zip',
      size: 1,
      sha256: '0'.repeat(64),
      dir: join('audio-cpp', '0.9.4'),
      marker: 'audiocpp_server.exe',
      required: ['audiocpp_server.exe', join('config', 'audio-vulkan.json')],
    }
    const target = join(dir, engine.dir)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'audiocpp_server.exe'), 'server')
    assert.equal(engineReady(engine, dir), false, 'без конфига движок не готов')
    mkdirSync(join(target, 'config'), { recursive: true })
    writeFileSync(join(target, 'config', 'audio-vulkan.json'), '{}')
    assert.equal(engineReady(engine, dir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sha совпадает после установки: манифест покрывает файлы', async () => {
  const { dir, path, size, sha256 } = await archiveWith({ 'flm.exe': 'binary', 'share/data.txt': 'runtime' })
  try {
    const engine = engineOf({ size, sha256 })
    const enginesDir = join(dir, 'engines')
    await provisionEngine({ engine, enginesDir, localArchive: path })
    const manifest = JSON.parse(readFileSync(join(enginesDir, engine.dir, '.installed.json'), 'utf8'))
    const names = manifest.files.map((file) => file.path).sort()
    assert.deepEqual(names, ['flm.exe', 'share/data.txt'])
    assert.equal(manifest.archive, engine.archive)
    assert.equal(manifest.sha256, engine.sha256)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
