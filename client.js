/**
 * Кнопка «Проверить обновления» в панели ввода.
 *
 * Клиентская половина плагина: пересчитывает хеши движка и моделей через
 * штатный `prepare()` провайдера и показывает ход проверки.
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-stt',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function label(provider) {
      const phase = provider.preparation?.phase ?? 'ready'
      if (phase === 'downloading') {
        const done = provider.preparation.completedBytes ?? 0
        const total = provider.preparation.totalBytes ?? 0
        const percent = total > 0 ? Math.floor((done / total) * 100) : 0
        return `скачивание ${provider.preparation.resource ?? ''} ${percent}%`.trim()
      }
      if (phase === 'loading') return 'распаковка движка'
      if (phase === 'checking') return 'проверка файлов'
      if (phase === 'unprepared') return 'нужно скачать'
      if (phase === 'failed') return 'ошибка подготовки'
      if (phase === 'cancelled') return 'отменено'
      if (phase === 'ready') return 'готово'
      return 'готово'
    }

    function isBusy(provider) {
      const phase = provider.preparation?.phase
      return phase === 'checking' || phase === 'downloading' || phase === 'loading'
    }

    return {
      inject: ['slots', 'remote'],
      apply(ctx) {
        function CheckUpdates() {
          const [text, setText] = React.useState('Проверить обновления')
          const [busy, setBusy] = React.useState(false)
          const alive = React.useRef(true)

          React.useEffect(() => () => {
            alive.current = false
          }, [])

          const readCatalog = async () => {
            const result = await ctx.remote.speech.catalog()
            if (result && result.ok === false) throw result.error
            return (result?.value ?? result)?.providers ?? []
          }

          const wait = async () => {
            for (let attempt = 0; attempt < 600 && alive.current; attempt++) {
              const providers = await readCatalog()
              const active = providers.filter(isBusy)
              if (active.length === 0) {
                const failed = providers.filter((provider) => provider.preparation?.phase === 'failed')
                const missing = providers.filter((provider) => provider.preparation?.phase === 'unprepared')
                setBusy(false)
                setText(
                  failed.length > 0
                    ? 'Ошибка подготовки — смотрите голосовой ввод'
                    : missing.length > 0
                      ? 'Нужно скачать — откройте голосовой ввод'
                      : 'Проверка пройдена',
                )
                return
              }
              setText(label(active[0]))
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }
            if (alive.current) {
              setBusy(false)
              setText('Проверка идёт в фоне')
            }
          }

          const run = async () => {
            setBusy(true)
            setText('Проверка файлов')
            try {
              const providers = await readCatalog()
              for (const provider of providers) {
                const result = await ctx.remote.speech.prepare(provider.id)
                if (result && result.ok === false) throw result.error
              }
              await wait()
            } catch (error) {
              if (!alive.current) return
              setBusy(false)
              setText(`Ошибка: ${error instanceof Error ? error.message : String(error)}`)
            }
          }

          return h(
            'button',
            {
              type: 'button',
              disabled: busy,
              title: 'Пересчитать хеши движков и моделей и докачать недостающее',
              onClick: () => {
                if (!busy) void run()
              },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontSize: 12,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.7 : 1,
              },
            },
            h('span', { 'aria-hidden': true }, busy ? '⏳' : '⟳'),
            h('span', null, text),
          )
        }

        try {
          ctx.slots.inject('conversation.composer.dock', () =>
            ctx.slots.register(
              { name: 'conversation.composer.dock', id: 'dsh-local-stt-check', order: 40 },
              CheckUpdates,
            ),
          )
        } catch (error) {
          console.warn('dsh-local-stt: слот панели ввода недоступен', error)
        }
      },
    }
  },
})
