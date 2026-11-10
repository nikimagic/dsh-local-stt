# dsh-local-stt

Локальное распознавание речи для **DeepSeek Harness** на Windows. Два провайдера
подключаются к официальному голосовому вводу и появляются в его штатном
переключателе:

| Провайдер | Языки | Движок | Скорость на 4 с |
|---|---|---|---:|
| **GigaAM v3 RNNT** | русский | [gigastt](https://github.com/ekhodzitsky/gigastt) | ~0,25 с |
| **Whisper large-v3-turbo** | русский, английский, авто и др. | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | ~9 с (CPU) |

Официальный `@deepseek-ai/dsh-experimental-voice-input-bundle` остаётся
хозяином микрофона, записи WAV и настроек. Наши пакеты только добавляют
распознаватели через `ctx.speechToText`. Микрофон один, переключатель один.

Можно поставить **один общий плагин** `dsh-local-stt` — внутри сразу GigaAM и
Whisper, одна строка в списке плагинов. Либо поставить их отдельными пакетами
`dsh-local-gigaam` и `dsh-local-whisper`, если нужен только один движок.

## Требования

- Windows 10/11 x64.
- DeepSeek Harness `0.2.x` (проверено на `0.2.2-rc.1`).
- Около 1 ГБ свободного места для движков и моделей.
- Интернет только для установки; само распознавание локальное и никуда аудио
  не отправляет.

## Установка

### 1. Скачать движки и модели

В обычном PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Скрипт проверяет SHA-256 и раскладывает всё в:

```text
%USERPROFILE%\.dsh\bin\gigastt\gigastt.exe
%USERPROFILE%\.dsh\models\gigaam\
%USERPROFILE%\.dsh\models\gigaam\punct\
%USERPROFILE%\.dsh\bin\whisper\whisper-server.exe
%USERPROFILE%\.dsh\models\ggml-large-v3-turbo-q5_0.bin
```

Только один движок:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -SkipWhisper
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -SkipGigaam
```

### 2. Добавить индекс плагинов

Сначала убедитесь, что включён штатный бандл **«Голосовой ввод»** —
`@deepseek-ai/dsh-experimental-voice-input-bundle`. Без него не будет
микрофона, а наши провайдеры некуда подключать.

В DSH: **Плагины → Ещё → Пользовательские магазины плагинов → Добавить
источник индекса** и вставить:

```text
https://raw.githubusercontent.com/nikimagic/dsh-local-stt/main/docs/index.json
```

Установить **«GigaAM + Whisper — локально»** — это один плагин с обоими
провайдерами. Если нужен только один движок, установите **GigaAM v3 —
локально** или **Whisper — локально** отдельно. После установки перезапустить
DeepSeek Harness.

### 3. Выбрать провайдера

**Плагины → Голосовой ввод → Провайдер**:

- `GigaAM v3 RNNT (локально)` — русский, быстро, лучшая точность на русском;
- `Whisper large-v3-turbo q5_0 (локально)` — английский и смешанная речь;
- `SenseVoiceSmall (INT8)` — штатный провайдер, русского не знает.

GigaAM RNNT понимает только русский. Для английского или смешанной речи
переключитесь на Whisper. Если переключаетесь с Whisper (`en`) на GigaAM,
сначала выберите `ru`.

## Установка вручную (без магазина)

Рекомендуется путь через магазин. Для ручной установки:

```powershell
dsh plugin --profile desktop add nikimagic/dsh-local-stt
```

Либо добавьте корневой пакет в профиль через pnpm, пропишите
`dsh-local-stt` в `dsh.profile.bundles` файла
`~/.dsh/profiles/desktop/package.json` и перезапустите DSH. Пути по умолчанию
уже указывают на каталоги, которые создаёт `setup.ps1`, поэтому YAML править
не нужно.

## Как это работает

- `gigastt serve` слушает `127.0.0.1:9876`; официальный API отдаёт ему
  канонический WAV 16 кГц, моно, PCM16 и получает
  `{ text, audioSeconds, inferenceSeconds }`.
- `whisper-server` слушает `127.0.0.1:8001` с тем же форматом результата.
- Оба сервера слушают только loopback. Аудио не покидает машину.
- `setup.ps1` заранее скачивает все модели, поэтому при распознавании сеть не
  используется.

## Структура репозитория

```text
index.js                      корневой бандл: оба провайдера одним плагином
cordis.patch.yml              вставка корневого бандла в профиль
packages/dsh-local-gigaam/    провайдер GigaAM (можно ставить отдельно)
packages/dsh-local-whisper/   провайдер whisper.cpp (можно ставить отдельно)
docs/index.json               индекс для Discover
docs/icons/                   иконки магазина
setup.ps1                     загрузчик движков и моделей с проверкой SHA-256
```

## Лицензии

Наш код — MIT. Скачиваемые компоненты сохраняют свои лицензии:

- [gigastt](https://github.com/ekhodzitsky/gigastt) — MIT;
- [GigaAM](https://github.com/salute-developers/GigaAM) — MIT;
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) — MIT;
- веса Whisper — MIT (OpenAI);
- [RuPunct ONNX](https://huggingface.co/ekhodzitsky/rupunct-small-onnx) —
  см. карточку модели.

Модели в репозитории не хранятся; `setup.ps1` скачивает их из официальных
релизов.
