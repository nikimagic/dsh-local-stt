/**
 * Единый бандл dsh-local-stt: регистрирует оба локальных провайдера —
 * GigaAM v3 и whisper.cpp — в штатном сервисе голосового ввода DSH.
 *
 * Отдельные пакеты packages/dsh-local-gigaam и packages/dsh-local-whisper
 * можно устанавливать и по отдельности. Этот корневой пакет нужен, чтобы
 * `dsh plugin add nikimagic/dsh-local-stt` ставил оба провайдера одной
 * командой и в списке плагинов была одна строка.
 */
import { apply as applyGigaam } from './packages/dsh-local-gigaam/index.js'
import { apply as applyWhisper } from './packages/dsh-local-whisper/index.js'

export const name = 'dsh-local-stt'
export const inject = ['speechToText']

/**
 * @param ctx - контекст DSH с сервисом speechToText.
 * @param rawConfig - необязательные секции gigaam и whisper.
 */
export function apply(ctx, rawConfig = {}) {
  applyGigaam(ctx, rawConfig.gigaam ?? {})
  applyWhisper(ctx, rawConfig.whisper ?? {})
}
