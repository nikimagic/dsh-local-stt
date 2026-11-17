import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const ids = ['whisper-npu', 'orukeet-vulkan']
const roster = (phase) => ids.map((id) => ({ id, preparation: { phase } }))

async function run(catalog) {
  const updates = []
  const calls = []
  let Component
  let polls = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [value, (next) => updates.push(next)],
    useRef: (current) => ({ current }),
    useEffect: () => {},
  }
  const speech = {
    catalog: async () => ({ ok: true, value: { providers: typeof catalog === 'function' ? catalog(++polls) : catalog } }),
    prepare: async (id) => { calls.push(id); return { ok: true } },
  }
  const window = { __ModuleLoader__: { load({ factory }) {
    factory(() => React).apply({
      get: () => speech,
      slots: { inject: (_slot, fn) => fn(), register: (_options, component) => { Component = component } },
    })
  } } }
  new Function('window', 'fetch', 'setTimeout', source)(window,
    async () => ({ ok: true, json: async () => ({ tag_name: 'v0.3.16' }) }),
    (callback) => queueMicrotask(callback),
  )
  Component({ subject: { pkg: { name: 'dsh-local-stt', version: '0.3.16' } } }).children[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  return { updates, calls }
}

test('пустой и неполный каталоги не дают ложный успех', async () => {
  for (const providers of [[], roster('standby').slice(0, 1)]) {
    const { updates, calls } = await run(providers)
    assert.ok(updates.some((value) => String(value).includes('провайдеры недоступны')))
    assert.ok(!updates.some((value) => String(value).includes('движки и модели: ок')))
    assert.deepEqual(calls, [])
  }
})

test('отмена подготовки отображается как отмена, а не успех', async () => {
  const { updates, calls } = await run(roster('cancelled'))
  assert.deepEqual(calls, ids)
  assert.ok(updates.some((value) => String(value).includes('движки и модели: отменено')))
  assert.ok(!updates.some((value) => String(value).includes('движки и модели: ок')))
})

test('исчерпание опросов занятого провайдера даёт ошибку таймаута', async () => {
  const { updates } = await run(roster('downloading'))
  assert.ok(updates.some((value) => String(value).includes('не завершилась за 10 минут')))
  assert.ok(!updates.some((value) => String(value).includes('движки и модели: ок')))
})

test('исчезновение провайдера в ходе проверки не превращается в успех', async () => {
  const { updates } = await run((count) => count === 1 ? roster('standby') : [])
  assert.ok(updates.some((value) => String(value).includes('провайдеры недоступны')))
})

test('неизвестное состояние не считается готовностью', async () => {
  const { updates } = await run(roster('unknown'))
  assert.ok(updates.some((value) => String(value).includes('движки и модели: проверка не завершена')))
})

test('успех возможен, только когда оба провайдера готовы', async () => {
  const { updates } = await run(roster('standby'))
  assert.ok(updates.some((value) => String(value).includes('движки и модели: ок')))
})
