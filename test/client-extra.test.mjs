/**
 * Дополнительные проверки клиентского модуля: тексты при ошибке, при
 * незаполненных данных и подпись во время скачивания.
 * Запуск: node test/client-extra.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function build({ fetchImpl, providers }) {
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
  globalThis.fetch = fetchImpl
  const registrations = []
  const speech = {
    catalog: async () => ({ ok: true, value: { providers } }),
    prepare: async () => ({ ok: true }),
  }
  moduleExport.apply({
    get: (name) => (name === 'remote.speech' ? speech : undefined),
    slots: { inject: (_name, fn) => fn(), register: (options, Component) => registrations.push({ options, Component }) },
  })
  return { registrations, store }
}

const offlineFetch = async () => {
  throw new Error('нет сети')
}

async function run(component, props) {
  component(props).children[0].props.onClick()
  for (let index = 0; index < 80; index++) await new Promise((resolve) => setTimeout(resolve, 25))
}

test('провайдер в ошибке даёт соответствующий текст', async () => {
  const providers = [
    { id: 'whisper-npu', preparation: { phase: 'failed' } },
    { id: 'orukeet-vulkan', preparation: { phase: 'standby' } },
  ]
  const { registrations, store } = build({ fetchImpl: offlineFetch, providers })
  await run(registrations[0].Component, { subject: { pkg: { name: 'dsh-local-stt', version: '0.3.16' } } })
  assert.ok(store.some((value) => String(value).includes('движки и модели: ошибка')))
  assert.ok(store.some((value) => String(value).includes('проверить не удалось')))
})

test('провайдер не подготовлен — «нужно скачать»', async () => {
  const providers = [
    { id: 'whisper-npu', preparation: { phase: 'unprepared' } },
    { id: 'orukeet-vulkan', preparation: { phase: 'standby' } },
  ]
  const { registrations, store } = build({ fetchImpl: offlineFetch, providers })
  await run(registrations[0].Component, { subject: { pkg: { name: 'dsh-local-stt', version: '0.3.16' } } })
  assert.ok(store.some((value) => String(value).includes('нужно скачать')))
})

test('во время скачивания виден процент', async () => {
  let calls = 0
  const providers = [
    { id: 'whisper-npu', preparation: { phase: 'standby' } },
    { id: 'orukeet-vulkan', preparation: { phase: 'standby' } },
  ]
  const catalog = async () => {
    calls++
    if (calls === 2) {
      return {
        ok: true,
        value: {
          providers: [
            {
              id: 'whisper-npu',
              preparation: {
                phase: 'downloading',
                resource: 'flm-1.0.13-win-x64.zip',
                completedBytes: 50,
                totalBytes: 100,
              },
            },
            providers[1],
          ],
        },
      }
    }
    return { ok: true, value: { providers } }
  }
  const store = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const set = (next) => store.push(next)
      return [initial, set]
    },
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  }
  let moduleExport
  const window = { __ModuleLoader__: { load: ({ factory }) => { moduleExport = factory(() => React) } } }
  new Function('window', source)(window)
  globalThis.fetch = offlineFetch
  const registrations = []
  moduleExport.apply({
    get: () => ({ catalog, prepare: async () => ({ ok: true }) }),
    slots: { inject: (_name, fn) => fn(), register: (options, Component) => registrations.push({ options, Component }) },
  })
  await run(registrations[0].Component, { subject: { pkg: { name: 'dsh-local-stt', version: '0.3.16' } } })
  assert.ok(store.some((value) => String(value).includes('скачивание')))
  assert.ok(store.some((value) => String(value).includes('50%')))
})
