/**
 * Проверки каталога данных: путь по умолчанию, переопределения и перенос
 * раскладки из пакета.
 * Запуск: node test/paths.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { dshHome, migrateLegacyEngines, resolveEnginesDir } from '../lib/paths.js'

test('по умолчанию данные лежат в DSH_HOME\\dsh-local-stt\\engines', () => {
  const path = resolveEnginesDir({ env: { DSH_HOME: 'C:\\home\\.dsh' }, home: 'C:\\home' })
  assert.equal(path, join('C:\\home\\.dsh', 'dsh-local-stt', 'engines'))
})

test('без DSH_HOME берётся домашний каталог', () => {
  assert.equal(dshHome({}, 'C:\\home'), join('C:\\home', '.dsh'))
  assert.equal(resolveEnginesDir({ env: {}, home: 'C:\\home' }), join('C:\\home', '.dsh', 'dsh-local-stt', 'engines'))
})

test('конфиг важнее переменной, переменная важнее умолчания', () => {
  const env = { DSH_HOME: 'C:\\home\\.dsh', DSH_LOCAL_STT_ENGINES: 'C:\\env\\engines' }
  assert.equal(resolveEnginesDir({ configured: 'C:\\config\\engines', env, home: 'C:\\home' }), 'C:\\config\\engines')
  assert.equal(resolveEnginesDir({ env, home: 'C:\\home' }), 'C:\\env\\engines')
})

test('раскладка из пакета переносится в каталог данных', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-paths-move-'))
  try {
    const from = join(dir, 'node_modules', 'dsh-local-stt', 'engines')
    const to = join(dir, 'data', 'engines')
    mkdirSync(join(from, 'fastflowlm', '1.0.13'), { recursive: true })
    writeFileSync(join(from, 'fastflowlm', '1.0.13', 'flm.exe'), 'binary')

    const result = migrateLegacyEngines({ fromDir: from, toDir: to })
    assert.equal(result.moved, true)
    assert.equal(existsSync(from), false)
    assert.equal(readFileSync(join(to, 'fastflowlm', '1.0.13', 'flm.exe'), 'utf8'), 'binary')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('раскладку репозитория не переносим', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-paths-repo-'))
  try {
    const from = join(dir, 'project', 'engines')
    const to = join(dir, 'data', 'engines')
    mkdirSync(from, { recursive: true })
    const result = migrateLegacyEngines({ fromDir: from, toDir: to })
    assert.equal(result.moved, false)
    assert.equal(result.reason, 'not-installed')
    assert.equal(existsSync(from), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('занятый каталог данных не перезаписывается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-paths-busy-'))
  try {
    const from = join(dir, 'node_modules', 'pkg', 'engines')
    const to = join(dir, 'data', 'engines')
    mkdirSync(from, { recursive: true })
    writeFileSync(join(from, 'old.txt'), 'old')
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, 'new.txt'), 'new')

    const result = migrateLegacyEngines({ fromDir: from, toDir: to })
    assert.equal(result.moved, false)
    assert.equal(result.reason, 'target-exists')
    assert.equal(readFileSync(join(to, 'new.txt'), 'utf8'), 'new')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
