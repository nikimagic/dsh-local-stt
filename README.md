# dsh-local-stt

Local speech recognition for **DeepSeek Harness** on Windows. Two providers plug
into the official Voice Input bundle and appear in its provider switcher:

| Provider | Languages | Engine | Speed on a 4 s phrase |
|---|---|---|---:|
| **GigaAM v3 RNNT** | Russian | [gigastt](https://github.com/ekhodzitsky/gigastt) | ~0.25 s |
| **Whisper large-v3-turbo** | Russian, English, auto, … | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | ~9 s (CPU) |

The stock `@deepseek-ai/dsh-experimental-voice-input-bundle` remains in charge of
the microphone, WAV capture and settings. These packages only register additional
recognizers through `ctx.speechToText`. One microphone, one provider dropdown.

## Requirements

- Windows 10/11 x64.
- DeepSeek Harness `0.2.x` (tested on `0.2.2-rc.1`).
- About 1 GB free disk for both engines and models.
- Internet only for setup; recognition is local and sends no audio anywhere.

## Install

### 1. Download the engines and models

From a normal PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

The script verifies SHA-256 and installs into:

```text
%USERPROFILE%\.dsh\bin\gigastt\gigastt.exe
%USERPROFILE%\.dsh\models\gigaam\
%USERPROFILE%\.dsh\models\gigaam\punct\
%USERPROFILE%\.dsh\bin\whisper\whisper-server.exe
%USERPROFILE%\.dsh\models\ggml-large-v3-turbo-q5_0.bin
```

Use `-SkipWhisper` or `-SkipGigaam` to install only one engine:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1 -SkipWhisper
```

### 2. Add the plugin market

In DSH: **Plugins → More → Custom plugin markets → Add index source** and enter:

```text
https://nikimagic.github.io/dsh-local-stt/index.json
```

Install **GigaAM v3 Local** and/or **Whisper Local**. Restart DeepSeek Harness
after installation.

### 3. Choose a provider

**Plugins → Voice Input → Provider**:

- `GigaAM v3 RNNT (local)` — Russian, fastest, best Russian accuracy;
- `Whisper large-v3-turbo q5_0 (local)` — English and mixed speech;
- `SenseVoiceSmall (INT8)` — the stock provider, no Russian.

GigaAM RNNT is Russian-only. For English or mixed Russian/English, switch to
Whisper. If switching from Whisper with `en` to GigaAM, select `ru` first.

## Manual install (without the market)

The market path above is recommended. For a manual setup, install each package
from this repository into the profile with pnpm, add `dsh-local-gigaam` and
`dsh-local-whisper` to `dsh.profile.bundles` in
`~/.dsh/profiles/desktop/package.json`, then restart DSH. The provider defaults
point at the paths created by `setup.ps1`, so no YAML editing is required for a
standard `%USERPROFILE%\.dsh` installation.

## How it works

- `gigastt serve` is started on `127.0.0.1:9876`; the official API hands it a
  canonical 16 kHz mono PCM16 WAV and gets back `{ text, audioSeconds,
  inferenceSeconds }`.
- `whisper-server` is started on `127.0.0.1:8001` with the same result contract.
- Both servers bind loopback only. Audio never leaves the machine.
- `setup.ps1` pre-seeds every model, so recognition makes no network requests.

## Repository layout

```text
packages/dsh-local-gigaam/    GigaAM provider bundle
packages/dsh-local-whisper/   whisper.cpp provider bundle
docs/index.json               plugin-market index for Discover
docs/icons/                   market icons
setup.ps1                     engine/model downloader with checksums
```

## Licenses

Our code is MIT. The downloaded components keep their own licenses:

- [gigastt](https://github.com/ekhodzitsky/gigastt) — MIT;
- [GigaAM](https://github.com/salute-developers/GigaAM) — MIT;
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) — MIT;
- Whisper model weights — MIT (OpenAI);
- [RuPunct ONNX](https://huggingface.co/ekhodzitsky/rupunct-small-onnx) — see
  its model card.

Model binaries are not stored in this repository; `setup.ps1` downloads them
from their upstream releases.
