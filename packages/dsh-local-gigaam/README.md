# dsh-local-gigaam

Локальный провайдер GigaAM v3 для **штатного** голосового ввода DeepSeek Harness.
Он не заменяет официальный микрофон и настройки, а добавляет распознаватель
`gigaam-local` в тот же сервис `ctx.speechToText`. В карточке «Голосовой ввод»
появляется выбор между GigaAM, Whisper и SenseVoice.

## Что делает

- Принимает канонический WAV 16 кГц, моно, PCM16, который уже записывает
  официальный интерфейс.
- Запускает и останавливает `gigastt serve` на `127.0.0.1:9876`.
- Отправляет WAV в `/v1/transcribe` и возвращает результат в формате
  `{ text, audioSeconds, inferenceSeconds }`.
- Использует голову `rnnt` с пунктуацией RuPunct и русским ITN — лучший WER
  GigaAM v3 на русском.
- Держит модель загруженной между фразами.
- Не отправляет аудио во внешние сервисы.

## Какие файлы нужны

```text
C:\Users\<пользователь>\.dsh\bin\gigastt\gigastt.exe
C:\Users\<пользователь>\.dsh\models\gigaam\              (v3_rnnt_*.onnx + v3_vocab.txt)
C:\Users\<пользователь>\.dsh\models\gigaam\punct\        (rupunct_small_int8.onnx + tokenizer/config)
```

Если пути стандартные, настраивать ничего не нужно: провайдер ищет их сам.
Скачать всё можно скриптом `setup.ps1` из корня репозитория.

## Настройка в профиле

`~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: speech-to-text
  config:
    defaultProvider: gigaam-local
    language: ru
- id: speech-to-text-gigaam
  config:
    gigasttBin: C:/Users/<пользователь>/.dsh/bin/gigastt/gigastt.exe
    modelDir: C:/Users/<пользователь>/.dsh/models/gigaam
    punctModelDir: C:/Users/<пользователь>/.dsh/models/gigaam/punct
    modelVariant: rnnt
    punctuation: "on"
    itn: "on"
    poolSize: 1
    autoStart: true
```

В выпадающем списке провайдеров по-прежнему видны все распознаватели.
GigaAM `rnnt` понимает только русский. Для английского или смешанной речи
переключитесь на Whisper либо настройте вариант `ml_ctc_large`
(600M, ru/en/kk/ky/uz) как отдельный экземпляр.

## Замер на этой машине

Файл `golos_00.wav`, 4,0 с русской речи: **~0,25 с**, текст
`60000 тенге, сколько будет стоить?` — с пунктуацией и цифрами.
`gigastt` быстрее CPU-Whisper, потому что это неавторегрессионный transducer:
он не считает фиксированное 30-секундное окно.

## Примечания

- `/health` отвечает уже во время загрузки модели; провайдер ждёт `/ready`,
  а не просто запуска процесса.
- Модель пунктуации при отсутствии может докачаться при первом старте. В этой
  установке она уже лежит локально.
- `punctModelDir` необязателен; без него GigaAM использует
  `~/.gigastt/models/punct`.
