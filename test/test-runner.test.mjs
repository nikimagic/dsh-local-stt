import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// Запускаем настоящий код раннера с подменёнными процессами: без рекурсии
// (сам этот тест также входит в список scripts/test.mjs).
const source = readFileSync(new URL('../scripts/test.mjs', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '')
  .replace(/^const ROOT = .*$/m, 'const ROOT = "fixture"')

function run(result) {
  let exitCode
  const messages = []
  new Function('spawnSync', 'readdirSync', 'join', 'process', 'console', source)(
    () => result,
    () => ['fixture.test.mjs'],
    (...parts) => parts.join('/'),
    { execPath: 'node', env: {}, exit(code) { exitCode = code } },
    { log(message) { messages.push(message) } },
  )
  return { exitCode, messages }
}

test('авария тестового процесса без символа провала возвращает exit 1', () => {
  const result = run({ status: 1, stdout: '', stderr: 'SyntaxError: fixture' })
  assert.equal(result.exitCode, 1)
  assert.ok(result.messages.some((message) => message.includes('FAIL')))
})

test('невозможность запустить процесс возвращает exit 1 и диагностику', () => {
  const result = run({ status: null, error: new Error('spawn ENOENT') })
  assert.equal(result.exitCode, 1)
  assert.ok(result.messages.some((message) => message.includes('spawn ENOENT')))
})

test('убитый тестовый процесс не считается успешным', () => {
  assert.equal(run({ status: null, signal: 'SIGTERM', stdout: '' }).exitCode, 1)
})

test('успешный процесс и обычный провал имеют корректные коды', () => {
  assert.equal(run({ status: 0, stdout: '✔ fixture', stderr: '' }).exitCode, 0)
  assert.equal(run({ status: 0, stdout: '✖ fixture', stderr: '' }).exitCode, 1)
})
