/** Регрессии загрузки: лимит потока, отмена, ошибки тела и безопасный Range. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { downloadFile } from '../lib/fetch-file.js'

const payload = Buffer.from('0123456789abcdef'.repeat(8192))
const digest = crypto.createHash('sha256').update(payload).digest('hex')

async function fixture(handler, run) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'dsh-fetch-regressions-'))
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const target = join(dir, 'file.bin')
  const options = {
    target, size: payload.length, sha256: digest, resource: 'file.bin',
    urls: [`http://127.0.0.1:${server.address().port}/first`, `http://127.0.0.1:${server.address().port}/mirror`],
  }
  try {
    await run(options)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function assertNotCommitted(target) {
  assert.equal(fs.existsSync(target), false)
}

test('oversized body never reaches the writer beyond expected size', async () => {
  await fixture((_req, res) => res.end(Buffer.alloc(payload.length + 4096)), async (options) => {
    const original = fs.createWriteStream
    let attempted = 0
    fs.createWriteStream = (...args) => {
      const writer = original(...args)
      const write = writer.write
      writer.write = function (chunk, ...rest) {
        attempted += chunk.length
        assert.ok(attempted <= options.size, 'oversized bytes reached the file writer')
        return write.call(this, chunk, ...rest)
      }
      return writer
    }
    syncBuiltinESMExports()
    try {
      await assert.rejects(downloadFile(options), (error) => error.reason === 'integrity')
      assertNotCommitted(options.target)
      assert.equal(fs.existsSync(`${options.target}.part`), false)
    } finally {
      fs.createWriteStream = original
      syncBuiltinESMExports()
    }
  })
})

test('preaborted full .part is not hashed, fetched or committed', async () => {
  let requests = 0
  await fixture((_req, res) => { requests++; res.end(payload) }, async (options) => {
    fs.writeFileSync(`${options.target}.part`, payload)
    const controller = new AbortController()
    const reason = new Error('preaborted')
    controller.abort(reason)
    await assert.rejects(downloadFile({ ...options, signal: controller.signal }), (error) => error === reason)
    assert.equal(requests, 0)
    assertNotCommitted(options.target)
    assert.deepEqual(fs.readFileSync(`${options.target}.part`), payload)
  })
})

for (const phase of ['update', 'digest']) {
  test(`abort during existing hash ${phase} prevents commit and mirror fallback`, async () => {
    let requests = 0
    await fixture((_req, res) => { requests++; res.end(payload) }, async (options) => {
      fs.writeFileSync(`${options.target}.part`, payload)
      const controller = new AbortController()
      const reason = new Error(`abort-${phase}`)
      const original = crypto.createHash
      let updates = 0
      crypto.createHash = (...args) => {
        const hash = original(...args)
        const method = hash[phase]
        hash[phase] = function (...values) {
          const result = method.apply(this, values)
          updates++
          controller.abort(reason)
          return result
        }
        return hash
      }
      syncBuiltinESMExports()
      try {
        await assert.rejects(downloadFile({ ...options, signal: controller.signal }), (error) => error === reason)
        assert.equal(updates, 1, 'hash processing stopped at abort')
        assert.equal(requests, 0)
        assertNotCommitted(options.target)
        assert.deepEqual(fs.readFileSync(`${options.target}.part`), payload)
      } finally {
        crypto.createHash = original
        syncBuiltinESMExports()
      }
    })
  })
}

test('broken body after headers resumes persisted prefix on mirror with correct Range and SHA-256', async () => {
  const prefix = 32768
  const requests = []
  await fixture((req, res) => {
    requests.push({ url: req.url, range: req.headers.range })
    if (req.url === '/first') {
      res.writeHead(200, { 'Content-Length': payload.length })
      res.write(payload.subarray(0, prefix))
      setTimeout(() => res.destroy(), 60)
    } else {
      const offset = Number(/^bytes=(\d+)-$/.exec(req.headers.range)?.[1])
      assert.equal(offset, prefix)
      res.writeHead(206, {
        'Content-Length': payload.length - offset,
        'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
      })
      res.end(payload.subarray(offset))
    }
  }, async (options) => {
    assert.equal(await downloadFile(options), payload.length)
    assert.deepEqual(fs.readFileSync(options.target), payload)
    assert.equal(fs.existsSync(`${options.target}.part`), false)
    assert.deepEqual(requests, [
      { url: '/first', range: undefined },
      { url: '/mirror', range: `bytes=${prefix}-` },
    ])
  })
})

test('incorrect Content-Range never appends and next mirror receives unchanged prefix', async () => {
  const prefix = 1000
  const requests = []
  await fixture((req, res) => {
    requests.push(req.headers.range)
    const offset = req.url === '/first' ? prefix + 1 : prefix
    res.writeHead(206, {
      'Content-Length': payload.length - offset,
      'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
    })
    res.end(payload.subarray(offset))
  }, async (options) => {
    fs.writeFileSync(`${options.target}.part`, payload.subarray(0, prefix))
    await downloadFile(options)
    assert.deepEqual(requests, [`bytes=${prefix}-`, `bytes=${prefix}-`])
    assert.deepEqual(fs.readFileSync(options.target), payload)
  })
})

test('mirror ignoring Range restarts after broken body rather than appending', async () => {
  const prefix = 1000
  const requests = []
  await fixture((req, res) => {
    requests.push(req.headers.range)
    if (req.url === '/first') {
      res.writeHead(200, { 'Content-Length': payload.length })
      res.write(payload.subarray(0, prefix))
      setTimeout(() => res.destroy(), 60)
    } else {
      res.writeHead(200, { 'Content-Length': payload.length })
      res.end(payload)
    }
  }, async (options) => {
    await downloadFile(options)
    assert.deepEqual(requests, [undefined, `bytes=${prefix}-`])
    assert.deepEqual(fs.readFileSync(options.target), payload)
  })
})

test('stall still times out after headers and permits a healthy mirror', async () => {
  const original = globalThis.setTimeout
  const requests = []
  await fixture((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'Content-Length': payload.length })
    if (req.url === '/first') res.flushHeaders()
    else res.end(payload)
  }, async (options) => {
    globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 60_000 ? 50 : delay, ...args)
    try {
      await downloadFile(options)
      assert.deepEqual(requests, ['/first', '/mirror'])
      assert.deepEqual(fs.readFileSync(options.target), payload)
    } finally {
      globalThis.setTimeout = original
    }
  })
})

test('abort while receiving body does not try the mirror', async () => {
  const requests = []
  const controller = new AbortController()
  await fixture((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'Content-Length': payload.length })
    res.write(payload.subarray(0, 1000))
  }, async (options) => {
    await assert.rejects(downloadFile({
      ...options, signal: controller.signal,
      onProgress: () => controller.abort(new Error('stop-body')),
    }), /stop-body/)
    assert.deepEqual(requests, ['/first'])
    assertNotCommitted(options.target)
    if (fs.existsSync(`${options.target}.part`)) assert.ok(fs.statSync(`${options.target}.part`).size <= options.size)
  })
})
