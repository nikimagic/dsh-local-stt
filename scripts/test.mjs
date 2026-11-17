/**
 * Прогон всех тестов проекта одним запуском.
 *
 * Запуск: node scripts/test.mjs
 *
 * Каждый файл идёт отдельным процессом: тесты клиента подменяют глобальный
 * fetch, и в общем процессе это мешало бы остальным.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TESTS = join(ROOT, 'test')
const files = readdirSync(TESTS)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

let passed = 0
let failed = 0
const failures = []

for (const file of files) {
  const result = spawnSync(process.execPath, [join(TESTS, file)], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`
  const ok = (output.match(/✔/g) ?? []).length
  const bad = (output.match(/✖/g) ?? []).length
  passed += ok
  failed += bad
  const status = result.status === 0 && !result.error && !result.signal && bad === 0 ? 'ok  ' : 'FAIL'
  console.log(`${status} ${file.padEnd(30)} тестов ${String(ok).padStart(2)}, провалов ${bad}`)
  if (status === 'FAIL') {
    failures.push({ file, output })
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`\n===== ${failure.file} =====`)
    console.log(failure.output.slice(0, 4000))
  }
}

console.log(`\nвсего тестов: ${passed}, провалов: ${failed}, файлов: ${files.length}`)
process.exit(failed === 0 && failures.length === 0 ? 0 : 1)
