/**
 * Проверки движков: скачивание архива, распаковка, повторный запуск, хеш.
 * Запуск: node test/engines.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AssetError } from '../lib/errors.js'
import { engineReady, provisionEngine, verifyEngine } from '../lib/engines.js'
import { writeZip } from '../lib/zip.js'

async function serveArchive(archivePath, name) {
  const body = readFileSync(archivePath)
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    if (request.url !== `/${name}`) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Length': String(body.length) })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function buildArchive(dir, files) {
  const entries = Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) }))
  const archivePath = join(dir, 'flm-test.zip')
  const written = await writeZip(entries, archivePath)
  return { archivePath, ...written }
}

test('движок скачивается, распаковывается и больше не качается', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-'))
  const serverState = {}
  try {
    const { archivePath, size, sha256 } = await buildArchive(dir, {
      'flm.exe': 'binary-stub',
      'share/model.txt': 'runtime data',
      'xclbins/kernel.bin': Buffer.alloc(1024, 3),
    })
    const server = await serveArchive(archivePath, 'flm-test.zip')
    serverState.close = server.close
    const engine = {
      id: 'flm',
      label: 'FastFlowLM test',
      archive: 'flm-test.zip',
      size,
      sha256,
      dir: join('fastflowlm', '1.0.13'),
      marker: 'flm.exe',
    }
    const enginesDir = join(dir, 'engines')

    const first = await provisionEngine({ engine, enginesDir, baseUrl: server.url })
    assert.equal(first.installed, true)
    assert.equal(engineReady(engine, enginesDir), true)
    assert.equal(readFileSync(join(enginesDir, engine.dir, 'flm.exe'), 'utf8'), 'binary-stub')
    assert.equal(existsSync(join(enginesDir, engine.dir, 'share', 'model.txt')), true)

    const second = await provisionEngine({ engine, enginesDir, baseUrl: server.url })
    assert.equal(second.installed, false, 'готовый движок не должен качаться снова')
  } finally {
    await serverState.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('неверный хеш архива не принимается', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-bad-'))
  const serverState = {}
  try {
    const { archivePath, size } = await buildArchive(dir, { 'flm.exe': 'stub' })
    const server = await serveArchive(archivePath, 'flm-test.zip')
    serverState.close = server.close
    const engine = {
      id: 'flm',
      label: 'FastFlowLM test',
      archive: 'flm-test.zip',
      size,
      sha256: '0'.repeat(64),
      dir: join('fastflowlm', '1.0.13'),
      marker: 'flm.exe',
    }
    const error = await provisionEngine({ engine, enginesDir: join(dir, 'engines'), baseUrl: server.url }).catch(
      (problem) => problem,
    )
    assert.ok(error instanceof AssetError, 'ожидалась ошибка')
    assert.equal(error.reason, 'integrity')
    assert.equal(existsSync(join(dir, 'engines', 'fastflowlm')), false)
  } finally {
    await serverState.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('недоступный архив даёт ошибку с понятной причиной', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-404-'))
  const serverState = {}
  try {
    const { size, sha256 } = await buildArchive(dir, { 'flm.exe': 'stub' })
    const server = await serveArchive(join(dir, 'flm-test.zip'), 'other.zip')
    serverState.close = server.close
    const engine = {
      id: 'flm',
      label: 'FastFlowLM test',
      archive: 'flm-test.zip',
      size,
      sha256,
      dir: join('fastflowlm', '1.0.13'),
      marker: 'flm.exe',
    }
    const error = await provisionEngine({ engine, enginesDir: join(dir, 'engines'), baseUrl: server.url }).catch(
      (problem) => problem,
    )
    assert.ok(error instanceof AssetError)
    assert.equal(error.reason, 'http')
    assert.equal(error.status, 404)
  } finally {
    await serverState.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('проверка движка находит подменённый файл, а новую раскладку принимает', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-verify-'))
  const serverState = {}
  try {
    const { archivePath, size, sha256 } = await buildArchive(dir, {
      'flm.exe': 'binary-stub',
      'share/model.txt': 'runtime data',
    })
    const server = await serveArchive(archivePath, 'flm-test.zip')
    serverState.close = server.close
    const engine = {
      id: 'flm',
      label: 'FastFlowLM test',
      archive: 'flm-test.zip',
      size,
      sha256,
      dir: join('fastflowlm', '1.0.13'),
      marker: 'flm.exe',
    }
    const enginesDir = join(dir, 'engines')
    await provisionEngine({ engine, enginesDir, baseUrl: server.url })
    assert.equal((await verifyEngine(engine, enginesDir)).state, 'ok')

    writeFileSync(join(enginesDir, engine.dir, 'share', 'model.txt'), 'tampered')
    const broken = await verifyEngine(engine, enginesDir)
    assert.equal(broken.state, 'broken')
    assert.deepEqual(broken.broken, ['share/model.txt'])

    // Проверка только читает: без манифеста состояние unknown и ничего не пишется.
    rmSync(join(enginesDir, engine.dir, '.installed.json'), { force: true })
    const unknown = await verifyEngine(engine, enginesDir)
    assert.equal(unknown.state, 'unknown')
    assert.equal(existsSync(join(enginesDir, engine.dir, '.installed.json')), false)

    // Служебные файлы (логи, temp) на результат не влияют.
    writeFileSync(join(enginesDir, engine.dir, 'plugin.log'), 'runtime log')
    assert.equal((await verifyEngine(engine, enginesDir)).state, 'unknown')
  } finally {
    await serverState.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('архив без исполняемого файла не занимает каталог версии', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-nomarker-'))
  const serverState = {}
  try {
    const { archivePath, size, sha256 } = await buildArchive(dir, { 'share/data.txt': 'no binary here' })
    const server = await serveArchive(archivePath, 'flm-test.zip')
    serverState.close = server.close
    const engine = {
      id: 'flm',
      label: 'FastFlowLM test',
      archive: 'flm-test.zip',
      size,
      sha256,
      dir: join('fastflowlm', '1.0.13'),
      marker: 'flm.exe',
    }
    const enginesDir = join(dir, 'engines')
    const error = await provisionEngine({ engine, enginesDir, baseUrl: server.url }).catch((problem) => problem)
    assert.ok(error instanceof AssetError, 'ожидалась ошибка')
    assert.equal(error.reason, 'integrity')
    assert.equal(existsSync(join(enginesDir, engine.dir)), false, 'каталог версии не должен появиться')
    assert.equal(existsSync(join(enginesDir, '.cache', 'flm-staging')), false, 'staging не убран')
  } finally {
    await serverState.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('официальный архив главнее нашего резерва', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-engine-official-'))
  const serverState = {}
  try {
    const { archivePath, size, sha256 } = await buildArchive(dir, { 'flm.exe': 'official-binary' })
    const server = await serveArchive(archivePath, 'official.zip')
    serverState.close = server.close
    const engine = {
      id: 'flm',
      label: 'FastFlowLM test',
      archive: 'flm-test.zip',
      size,
      sha256,
      dir: join('fastflowlm', '1.0.13'),
      marker: 'flm.exe',
      official: { url: `${server.url}/official.zip`, size, sha256 },
    }
    // Наш резервный адрес заведомо недоступен: если возьмётся официальный, установка пройдёт.
    const enginesDir = join(dir, 'engines')
    const result = await provisionEngine({
      engine,
      enginesDir,
      baseUrl: 'http://127.0.0.1:1',
    })
    assert.equal(result.installed, true)
    assert.equal(readFileSync(join(enginesDir, engine.dir, 'flm.exe'), 'utf8'), 'official-binary')
    assert.deepEqual(server.requests, ['/official.zip'])
  } finally {
    await serverState.close?.()
    rmSync(dir, { recursive: true, force: true })
  }
})
