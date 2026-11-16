/**
 * Проверки своего zip: круговой обход, защита путей, битый архив.
 * Запуск: node test/zip.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { extractZip, writeZip } from '../lib/zip.js'

function workDir(name) {
  return mkdtempSync(join(tmpdir(), `dsh-zip-${name}-`))
}

test('запись и распаковка сохраняют байты и структуру', async () => {
  const dir = workDir('roundtrip')
  try {
    const binary = Buffer.alloc(200_000)
    for (let index = 0; index < binary.length; index++) binary[index] = index % 251
    const entries = [
      { name: 'a.txt', data: Buffer.from('привет') },
      { name: 'nested/b.bin', data: binary },
      { name: 'nested/deep/c.json', data: Buffer.from('{"ok":true}') },
    ]
    const archivePath = join(dir, 'test.zip')
    const written = await writeZip(entries, archivePath)
    assert.ok(written.size > 0)
    assert.match(written.sha256, /^[0-9a-f]{64}$/)
    assert.ok(statSync(archivePath).isFile())

    const destination = join(dir, 'out')
    const count = await extractZip(readFileSync(archivePath), destination)
    assert.equal(count, entries.length)
    for (const entry of entries) {
      assert.deepEqual(readFileSync(join(destination, entry.name)), entry.data, entry.name)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('запись воспроизводима: одинаковый вход даёт одинаковый архив', async () => {
  const dir = workDir('stable')
  try {
    const entries = [
      { name: 'x/one.txt', data: Buffer.from('one') },
      { name: 'two.txt', data: Buffer.from('two') },
    ]
    const first = await writeZip(entries, join(dir, '1.zip'))
    const second = await writeZip([...entries].reverse(), join(dir, '2.zip'))
    assert.equal(first.sha256, second.sha256)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('запись с выходом за каталог отвергается при распаковке', async () => {
  const dir = workDir('traversal')
  try {
    const archivePath = join(dir, 'evil.zip')
    await writeZip([{ name: '../escape.txt', data: Buffer.from('x') }], archivePath)
    await assert.rejects(
      () => extractZip(readFileSync(archivePath), join(dir, 'out')),
      /выходит за пределы каталога/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('битый архив отвергается', async () => {
  const dir = workDir('broken')
  try {
    await assert.rejects(() => extractZip(Buffer.from('not a zip at all'), join(dir, 'out')), /повреждён/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
