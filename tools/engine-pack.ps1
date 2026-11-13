# SPDX-License-Identifier: GPL-3.0-or-later
# Puts the engine pack together from an eSpeak NG build and the ONNX Runtime zip of Microsoft, and prints its SHA-256
# and size for app/speech/voices.json. It only copies files: it never loads the libraries.
# Run it with PowerShell 7 (pwsh), whose zip writes the paths the way the app reads them.
param(
  [Parameter(Mandatory)] [string] $EspeakBuild,
  [Parameter(Mandatory)] [string] $EspeakSource,
  [Parameter(Mandatory)] [string] $OrtZip,
  [Parameter(Mandatory)] [string] $OrtSha256,
  [Parameter(Mandatory)] [string] $OrtVersion,
  [Parameter(Mandatory)] [string] $EspeakTag,
  # The folder of the Visual C++ redistributable: ONNX Runtime needs its C++ runtime beside it.
  [string] $Redist = '',
  [string] $Out = 'dist'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$name = 'mochireader-engine-1-windows-x64.zip'
$found = (Get-FileHash -Algorithm SHA256 $OrtZip).Hash.ToLowerInvariant()
if ($found -ne $OrtSha256.ToLowerInvariant()) { throw "ONNX Runtime zip: SHA-256 $found, expected $OrtSha256" }

$work = Join-Path ([IO.Path]::GetTempPath()) ('engine-pack-' + [Guid]::NewGuid())
$stage = Join-Path $work 'pack'
New-Item -ItemType Directory -Force (Join-Path $stage 'LICENSES') | Out-Null
Expand-Archive $OrtZip -DestinationPath (Join-Path $work 'ort')
$ort = Get-ChildItem (Join-Path $work 'ort') -Directory | Select-Object -First 1
Copy-Item (Join-Path $ort.FullName 'lib/onnxruntime.dll') $stage
Copy-Item (Join-Path $ort.FullName 'LICENSE') (Join-Path $stage 'LICENSES/onnxruntime.txt')
Copy-Item (Join-Path $ort.FullName 'ThirdPartyNotices.txt') (Join-Path $stage 'LICENSES/ThirdPartyNotices-onnxruntime.txt')

$espeak = Get-ChildItem $EspeakBuild -Recurse -Filter 'espeak-ng.dll' | Select-Object -First 1
if (-not $espeak) { throw "no espeak-ng.dll under $EspeakBuild" }
Copy-Item $espeak.FullName $stage
$data = Get-ChildItem $EspeakBuild -Recurse -Directory -Filter 'espeak-ng-data' |
  Where-Object { Test-Path (Join-Path $_.FullName 'phontab') } | Select-Object -First 1
if (-not $data) { throw "no compiled espeak-ng-data under $EspeakBuild" }
Copy-Item $data.FullName (Join-Path $stage 'espeak-ng-data') -Recurse
Copy-Item (Join-Path $EspeakSource 'COPYING') (Join-Path $stage 'LICENSES/espeak-ng.txt')

$sources = @(
  "ONNX Runtime $OrtVersion (MIT): https://github.com/microsoft/onnxruntime/releases/tag/v$OrtVersion",
  "  onnxruntime-win-x64-$OrtVersion.zip, SHA-256 $OrtSha256",
  "eSpeak NG $EspeakTag (GPL-3.0-or-later): https://github.com/espeak-ng/espeak-ng/tree/$EspeakTag",
  '  built by .github/workflows/engine.yml of https://github.com/martindavinci/MochiReader;',
  "  its source is espeak-ng-$EspeakTag-source.tar.gz, in the same release as this pack."
)
if ($Redist) {
  $crt = Get-ChildItem $Redist -Recurse -Directory -Filter 'Microsoft.VC14*.CRT' |
    Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
  if ($crt) {
    foreach ($dll in 'msvcp140.dll', 'vcruntime140_1.dll') {
      $path = Join-Path $crt.FullName $dll
      if (Test-Path $path) { Copy-Item $path $stage }
    }
    $sources += "Microsoft Visual C++ runtime, redistributable files of Visual Studio: $($crt.Name)"
  }
}
Set-Content -Encoding utf8 (Join-Path $stage 'SOURCES.txt') $sources
Set-Content -Encoding ascii -NoNewline (Join-Path $stage 'VERSION') '1'

New-Item -ItemType Directory -Force $Out | Out-Null
$zip = Join-Path (Resolve-Path $Out) $name
if (Test-Path $zip) { Remove-Item $zip }
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item $work -Recurse -Force

$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
$bytes = (Get-Item $zip).Length
Write-Output $name
Write-Output "sha256 $hash"
Write-Output "bytes  $bytes"
