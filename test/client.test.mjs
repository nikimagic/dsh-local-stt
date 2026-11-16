/**
 * Проверки клиентского модуля: регистрация, фильтр по пакету, запуск проверки,
 * тексты для новой/текущей версии и при недоступной сети.
 * Запуск: node test/client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function build({ fetchImpl, speech } = {}) {
  const store = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      let value = initial
      const set = (next) => {
        value = typeof next === 'function' ? next(value) : next
        store.push(value)
      }
      return [value, set]
    },
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  }

  let moduleExport
  const window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        moduleExport = factory((name) => {
          if (name === 'react') return React
          throw new Error('неожиданный require: ' + name)
        })
      },
    },
  }
  new Function('window', source)(window)

  if (fetchImpl) globalThis.fetch = fetchImpl
  const registrations = []
  const ctx = {
    get: (name) => (name === 'remote.speech' ? speech : undefined),
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, Component) => {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }
  moduleExport.apply(ctx)
  return { registrations, store }
}

const okSpeech = () => {
  const calls = []
  return {
    calls,
    catalog: async () => ({
      ok: true,
      value: {
        providers: [
          { id: 'whisper-npu', preparation: { phase: 'standby' } },
          { id: 'orukeet-vulkan', preparation: { phase: 'standby' } },
        ],
      },
    }),
    prepare: async (...args) => {
      if (args.length !== 2) throw new Error(`client api: speech/prepare expected 2 argument(s), got ${args.length}`)
      calls.push(args)
      return { ok: true }
    },
  }
}

function releaseFetch(tag) {
  return async (url) => {
    if (String(url).includes('api.github.com')) {
      if (!tag) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, json: async () => ({ tag_name: tag }) }
    }
    return {
      ok: true,
      json: async () => ({ plugins: [{ versions: [{ version: '0.3.0' }] }] }),
    }
  }
}


test('регистрируется в шапке карточки плагина', () => {
  const { registrations } = build({ fetchImpl: releaseFetch(''), speech: okSpeech() })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'plugins.detail.actions')
  assert.equal(registrations[0].options.id, 'dsh-local-stt-check')
})

test('на чужой карточке ничего не рисует', () => {
  const { registrations } = build({ fetchImpl: releaseFetch(''), speech: okSpeech() })
  const Component = registrations[0].Component
  assert.equal(Component({ subject: { pkg: { name: 'other-plugin' } } }), null)
  const ours = Component({ subject: { pkg: { name: 'dsh-local-stt', version: '0.3.12' } } })
  assert.ok(ours)
  assert.equal(ours.type, 'div')
})

test('нажатие вызывает prepare у обоих провайдеров', async () => {
  const speech = okSpeech()
  const { registrations } = build({ fetchImpl: releaseFetch('v0.3.12'), speech })
  const Component = registrations[0].Component
  Component({ subject: { pkg: { name: 'dsh-local-stt', version: '0.3.12' } } }).children[0].props.onClick()
  for (let i = 0; i < 40 && speech.calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(
    speech.calls.map((call) => call[0]),
    ['whisper-npu', 'orukeet-vulkan'],
  )
  for (const call of speech.calls) assert.equal(call.length, 2)
})

test('совпадение версий даёт «последняя»', async () => {
  const { registrations, store } = build({ fetchImpl: releaseFetch('v0.3.12'), speech: okSpeech() })
  const Component = registrations[0].Component
  Component({ subject: { pkg: { name: 'dsh-local-stt', version: '0.3.12' } } }).children[0].props.onClick()
  for (let i = 0; i < 80 && !store.some((value) => String(value).includes('плагин:')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const summary = store.find((value) => String(value).includes('плагин:'))
  assert.match(summary, /движки и модели: ок/)
  assert.match(summary, /0\.3\.12 — последняя/)
})

test('новая версия помечается', async () => {
  const { registrations, store } = build({ fetchImpl: releaseFetch('v0.3.13'), speech: okSpeech() })
  const Component = registrations[0].Component
  Component({ subject: { pkg: { name: 'dsh-local-stt', version: '0.3.12' } } }).children[0].props.onClick()
  for (let i = 0; i < 80 && !store.some((value) => String(value).includes('плагин:')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const summary = store.find((value) => String(value).includes('плагин:'))
  assert.match(summary, /есть v?0\.3\.13/)
  assert.ok(store.includes('Есть обновление'))
})

test('недоступная сеть не ломает проверку', async () => {
  const failing = async () => {
    throw new Error('нет сети')
  }
  const { registrations, store } = build({ fetchImpl: failing, speech: okSpeech() })
  const Component = registrations[0].Component
  Component({ subject: { pkg: { name: 'dsh-local-stt', version: '0.3.12' } } }).children[0].props.onClick()
  for (let i = 0; i < 80 && !store.some((value) => String(value).includes('плагин:')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const summary = store.find((value) => String(value).includes('плагин:'))
  assert.match(summary, /проверить не удалось/)
})

test('без голосового ввода показывает ошибку', async () => {
  const { registrations, store } = build({ fetchImpl: releaseFetch(''), speech: undefined })
  const Component = registrations[0].Component
  Component({ subject: { pkg: { name: 'dsh-local-stt', version: '0.3.12' } } }).children[0].props.onClick()
  for (let i = 0; i < 40 && !store.some((value) => String(value).startsWith('Ошибка:')); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(store.some((value) => String(value).includes('голосовой ввод не подключён')))
})

test('чужие ASR-провайдеры не запускаются', async () => {
  const calls = []
  const speech = {
    catalog: async () => ({
      ok: true,
      value: {
        providers: [
          { id: 'whisper-npu', preparation: { phase: 'standby' } },
          { id: 'orukeet-vulkan', preparation: { phase: 'standby' } },
          { id: 'someone-else', preparation: { phase: 'unprepared' } },
        ],
      },
    }),
    prepare: async (...args) => {
      calls.push(args[0])
      return { ok: true }
    },
  }
  const { registrations } = build({ fetchImpl: releaseFetch('v0.3.15'), speech })
  const Component = registrations[0].Component
  Component({ subject: { pkg: { name: 'dsh-local-stt', version: '0.3.15' } } }).children[0].props.onClick()
  for (let i = 0; i < 40 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(calls, ['whisper-npu', 'orukeet-vulkan'])
})
