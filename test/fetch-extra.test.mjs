/**
 * Дополнительные проверки загрузки: докачка через Range, сервер без Range,
 * несовпадение размера.
 * Запуск: node test/fetch-extra.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AssetError } from '../lib/errors.js'
import { downloadFile } from '../lib/fetch-file.js'

const payload = Buffer.from('x'.repeat(4096))
const digest = createHash('sha256').update(payload).digest('hex')

/** Сервер с поддержкой Range (как отдаёт GitHub). */
async function serveRanged({ honourRange = true } = {}) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push({ range: request.headers.range ?? null })
    if (!honourRange || !request.headers.range) {
      response.writeHead(200, { 'Content-Length': String(payload.length) })
      response.end(payload)
      return
    }
    const match = /bytes=(\d+)-/.exec(request.headers.range)
    const start = Number(match?.[1] ?? 0)
    const chunk = payload.subarray(start)
    response.writeHead(206, {
      'Content-Length': String(chunk.length),
      'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
    })
    response.end(chunk)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}/file`, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('докачка с Range: запрос начинается с середины файла', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fetch-range-'))
  const site = await serveRanged()
  try {
    const target = join(dir, 'file.bin')
    writeFileSync(`${target}.part`, payload.subarray(0, 1000))
    const bytes = await downloadFile({
      urls: [site.url],
      target,
      size: payload.length,
      sha256: digest,
      resource: 'file.bin',
    })
    assert.equal(bytes, payload.length)
    assert.deepEqual(site.requests[0].range, 'bytes=1000-')
    assert.equal(existsSync(`${target}.part`), false)
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('сервер без Range: файл качается заново', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fetch-norange-'))
  const site = await serveRanged({ honourRange: false })
  try {
    const target = join(dir, 'file.bin')
    writeFileSync(`${target}.part`, Buffer.alloc(1000, 0))
    const bytes = await downloadFile({
      urls: [site.url],
      target,
      size: payload.length,
      sha256: digest,
      resource: 'file.bin',
    })
    assert.equal(bytes, payload.length)
    assert.equal(existsSync(target), true)
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('неверный размер отвергается и .part удаляется', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fetch-size-'))
  const site = await serveRanged()
  try {
    const error = await downloadFile({
      urls: [site.url],
      target: join(dir, 'file.bin'),
      size: payload.length + 100,
      sha256: '',
      resource: 'file.bin',
    }).catch((problem) => problem)
    assert.ok(error instanceof AssetError)
    assert.equal(error.reason, 'integrity')
    assert.equal(existsSync(join(dir, 'file.bin.part')), false)
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('частичный .part больше ожидаемого сбрасывается', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fetch-bigpart-'))
  const site = await serveRanged()
  try {
    const target = join(dir, 'file.bin')
    writeFileSync(`${target}.part`, Buffer.alloc(payload.length + 500, 9))
    const bytes = await downloadFile({
      urls: [site.url],
      target,
      size: payload.length,
      sha256: digest,
      resource: 'file.bin',
    })
    assert.equal(bytes, payload.length)
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
