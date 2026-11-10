#Requires -Version 5.1
<#
.SYNOPSIS
  Download the local GigaAM v3 and whisper.cpp runtimes used by dsh-local-stt.

.DESCRIPTION
  Places everything under $env:USERPROFILE\.dsh by default, which is where the
  DSH providers look when no explicit paths are configured:

    .dsh\bin\gigastt\gigastt.exe
    .dsh\models\gigaam\...
    .dsh\bin\whisper\whisper-server.exe
    .dsh\models\ggml-large-v3-turbo-q5_0.bin

  No audio leaves the machine at runtime; this script only downloads the
  engines and models once.

.PARAMETER DshHome
  DSH home directory. Defaults to %USERPROFILE%\.dsh.

.PARAMETER SkipGigaam
  Do not install the GigaAM runtime/model.

.PARAMETER SkipWhisper
  Do not install the whisper.cpp runtime/model.
#>
[CmdletBinding()]
param(
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [switch]$SkipGigaam,
    [switch]$SkipWhisper
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # Windows PowerShell 5.1 normally has TLS 1.2 available.
}

function Write-Step([string]$Message) {
    Write-Host "`n== $Message ==" -ForegroundColor Cyan
}

function Get-RemoteFile([string]$Url, [string]$OutFile) {
    $parent = Split-Path -Parent $OutFile
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Write-Host "Downloading $Url"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -MaximumRedirection 10
    } catch {
        if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw }
        & curl.exe -L --fail --silent --show-error $Url -o $OutFile
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    }
}

function Assert-Sha256([string]$Path, [string]$Expected) {
    $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
        throw "SHA-256 mismatch for $Path`n  expected: $Expected`n  actual:   $actual"
    }
}

function Install-Archive([string]$Archive, [string]$Destination, [string]$Kind) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    if ($Kind -eq 'zip') {
        Expand-Archive -Path $Archive -DestinationPath $Destination -Force
    } else {
        & tar.exe -xzf $Archive -C $Destination
        if ($LASTEXITCODE -ne 0) { throw "tar failed for $Archive" }
    }
}

$DshHome = [IO.Path]::GetFullPath($DshHome)
Write-Host "DSH home: $DshHome"
New-Item -ItemType Directory -Force -Path $DshHome | Out-Null

$temp = Join-Path ([IO.Path]::GetTempPath()) ('dsh-local-stt-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null

try {
    if (-not $SkipGigaam) {
        Write-Step 'GigaAM v3 RNNT'
        $gigaDir = Join-Path $DshHome 'bin\gigastt'
        $gigaExe = Join-Path $gigaDir 'gigastt.exe'
        $gigaArchive = Join-Path $temp 'gigastt.tar.gz'
        $gigaUrl = 'https://github.com/ekhodzitsky/gigastt/releases/download/v2.22.0/gigastt-2.22.0-x86_64-pc-windows-msvc.tar.gz'
        $gigaSha = 'b703ce38aba3148a4433b7a648ea9542deb430cd16da66681992cbda288c775f'

        Get-RemoteFile $gigaUrl $gigaArchive
        Assert-Sha256 $gigaArchive $gigaSha
        Install-Archive $gigaArchive $gigaDir 'tar.gz'
        if (-not (Test-Path $gigaExe)) { throw "gigastt.exe was not extracted to $gigaDir" }

        $gigaModels = Join-Path $DshHome 'models\gigaam'
        New-Item -ItemType Directory -Force -Path $gigaModels | Out-Null
        Write-Step 'GigaAM model (INT8, RNNT)'
        & $gigaExe download --model-dir $gigaModels --model-variant rnnt --skip-diarization
        if ($LASTEXITCODE -ne 0) { throw "gigastt download failed with exit code $LASTEXITCODE" }

        Write-Step 'GigaAM punctuation model (RuPunct)'
        $punctDir = Join-Path $gigaModels 'punct'
        New-Item -ItemType Directory -Force -Path $punctDir | Out-Null
        $punctFiles = @(
            @{ Name = 'rupunct_small_int8.onnx'; Sha = 'b105da023474d98aa13ba18953ae67b04b17bd0595034bc06030c17536893933' },
            @{ Name = 'tokenizer.json';         Sha = '7ca617388c2092a3a84272025c52bbf3c6db0aee225c0351186295c0b5d3ddc6' },
            @{ Name = 'config.json';            Sha = '6924a8cf41ec2bd3a3aa73a387ae0ccd0aed253ec7cac4d2f53c7d27440891eb' }
        )
        foreach ($file in $punctFiles) {
            $out = Join-Path $punctDir $file.Name
            Get-RemoteFile ("https://huggingface.co/ekhodzitsky/rupunct-small-onnx/resolve/main/" + $file.Name) $out
            Assert-Sha256 $out $file.Sha
        }
    }

    if (-not $SkipWhisper) {
        Write-Step 'whisper.cpp (CPU)'
        $whisperDir = Join-Path $DshHome 'bin\whisper'
        $whisperArchive = Join-Path $temp 'whisper-bin-x64.zip'
        $whisperUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
        $whisperSha = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'

        Get-RemoteFile $whisperUrl $whisperArchive
        Assert-Sha256 $whisperArchive $whisperSha
        $whisperTemp = Join-Path $temp 'whisper'
        Install-Archive $whisperArchive $whisperTemp 'zip'
        $release = Join-Path $whisperTemp 'Release'
        if (-not (Test-Path $release)) { throw "Release directory not found in $whisperArchive" }
        New-Item -ItemType Directory -Force -Path $whisperDir | Out-Null
        Copy-Item -Path (Join-Path $release '*') -Destination $whisperDir -Recurse -Force

        Write-Step 'Whisper large-v3-turbo q5_0 model'
        $whisperModel = Join-Path $DshHome 'models\ggml-large-v3-turbo-q5_0.bin'
        Get-RemoteFile 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' $whisperModel
        Assert-Sha256 $whisperModel '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
    }

    Write-Host "`nDone." -ForegroundColor Green
    Write-Host "Restart DeepSeek Harness, then enable the providers in Plugins -> Voice Input."
} finally {
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
