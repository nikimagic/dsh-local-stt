/**
 * Кнопка «Проверить обновления» в карточке плагина.
 *
 * Регистрируется в списковый слот `plugins.detail.section`, который карточка
 * плагина рисует всегда, и показывает себя только для пакета `dsh-local-stt`.
 * Сервис голосового ввода берётся через `ctx.get`, поэтому кнопка появляется
 * даже если ремоут ещё не смонтирован.
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-stt',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PACKAGE = 'dsh-local-stt'

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
      return 'готово'
    }

    function busy(provider) {
      const phase = provider.preparation?.phase
      return phase === 'checking' || phase === 'downloading' || phase === 'loading'
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
          const [text, setText] = React.useState('Проверить обновления')
          const [running, setRunning] = React.useState(false)
          const alive = React.useRef(true)

          React.useEffect(() => () => {
            alive.current = false
          }, [])

          const subject = props?.subject
          const name = subject?.pkg?.name ?? subject?.name
          const ours = name === PACKAGE

          const readCatalog = async () => {
            const service = speech()
            if (!service) throw new Error('голосовой ввод не подключён')
            const result = await service.catalog()
            if (result && result.ok === false) throw result.error
            return (result?.value ?? result)?.providers ?? []
          }

          const wait = async () => {
            for (let attempt = 0; attempt < 600 && alive.current; attempt++) {
              const providers = await readCatalog()
              const active = providers.filter(busy)
              if (active.length === 0) {
                const failed = providers.filter((provider) => provider.preparation?.phase === 'failed')
                setRunning(false)
                setText(failed.length > 0 ? 'Ошибка подготовки — откройте голосовой ввод' : 'Проверка пройдена')
                return
              }
              setText(label(active[0]))
              await new Promise((resolve) => setTimeout(resolve, 1000))
            }
            if (alive.current) {
              setRunning(false)
              setText('Проверка идёт в фоне')
            }
          }

          const run = async () => {
            setRunning(true)
            setText('Проверка файлов')
            try {
              const service = speech()
              if (!service) throw new Error('голосовой ввод не подключён')
              const providers = await readCatalog()
              for (const provider of providers) {
                const result = await service.prepare(provider.id)
                if (result && result.ok === false) throw result.error
              }
              await wait()
            } catch (error) {
              if (!alive.current) return
              setRunning(false)
              setText(`Ошибка: ${error instanceof Error ? error.message : String(error)}`)
            }
          }

          if (!ours) return null

          return h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '4px 0 8px' } },
            h(
              'button',
              {
                type: 'button',
                disabled: running,
                title: 'Пересчитать SHA-256 движков и моделей и докачать недостающее',
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
                  cursor: running ? 'default' : 'pointer',
                  opacity: running ? 0.7 : 1,
                },
              },
              h('span', { 'aria-hidden': true }, running ? '⏳' : '⟳'),
              h('span', null, text),
            ),
            h('span', { style: { opacity: 0.7, fontSize: 12 } }, 'Сверяет движок и модели по SHA-256'),
          )
        }

        try {
          ctx.slots.inject('plugins.detail.section', () =>
            ctx.slots.register({ name: 'plugins.detail.section', id: 'dsh-local-stt-check', order: 10 }, CheckUpdates),
          )
        } catch (error) {
          console.warn('dsh-local-stt: слот карточки плагина недоступен', error)
        }
      },
    }
  },
})
