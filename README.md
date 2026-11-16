# dsh-local-stt

Локальный ASR для **штатного голосового ввода DeepSeek Harness**. Плагин
добавляет в переключатель провайдеров два варианта:

| Провайдер | Где считается | Роль |
|---|---|---|
| **Whisper large-v3-turbo (NPU)** | XDNA2 NPU через FastFlowLM | по умолчанию |
| **Orukeet r3 (Vulkan)** | Radeon 880M через audio.cpp | альтернатива |

Официальный `@deepseek-ai/dsh-experimental-voice-input-bundle` остаётся
хозяином микрофона, записи WAV и настроек. Плагин принимает готовый
16-кГц PCM16 WAV, запускает нужный C++-сервер, ждёт готовности, отправляет
аудио и останавливает сервер после ответа.

## Установка

В DSH откройте **Плагины → Добавить плагин** и укажите индекс:

```text
https://cdn.jsdelivr.net/gh/nikimagic/dsh-local-stt@main/docs/index.json
```

Установите `dsh-local-stt` и перезапустите DSH.

## Что запускается

Плагин не держит серверы в фоне. На каждое распознавание:

1. запускается `flm.exe` или `audiocpp_server.exe`;
2. плагин ждёт валидный `/v1/models` и `/health`;
3. WAV уходит на `127.0.0.1`;
4. после ответа процесс убивается, порт закрывается.

Питона в пути нет. Запускаются нативные C++-бинарники.

FastFlowLM:

```text
flm.exe serve --asr whisper-v3:turbo --port 52626
```

audio.cpp:

```text
audiocpp_server.exe --config audio-vulkan.json --port 8028 --no-ui
```

## Модели

Пути по умолчанию:

```text
FLM:      <root>\flm\models\models\Whisper-V3-Turbo-NPU2\model.q4nx
Orukeet:  <root>\tts_cpp\models\audio.cpp\Orukeet-GGUF\orukeet-q8_0.gguf
```

`<root>` — `C:\Users\admin\Downloads\dsh_voice` или значение переменной
`DSH_LOCAL_STT_ROOT`. Если модели нет, провайдер сразу переходит в `failed`
и не ждёт 90–120 секунд.

Модель Orukeet должна быть указана в `tts_cpp\config\audio-vulkan.json`.
Модель Whisper лежит в каталоге, на который указывает `FLM_MODEL_PATH`.

## Настройка

```yaml
- id: speech-to-text
  config:
    defaultProvider: whisper-npu
    language: ru
- id: speech-to-text-local
  config:
    whisper:
      baseUrl: http://127.0.0.1:52626
      model: whisper-v3:turbo
    orukeet:
      baseUrl: http://127.0.0.1:8028
      model: orukeet_q8_0
```

Можно переопределить `command`, `args`, `cwd`, `env`, `modelPath`,
`requestTimeoutMs`, `startupTimeoutMs` и `autoStart`. Порт в `args` можно
оставить как `{port}` — он подставится из `baseUrl`.

## Ограничения

- Официальная кнопка микрофона не отдаёт событие `mousedown`; провайдер
  получает WAV после остановки записи. Поэтому сервер стартует перед
  распознаванием, а не в момент клика. Для старта ровно по нажатию нужна
  своя клиентская кнопка.
- Cold start занимает около 4–5 секунд: загрузка модели при каждом запуске.
- Плагин проверяет, что на порту действительно FastFlowLM/audio.cpp, а не
  посторонний HTTP-сервис.
- Аудио не покидает машину, если `baseUrl` указывает на loopback.
