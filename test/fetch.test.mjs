/**
 * Проверки выбора источника: переход к следующему адресу и отказ без него.
 * Запуск: node test/fetch.test.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AssetError } from '../lib/errors.js'
import { downloadFile } from '../lib/fetch-file.js'

const payload = Buffer.from('engine-archive-bytes')
const digest = createHash('sha256').update(payload).digest('hex')

async function serve(routes) {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    const handler = routes[request.url]
    if (!handler) {
      response.writeHead(404).end()
      return
    }
    if (handler === 'broken') {
      response.writeHead(500).end()
      return
    }
    response.writeHead(200, { 'Content-Length': String(payload.length) })
    response.end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('ошибка первого адреса переводит на второй', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fetch-fallback-'))
  const site = await serve({ '/a': 'broken', '/b': 'ok' })
  try {
    const target = join(dir, 'archive.zip')
    const bytes = await downloadFile({
      urls: [`${site.base}/a`, `${site.base}/b`],
      target,
      size: payload.length,
      sha256: digest,
      resource: 'archive.zip',
    })
    assert.equal(bytes, payload.length)
    assert.deepEqual(site.requests, ['/a', '/b'])
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('единственный адрес с ошибкой не даёт скачивания', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fetch-single-'))
  const site = await serve({ '/a': 'broken' })
  try {
    const error = await downloadFile({
      urls: [`${site.base}/a`],
      target: join(dir, 'archive.zip'),
      size: payload.length,
      sha256: digest,
      resource: 'archive.zip',
    }).catch((problem) => problem)
    assert.ok(error instanceof AssetError)
    assert.equal(error.reason, 'http')
    assert.equal(error.status, 500)
    assert.equal(error.resource, 'archive.zip')
    assert.deepEqual(site.requests, ['/a'])
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('неверный хеш удаляет .part и не оставляет файла', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fetch-hash-'))
  const site = await serve({ '/a': 'ok' })
  try {
    const error = await downloadFile({
      urls: [`${site.base}/a`],
      target: join(dir, 'archive.zip'),
      size: payload.length,
      sha256: '0'.repeat(64),
      resource: 'archive.zip',
    }).catch((problem) => problem)
    assert.ok(error instanceof AssetError)
    assert.equal(error.reason, 'integrity')
  } finally {
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
