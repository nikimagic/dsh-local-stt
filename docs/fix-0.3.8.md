# 0.3.8 — движки и модели внутри плагина

Плагин переведён на раскладку:

```text
<plugin>\engines\
  fastflowlm\
    1.0.13\        flm.exe и runtime-файлы
    models\        Whisper-V3-Turbo-NPU2
  audio-cpp\
    0.9.4\         audiocpp_server.exe и DLL
    models\        Orukeet-GGUF\orukeet-q8_0.gguf
    config\        audio-vulkan.json
```

Пути теперь вычисляются от `import.meta.url`, а не от
`C:\Users\admin\Downloads\dsh_voice`. Переопределение каталога движков:
`DSH_LOCAL_STT_ENGINES`.

Для Orukeet создан отдельный минимальный конфиг только с моделью
`orukeet_q8_0`, без остальных 20 моделей. `TEMP` каталог создаётся
автоматически.

Проверка живых провайдеров:

```text
Whisper NPU  7,34 с  порт 52626 закрыт
Orukeet      6,29 с  порт 8028 закрыт
```

Публикация и push не выполнялись.
