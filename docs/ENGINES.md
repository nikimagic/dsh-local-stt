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

## Проверка

```text
node --check index.js
```

Запустить DSH и проверить оба провайдера. Если каталог движков вынесен
отдельно, задайте:

```text
DSH_LOCAL_STT_ENGINES=<путь к engines>
```

## Хеши моделей

```text
Whisper  8FB97604BF5762EE26EFA696CFC9EB70724110358C7B4CA628A7973BF8A16291
Orukeet  420D78F2CB9C570127BFCEF36C0E2B8F95E07F81C3722FECE598D8C88FBD11CE
```
