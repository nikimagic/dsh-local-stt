# dsh-local-gigaam

Community provider for the **stock** `@deepseek-ai/dsh-experimental-voice-input-bundle`.
It registers `gigaam-local` with the official `speechToText` service, so the
existing Voice Input provider dropdown gains a GigaAM option next to
SenseVoice and Whisper.

## What it does

- Accepts the canonical 16 kHz mono PCM16 WAV that the official UI already
  records and validates.
- Starts and stops `gigastt serve` on `127.0.0.1:9876`.
- Posts the WAV to `/v1/transcribe` and returns the official result shape
  `{ text, audioSeconds, inferenceSeconds }`.
- Uses the `rnnt` head with RuPunct punctuation/casing and Russian ITN:
  the lowest-WER GigaAM v3 head for Russian.
- Keeps the model loaded between phrases.
- Never sends audio to a remote service.

## Files it expects

```text
C:\Users\admin\.dsh\bin\gigastt\gigastt.exe
C:\Users\admin\.dsh\models\gigaam\                 (v3_rnnt_*.onnx + v3_vocab.txt)
C:\Users\admin\.dsh\models\gigaam\punct\           (rupunct_small_int8.onnx + tokenizer/config)
```

## Profile override

`~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: speech-to-text
  config:
    defaultProvider: gigaam-local
    language: ru
- id: speech-to-text-gigaam
  config:
    gigasttBin: C:/Users/admin/.dsh/bin/gigastt/gigastt.exe
    modelDir: C:/Users/admin/.dsh/models/gigaam
    punctModelDir: C:/Users/admin/.dsh/models/gigaam/punct
    modelVariant: rnnt
    punctuation: "on"
    itn: "on"
    poolSize: 1
    autoStart: true
```

The provider dropdown still lists all recognizers. GigaAM's `rnnt` head is
Russian-only; for English or mixed Russian/English switch to Whisper, or
install/configure `ml_ctc_large` (600M, ru/en/kk/ky/uz) as a separate variant.

## Measured on this machine

`golos_00.wav`, 4.0 s Russian: **~250 ms**, transcript
`60000 тенге, сколько будет стоить?` — with punctuation and digits restored.
`gigastt` is substantially faster than CPU Whisper here because it is a
non-autoregressive transducer and does not allocate a 30-second window.

## Notes

- The server's `/health` answers while the model is loading; this provider waits
  on `/ready`, not on process liveness.
- `gigastt` downloads missing punctuation/ITN side models on first start. They
  are pre-seeded in this installation.
- `punctModelDir` is optional; when unset GigaAM uses its default
  `~/.gigastt/models/punct`.
