# SPDX-License-Identifier: GPL-3.0-or-later
# Puts the voice engine together, in the folder the app is built with (src-tauri\engine): ONNX Runtime as Microsoft
# publishes it, and eSpeak NG from its build, with the dictionaries of the languages that have voices in
# app/speech/voices.json only. It only copies files: it never loads the libraries.
param(
  [Parameter(Mandatory)] [string] $EspeakBuild,
  [Parameter(Mandatory)] [string] $EspeakSource,
  [Parameter(Mandatory)] [string] $OrtZip,
  [Parameter(Mandatory)] [string] $OrtSha256,
  [Parameter(Mandatory)] [string] $OrtVersion,
  [Parameter(Mandatory)] [string] $EspeakTag,
  # The folder of the Visual C++ redistributable: ONNX Runtime needs its C++ runtime beside it.
  [string] $Redist = '',
  [string] $Out = 'src-tauri/engine'
)
$ErrorActionPreference = 'Stop'

$found = (Get-FileHash -Algorithm SHA256 $OrtZip).Hash.ToLowerInvariant()
if ($found -ne $OrtSha256.ToLowerInvariant()) { throw "ONNX Runtime zip: SHA-256 $found, expected $OrtSha256" }

$root = Split-Path -Parent $PSScriptRoot
$catalog = Get-Content (Join-Path $root 'app/speech/voices.json') -Raw | ConvertFrom-Json
# The languages of the Piper voices and of the Kokoro voices: each needs its eSpeak dictionary.
$languages = @($catalog.voices) + @($catalog.kokoro.voices) | ForEach-Object { ($_.lang -split '-')[0].ToLowerInvariant() } | Sort-Object -Unique

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $Out 'LICENSES') | Out-Null
$work = Join-Path ([IO.Path]::GetTempPath()) ('engine-pack-' + [Guid]::NewGuid())
Expand-Archive $OrtZip -DestinationPath $work
$ort = Get-ChildItem $work -Directory | Select-Object -First 1
Copy-Item (Join-Path $ort.FullName 'lib/onnxruntime.dll') $Out
Copy-Item (Join-Path $ort.FullName 'LICENSE') (Join-Path $Out 'LICENSES/onnxruntime.txt')
Copy-Item (Join-Path $ort.FullName 'ThirdPartyNotices.txt') (Join-Path $Out 'LICENSES/ThirdPartyNotices-onnxruntime.txt')
Remove-Item $work -Recurse -Force

$espeak = Get-ChildItem $EspeakBuild -Recurse -Filter 'espeak-ng.dll' | Select-Object -First 1
if (-not $espeak) { throw "no espeak-ng.dll under $EspeakBuild" }
Copy-Item $espeak.FullName $Out
$data = Get-ChildItem $EspeakBuild -Recurse -Directory -Filter 'espeak-ng-data' |
  Where-Object { Test-Path (Join-Path $_.FullName 'phontab') } | Select-Object -First 1
if (-not $data) { throw "no compiled espeak-ng-data under $EspeakBuild" }
$target = Join-Path $Out 'espeak-ng-data'
Copy-Item $data.FullName $target -Recurse
foreach ($dict in Get-ChildItem $target -Filter '*_dict') {
  if ($languages -notcontains ($dict.Name -replace '_dict$', '')) { Remove-Item $dict.FullName }
}
foreach ($language in $languages) {
  if (-not (Test-Path (Join-Path $target "$($language)_dict"))) { throw "eSpeak NG has no dictionary for $language" }
}
Copy-Item (Join-Path $EspeakSource 'COPYING') (Join-Path $Out 'LICENSES/espeak-ng.txt')

$sources = @(
  "ONNX Runtime $OrtVersion (MIT): https://github.com/microsoft/onnxruntime/releases/tag/v$OrtVersion",
  "  onnxruntime-win-x64-$OrtVersion.zip, SHA-256 $OrtSha256",
  "eSpeak NG $EspeakTag (GPL-3.0-or-later): https://github.com/espeak-ng/espeak-ng/tree/$EspeakTag",
  '  built by .github/workflows/engine.yml of https://github.com/martindavinci/MochiReader;',
  "  its source is espeak-ng-$EspeakTag-source.tar.gz, in the release of MochiReader this engine came with.",
  "  Dictionaries kept: $($languages -join ', ')."
)
if ($Redist) {
  $crt = Get-ChildItem $Redist -Recurse -Directory -Filter 'Microsoft.VC14*.CRT' |
    Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
  if ($crt) {
    foreach ($dll in 'msvcp140.dll', 'vcruntime140_1.dll') {
      $path = Join-Path $crt.FullName $dll
      if (Test-Path $path) { Copy-Item $path $Out }
    }
    $sources += "Microsoft Visual C++ runtime, redistributable files of Visual Studio: $($crt.Name)"
  }
}
Set-Content -Encoding utf8 (Join-Path $Out 'SOURCES.txt') $sources
# Named parameters: with -NoNewline before a positional path, Set-Content writes nothing and says nothing.
Set-Content -LiteralPath (Join-Path $Out 'VERSION') -Value '1' -Encoding ascii -NoNewline

# The files the app looks for before it calls the engine ready (src-tauri/src/tts/engine_pack.rs).
foreach ($file in 'onnxruntime.dll', 'espeak-ng.dll', 'espeak-ng-data/phontab', 'VERSION') {
  if (-not (Test-Path -LiteralPath (Join-Path $Out $file) -PathType Leaf)) { throw "the engine has no $file" }
}

$bytes = (Get-ChildItem $Out -Recurse -File | Measure-Object -Sum Length).Sum
Write-Output "engine in $Out, $bytes bytes"
