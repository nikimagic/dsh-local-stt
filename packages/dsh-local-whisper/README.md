# dsh-local-whisper

Локальный провайдер whisper.cpp для **штатного** голосового ввода DeepSeek
Harness. Он не заменяет официальный микрофон и настройки, а добавляет
распознаватель `local-whisper` в тот же сервис `ctx.speechToText`. В карточке
«Голосовой ввод» появляется выбор между Whisper, GigaAM и SenseVoice.

## Что делает

- Принимает канонический WAV 16 кГц, моно, PCM16, который уже записывает
  официальный интерфейс.
- Запускает и останавливает `whisper-server` на `127.0.0.1:8001`.
- Отправляет WAV в `/inference` с выбранным языком и возвращает результат в
  формате `{ text, audioSeconds, inferenceSeconds }`.
- Держит модель загруженной между фразами.
- Не отправляет аудио во внешние сервисы.

## Какие файлы нужны

```text
C:\Users\<пользователь>\.dsh\bin\whisper\whisper-server.exe   (+ DLL из релиза)
C:\Users\<пользователь>\.dsh\models\ggml-large-v3-turbo-q5_0.bin
```

Подойдёт любая совместимая ggml-модель; укажите её в `whisperModel`.
Если пути стандартные, настраивать ничего не нужно: провайдер ищет их сам.
Скачать всё можно скриптом `setup.ps1` из корня репозитория.

## Настройка в профиле

`~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: speech-to-text
  config:
    defaultProvider: local-whisper
    language: ru
- id: speech-to-text-local-whisper
  config:
    whisperBin: C:/Users/<пользователь>/.dsh/bin/whisper/whisper-server.exe
    whisperModel: C:/Users/<пользователь>/.dsh/models/ggml-large-v3-turbo-q5_0.bin
    threads: 8
    processors: 1
    autoStart: true
```

В выпадающем списке провайдеров по-прежнему видны все распознаватели.
Whisper поддерживает русский, английский, автоопределение и другие языки.

## Скорость

`whisper.cpp` выделяет 30-секундное окно даже для короткой фразы, поэтому
задержка зависит в основном от размера модели:

| Модель | Время на фразу |
|---|---:|
| large-v3-turbo q5_0 | ~9–10 с |
| medium q5_0 | ~5,5–6 с |
| small q5_1 | ~2,1 с |

Для более быстрой диктовки замените `whisperModel` на small/medium — код
менять не нужно.

## Примечания

- Провайдер поддерживает языки `ru`, `en`, `auto` и ещё несколько кодов
  Whisper. Кантонский `yue` отправляется как `zh`, потому что в whisper.cpp
  нет отдельного `yue`.
- ffmpeg не нужен: официальный API уже отдаёт корректный PCM16 WAV.
