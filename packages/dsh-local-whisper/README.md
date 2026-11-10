# dsh-local-whisper

Community provider for the **stock** `@deepseek-ai/dsh-experimental-voice-input-bundle`.
It does not replace the official microphone, settings page, or SenseVoice
provider. It registers a second recognizer (`local-whisper`) with the official
`speechToText` service, so the existing Voice Input provider dropdown gains a
Whisper option and the language dropdown gains `ru`/`en`/etc.

## What it does

- Accepts the canonical 16 kHz mono PCM16 WAV that the official UI already
  records and validates.
- Starts and stops `whisper-server` (whisper.cpp) on `127.0.0.1:8001`.
- Posts the WAV to `/inference` with the selected language and returns `text`.
- Keeps the model loaded between phrases; the server is reused.
- Never sends audio to a remote service.

## Files it expects

```text
C:\Users\admin\.dsh\bin\whisper\whisper-server.exe   (+ DLLs from the release)
C:\Users\admin\.dsh\models\ggml-large-v3-turbo-q5_0.bin
```

Any compatible ggml model works; point `whisperModel` at it.

## Profile override

`~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: speech-to-text
  config:
    defaultProvider: local-whisper
    language: ru
- id: speech-to-text-local-whisper
  config:
    whisperBin: C:\Users\admin\.dsh\bin\whisper\whisper-server.exe
    whisperModel: C:\Users\admin\.dsh\models\ggml-large-v3-turbo-q5_0.bin
    threads: 8
    autoStart: true
```

The provider dropdown still lists both recognizers. Selecting
`SenseVoiceSmall (INT8)` switches back to the stock provider; selecting
`Whisper large-v3-turbo q5_0 (local)` switches to whisper.cpp. The language
dropdown is provider-specific. If you switch back to SenseVoice, choose
`auto`/`en`/`zh` first: SenseVoice has no Russian and rejects the `ru` hint.

## Notes

- `whisper.cpp` allocates a 30-second encoder window even for short phrases, so
  latency on CPU is dominated by model size, not recording length. Measured on
  this machine with 8 threads: large-v3-turbo q5_0 ≈ 9–10 s per phrase,
  medium q5_0 ≈ 5.5–6 s, small q5_1 ≈ 2.1 s. A smaller model reduces latency at
  the cost of Russian accuracy.
- The provider exposes `ru`, `en`, `auto`, and several other Whisper language
  codes. The official UI translates the common ones; the rest appear as codes.
  Cantonese (`yue`) is mapped to `zh` because whisper.cpp has no `yue` hint.
- No ffmpeg is required: the official API already hands the provider a valid
  PCM16 WAV.
