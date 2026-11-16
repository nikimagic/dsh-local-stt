# Комплект движков и моделей

Репозиторий плагина содержит **только код**. Бинарники движков и модели
весят около 1,6 ГБ и в Git/npm-пакет не входят.

Полный комплект раскладывается внутри установленного плагина:

```text
<plugin>\engines\
  fastflowlm\
    1.0.13\
      flm.exe
      *.dll
      share\
      xclbins\
    models\
      Whisper-V3-Turbo-NPU2\
        config.json
        model.q4nx
        tokenizer.json
        tokenizer_config.json
  audio-cpp\
    0.9.4\
      audiocpp_server.exe
      *.dll
      model_specs\
      config\
        audio-vulkan.json
     models\
       Orukeet-GGUF\
         orukeet-q8_0.gguf
```

## Источники

FastFlowLM 1.0.13:

```text
<исходный каталог>\flm\app\
```

Модель Whisper:

```text
<исходный каталог>\flm\models\models\Whisper-V3-Turbo-NPU2\
```

audio.cpp 0.9.4:

```text
<исходный каталог>\tts_cpp\bin\audio.cpp\
  audiocpp_server.exe
  *.dll
  model_specs\
```

Модель Orukeet:

```text
<исходный каталог>\tts_cpp\models\audio.cpp\Orukeet-GGUF\orukeet-q8_0.gguf
```

## Конфиг Orukeet

`engines\audio-cpp\0.9.4\config\audio-vulkan.json` содержит относительный
путь:

```json
"path": "../../models/Orukeet-GGUF/orukeet-q8_0.gguf"
```

Он разрешается относительно каталога `config`, поэтому переносится вместе
с плагином.

## Архивы для релиза

Плагин скачивает движки архивами из релиза GitHub (тег `engines-1`), чтобы не
раздувать историю репозитория. Сборка:

```text
node scripts/pack-engines.mjs
```

Скрипт собирает `dist\flm-1.0.13-win-x64.zip` и
`dist\audiocpp-0.9.4-win-x64.zip`, пишет их размер и SHA-256 в `lib/engines.js`
и печатает хеши. Далее архивы загружаются в релиз с этими именами:

```text
https://github.com/nikimagic/dsh-local-stt/releases/download/engines-1/flm-1.0.13-win-x64.zip
https://github.com/nikimagic/dsh-local-stt/releases/download/engines-1/audiocpp-0.9.4-win-x64.zip
```

Zip пишется своим модулем `lib/zip.js` с фиксированными датами записей,
поэтому повторная сборка из тех же файлов даёт те же байты и те же хеши.
Служебные каталоги `temp\` и `*.log` в архив не попадают.

Если тег или адрес другие, укажите базовый адрес в конфиге:

```yaml
- id: speech-to-text-local
  config:
    engines:
      baseUrl: https://example.com/engines
      dir: C:\dsh\engines
```

## Проверка

```text
node --check index.js
```

Запустить DSH и проверить оба провайдера. Если каталог движков вынесен
отдельно, задайте:

```text
DSH_LOCAL_STT_ENGINES=<путь к engines>
```

## Модели: источники и хеши

Ревизии закреплены в `lib/models.js`, поэтому содержимое файлов неизменно
и хеши не разъедутся. Проверяются размер и SHA-256.

### Whisper — `FastFlowLM/Whisper-V3-Turbo-NPU2`

Ревизия `594eecd2d80b20cbb04ef0099162335d1dd1899a`, кладётся в
`<plugin>\engines\fastflowlm\models\Whisper-V3-Turbo-NPU2\`.

| Файл | Размер, байт | SHA-256 |
|---|---:|---|
| `config.json` | 1 283 | `54481b3c31d2fc953ed383ec5670109bb4cbcaf1892e73ba568cbd23583688aa` |
| `tokenizer.json` | 2 710 337 | `297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd` |
| `tokenizer_config.json` | 282 897 | `c5486679eb96d17356cc53c6c3533009cc151d0015075f2eef482dfe8484c863` |
| `model.q4nx` | 650 175 128 | `8fb97604bf5762ee26efa696cfc9eb70724110358c7b4ca628a7973bf8a16291` |

### Orukeet — `audio-cpp/audio.cpp-gguf`

Ревизия `7a103b33f04120535bdfe97b5f65b79d3c90d708`, путь в репозитории
`Orukeet-GGUF/orukeet-q8_0.gguf`, кладётся в
`<plugin>\engines\audio-cpp\models\Orukeet-GGUF\`.

| Файл | Размер, байт | SHA-256 |
|---|---:|---|
| `orukeet-q8_0.gguf` | 915 908 144 | `420d78f2cb9c570127bfcef36c0e2b8f95e07f81c3722fece598d8c88fbd11ce` |

Скачивание и копирование выполняет сам плагин — см. [MODELS.md](MODELS.md).
