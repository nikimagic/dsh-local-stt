import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { HUGGINGFACE, HUGGINGFACE_MIRROR, provisionModels } from '../lib/models.js'
import { provisionEngine } from '../lib/engines.js'
import { writeZip } from '../lib/zip.js'

const data = Buffer.from('verified-model')
const hash = (value) => createHash('sha256').update(value).digest('hex')
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stt-source-regression-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const localDir = join(dir, 'local')
  mkdirSync(join(localDir, 'models'), { recursive: true })
  writeFileSync(join(localDir, 'models', 'model.bin'), data)
  const model = { repo: 'test/model', revision: 'pinned', store: 'models', files: [
    { name: 'model.bin', remote: 'model.bin', size: data.length, sha256: hash(data) },
  ] }
  const target = join(dir, 'installed', 'model.bin')
  return { dir, localDir, model, target, targetFor: () => target }
}

test('официальный HF первый даже при наличии корректной локальной модели', async (t) => {
  const f = fixture(t)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(url); return new Response(data) })
  await provisionModels(f)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].startsWith(HUGGINGFACE + '/'))
  assert.deepEqual(readFileSync(f.target), data)
})

test('испорченная локальная модель не блокирует официальный источник', async (t) => {
  const f = fixture(t)
  writeFileSync(join(f.localDir, 'models', 'model.bin'), Buffer.alloc(data.length, 1))
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(data) })
  await provisionModels(f)
  assert.equal(calls, 1)
  assert.deepEqual(readFileSync(f.target), data)
})

test('неверный хеш HF не перескакивает через зеркало к локальной модели', async (t) => {
  const f = fixture(t)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url)
    return new Response(url.startsWith(HUGGINGFACE + '/') ? Buffer.alloc(data.length, 1) : data)
  })
  await provisionModels(f)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].startsWith(HUGGINGFACE + '/'))
  assert.ok(calls[1].startsWith(HUGGINGFACE_MIRROR + '/'))
  assert.deepEqual(readFileSync(f.target), data)
})

test('авторежим использует локальную модель только после HF и зеркала', async (t) => {
  const f = fixture(t)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(url); throw new Error('offline') })
  await provisionModels(f)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].startsWith(HUGGINGFACE + '/'))
  assert.ok(calls[1].startsWith(HUGGINGFACE_MIRROR + '/'))
  assert.deepEqual(readFileSync(f.target), data)
})

test('явный локальный выбор остаётся полностью офлайн', async (t) => {
  const f = fixture(t)
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('не должно быть сети') })
  await provisionModels({ ...f, source: pathToFileURL(f.localDir).href })
  assert.deepEqual(readFileSync(f.target), data)
})

test('явный HF не подменяется локальной копией после ошибки', async (t) => {
  const f = fixture(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('offline') })
  await assert.rejects(provisionModels({ ...f, source: HUGGINGFACE }))
  assert.equal(calls, 1)
  assert.equal(existsSync(f.target), false)
})

test('отмена локального потока не публикует файл и сохраняет старый target', async (t) => {
  const f = fixture(t)
  mkdirSync(join(f.dir, 'installed'), { recursive: true })
  writeFileSync(f.target, 'old-target')
  const controller = new AbortController()
  await assert.rejects(provisionModels({
    ...f, files: f.model.files, source: pathToFileURL(f.localDir).href,
    signal: controller.signal, onProgress: () => controller.abort(new Error('cancel-copy')),
  }), /cancel-copy/)
  assert.equal(readFileSync(f.target, 'utf8'), 'old-target')
})

test('заранее отменённое локальное копирование не создаёт target', async (t) => {
  const f = fixture(t)
  await assert.rejects(provisionModels({ ...f, source: pathToFileURL(f.localDir).href,
    signal: AbortSignal.abort(new Error('cancel-before-copy')) }), /cancel-before-copy/)
  assert.equal(existsSync(f.target), false)
})

async function engineFixture(t) {
  const f = fixture(t)
  const archive = join(f.dir, 'valid.zip')
  const written = await writeZip([{ name: 'tool.exe', data: Buffer.from('verified-binary') }], archive)
  return { ...f, archive, body: readFileSync(archive), engine: {
    id: 'tool', label: 'Tool', dir: 'tool/1', marker: 'tool.exe', archive: 'engine.zip',
    size: written.size, sha256: written.sha256,
    official: { url: 'https://official.example/engine.zip', size: written.size, sha256: written.sha256 },
  }, enginesDir: join(f.dir, 'engines'), baseUrl: 'https://reserve.example' }
}

test('официальный архив первый при наличии повреждённого локального', async (t) => {
  const f = await engineFixture(t)
  const badArchive = join(f.dir, 'bad.zip')
  writeFileSync(badArchive, 'bad')
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(url); return new Response(f.body) })
  await provisionEngine({ ...f, localArchive: badArchive })
  assert.deepEqual(calls, [f.engine.official.url])
  assert.equal(readFileSync(join(f.enginesDir, f.engine.dir, 'tool.exe'), 'utf8'), 'verified-binary')
})

test('локальный архив — резерв после недоступного официального', async (t) => {
  const f = await engineFixture(t)
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(url); throw new Error('offline') })
  await provisionEngine({ ...f, localArchive: f.archive })
  assert.deepEqual(calls, [f.engine.official.url])
})

test('испорченный локальный резерв не блокирует резервный релиз', async (t) => {
  const f = await engineFixture(t)
  const badArchive = join(f.dir, 'bad.zip')
  writeFileSync(badArchive, 'bad')
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url)
    if (url === f.engine.official.url) return new Response('', { status: 503 })
    return new Response(f.body)
  })
  await provisionEngine({ ...f, localArchive: badArchive })
  assert.deepEqual(calls, [f.engine.official.url, f.baseUrl + '/engine.zip'])
})
