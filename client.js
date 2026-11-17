/**
 * Кнопка «Проверить обновления» в шапке карточки плагина.
 *
 * Проверяет три вещи: движки, модели (SHA-256 всех файлов) и наличие новой
 * версии плагина на GitHub. Живёт в слотовом списке `plugins.detail.actions`
 * и показывает себя только для пакета `dsh-local-stt`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-stt',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PACKAGE = 'dsh-local-stt'
    const REPO = 'nikimagic/dsh-local-stt'
    /** Только свои провайдеры: в каталоге могут быть чужие ASR-плагины. */
    const PROVIDERS = new Set(['whisper-npu', 'orukeet-vulkan'])

    function phaseLabel(provider) {
      const phase = provider.preparation?.phase ?? 'ready'
      if (phase === 'downloading') {
        const done = provider.preparation.completedBytes ?? 0
        const total = provider.preparation.totalBytes ?? 0
        const percent = total > 0 ? Math.floor((done / total) * 100) : 0
        return `скачивание ${provider.preparation.resource ?? ''} ${percent}%`.trim()
      }
      if (phase === 'loading') return 'распаковка движка'
      if (phase === 'checking') return 'сверка хешей'
      if (phase === 'unprepared') return 'нужно скачать'
      if (phase === 'failed') return 'ошибка'
      if (phase === 'cancelled') return 'отменено'
      return 'готово'
    }

    function busy(provider) {
      const phase = provider.preparation?.phase
      return ['checking', 'downloading', 'loading', 'waking', 'cancelling'].includes(phase)
    }

    function compareVersions(left, right) {
      const parse = (value) =>
        String(value).replace(/^v/i, '').split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0)
      const a = parse(left)
      const b = parse(right)
      for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const one = a[index] ?? 0
        const two = b[index] ?? 0
        if (one !== two) return one > two ? 1 : -1
      }
      return 0
    }

    /** Последняя версия плагина: сначала релизы GitHub, затем индекс jsDelivr. */
    async function latestVersion() {
      try {
        const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' },
          cache: 'no-store',
          signal: AbortSignal.timeout(6000),
        })
        if (response.ok) {
          const data = await response.json()
          if (typeof data?.tag_name === 'string' && data.tag_name) return data.tag_name
        }
      } catch {
        // Сеть или CORS — пробуем индекс.
      }
      try {
        const response = await fetch(`https://cdn.jsdelivr.net/gh/${REPO}@main/docs/index.json`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(6000),
        })
        if (response.ok) {
          const data = await response.json()
          const versions = data?.plugins?.[0]?.versions ?? []
          const last = versions[versions.length - 1]
          if (typeof last?.version === 'string') return last.version
        }
      } catch {
        // Ничего не осталось.
      }
      return undefined
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const speech = () => {
          try {
            return ctx.get('remote.speech')
          } catch {
            return undefined
          }
        }

        function CheckUpdates(props) {
          const [label, setLabel] = React.useState('Проверить обновления')
          const [summary, setSummary] = React.useState('')
          const [running, setRunning] = React.useState(false)
          const alive = React.useRef(true)

          React.useEffect(() => {
            alive.current = true
            return () => { alive.current = false }
          }, [])

          const subject = props?.subject
          const name = subject?.pkg?.name ?? subject?.name
          const installed = subject?.pkg?.version
          const ours = name === PACKAGE

          const readCatalog = async () => {
            const service = speech()
            if (!service) throw new Error('голосовой ввод не подключён')
            const result = await service.catalog()
            if (result && result.ok === false) throw result.error
            const providers = (result?.value ?? result)?.providers ?? []
            const ours = providers.filter((provider) => PROVIDERS.has(provider.id))
            const missing = [...PROVIDERS].filter((id) => !ours.some((provider) => provider.id === id))
            if (missing.length) throw new Error(`провайдеры недоступны: ${missing.join(', ')}`)
            return ours
          }

          const waitAssets = async () => {
            for (let attempt = 0; attempt < 600 && alive.current; attempt++) {
              const providers = await readCatalog()
              const active = providers.filter(busy)
              if (active.length === 0) return providers
              setSummary(phaseLabel(active[0]))
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }
            throw new Error(alive.current ? 'проверка не завершилась за 10 минут' : 'проверка прервана')
          }

          const orderOf = (pluginText) => (pluginText.startsWith('есть') ? 'Есть обновление' : 'Проверить обновления')

          const run = async () => {
            setRunning(true)
            setLabel('Проверка…')
            setSummary('сверка хешей')
            try {
              const service = speech()
              if (!service) throw new Error('голосовой ввод не подключён')
              const providers = await readCatalog()
              for (const provider of providers) {
                const result = await service.prepare(provider.id, undefined)
                if (result && result.ok === false) throw result.error
              }
              const settled = await waitAssets()
              const broken = settled.filter((provider) => provider.preparation?.phase === 'failed')
              const missing = settled.filter((provider) => provider.preparation?.phase === 'unprepared')
              const cancelled = settled.some((provider) => provider.preparation?.phase === 'cancelled')
              const ready = settled.every((provider) => ['ready', 'standby'].includes(provider.preparation?.phase))
              const assets = broken.length > 0 ? 'ошибка'
                : missing.length > 0 ? 'нужно скачать'
                  : cancelled ? 'отменено' : ready ? 'ок' : 'проверка не завершена'

              const remote = await latestVersion()
              let pluginText
              if (!remote) pluginText = 'проверить не удалось'
              else if (!installed) pluginText = `последняя ${remote}`
              else {
                const order = compareVersions(remote, installed)
                pluginText =
                  order > 0
                    ? `есть ${remote}`
                    : order < 0
                      ? `${installed} — локальная новее (${remote})`
                      : `${installed} — последняя`
              }

              if (!alive.current) return
              setRunning(false)
              setLabel(orderOf(pluginText))
              setSummary(`движки и модели: ${assets} · плагин: ${pluginText}`)
            } catch (error) {
              if (!alive.current) return
              setRunning(false)
              setLabel('Проверить обновления')
              setSummary(`ошибка: ${error instanceof Error ? error.message : String(error)}`)
            }
          }

          if (!ours) return null

          return h(
            'div',
            { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
            h(
              'button',
              {
                type: 'button',
                disabled: running,
                title: 'Проверяет движки и модели по SHA-256 и сверяет версию с GitHub',
                onClick: () => {
                  if (!running) void run()
                },
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))',
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  fontSize: 13,
                  cursor: running ? 'default' : 'pointer',
                  opacity: running ? 0.7 : 1,
                  whiteSpace: 'nowrap',
                },
              },
              h('span', { 'aria-hidden': true }, running ? '⏳' : '⟳'),
              h('span', null, label),
            ),
            summary
              ? h('span', { style: { fontSize: 12, opacity: 0.75, whiteSpace: 'nowrap' } }, summary)
              : null,
          )
        }

        try {
          ctx.slots.inject('plugins.detail.actions', () =>
            ctx.slots.register(
              { name: 'plugins.detail.actions', id: 'dsh-local-stt-check', order: 5 },
              CheckUpdates,
            ),
          )
        } catch (error) {
          console.warn('dsh-local-stt: слот действий карточки плагина недоступен', error)
        }
      },
    }
  },
})
