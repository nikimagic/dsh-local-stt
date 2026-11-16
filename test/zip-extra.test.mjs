/**
 * Дополнительные проверки zip: несжимаемые данные, юникод в именах,
 * вложенные каталоги.
 * Запуск: node test/zip-extra.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { extractZip, writeZip } from '../lib/zip.js'

const work = (name) => mkdtempSync(join(tmpdir(), `dsh-zip-extra-${name}-`))

test('несжимаемые данные сохраняются байт в байт', async () => {
  const dir = work('random')
  try {
    // псевдослучайные байты плохо сжимаются — проверяем ветку store
    const random = Buffer.alloc(64 * 1024)
    let seed = 12345
    for (let index = 0; index < random.length; index++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      random[index] = seed & 0xff
    }
    const archive = join(dir, 'r.zip')
    await writeZip([{ name: 'blob.bin', data: random }], archive)
    const destination = join(dir, 'out')
    await extractZip(readFileSync(archive), destination)
    assert.deepEqual(readFileSync(join(destination, 'blob.bin')), random)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('имена файлов на кириллице и вложенные каталоги', async () => {
  const dir = work('unicode')
  try {
    const entries = [
      { name: 'движки/модель.txt', data: Buffer.from('привет') },
      { name: 'движки/вложенно/глубоко.json', data: Buffer.from('{"ok":true}') },
      { name: 'README.md', data: Buffer.from('# test') },
    ]
    const archive = join(dir, 'u.zip')
    await writeZip(entries, archive)
    const destination = join(dir, 'out')
    const count = await extractZip(readFileSync(archive), destination)
    assert.equal(count, 3)
    for (const entry of entries) {
      assert.deepEqual(readFileSync(join(destination, entry.name)), entry.data, entry.name)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('пустые каталоги в архиве не мешают распаковке', async () => {
  const dir = work('dirs')
  try {
    const archive = join(dir, 'd.zip')
    await writeZip(
      [
        { name: 'dir/', data: Buffer.alloc(0) },
        { name: 'dir/file.txt', data: Buffer.from('data') },
      ],
      archive,
    )
    const destination = join(dir, 'out')
    mkdirSync(destination, { recursive: true })
    const count = await extractZip(readFileSync(archive), destination)
    assert.equal(count, 1)
    assert.equal(readFileSync(join(destination, 'dir', 'file.txt'), 'utf8'), 'data')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
