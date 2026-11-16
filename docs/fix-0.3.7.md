# 0.3.7 — модели в постоянном каталоге DSH

Модели перенесены из `Downloads\dsh_voice` в:

```text
C:\Users\admin\.dsh\models\local-stt\
  flm\models\Whisper-V3-Turbo-NPU2\
  orukeet\Orukeet-GGUF\orukeet-q8_0.gguf
```

SHA-256 после переноса совпал с исходным:

```text
Whisper: 8FB97604BF5762EE26EFA696CFC9EB70724110358C7B4CA628A7973BF8A16291
Orukeet: 420D78F2CB9C570127BFCEF36C0E2B8F95E07F81C3722FECE598D8C88FBD11CE
```

Обновлены:

- `FLM_MODEL_PATH` и `start-flm.bat`;
- путь Orukeet в `tts_cpp\config\audio-vulkan.json`;
- `modelPath` обоих провайдеров;
- README.

Проверка живых провайдеров:

```text
Whisper NPU  5,17 с  порт 52626 закрыт
Orukeet      4,34 с  порт 8028 закрыт
```

Публикация не выполнялась.
