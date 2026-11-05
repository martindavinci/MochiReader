# SPDX-License-Identifier: GPL-3.0-or-later
# Makes the portable zip from the release build: the program, the file that makes it portable, and the texts.
# Run it after `cargo tauri build`. The zip goes to src-tauri\target\release\bundle\portable.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
$exe = Join-Path $root 'src-tauri\target\release\mochireader.exe'
if (-not (Test-Path $exe)) { throw "no release build at $exe" }
$out = Join-Path $root 'src-tauri\target\release\bundle\portable'
New-Item -ItemType Directory -Force $out | Out-Null
$zipPath = Join-Path $out "MochiReader-$version-windows-x64-portable.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath }

$readme = @"
MochiReader $version, portable

Extract this folder anywhere you can write to, and run MochiReader.exe.
Settings, recent files, bookmarks and reading positions stay in the data folder here.
Nothing is written to the profile of the user.

The empty file named portable is what keeps it so: without it, MochiReader works like the installed app.
This copy does not register itself for .md and .epub files: use Open with, or drag files on the window.
It needs Microsoft Edge WebView2, which Windows 10 and 11 usually have already.

Source code: https://github.com/martindavinci/MochiReader
"@

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $exe, 'MochiReader.exe')
  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root 'LICENSE'), 'LICENSE.txt')
  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root 'app\licenses.txt'), 'licenses.txt')
  [void]$zip.CreateEntry('portable')
  $entry = $zip.CreateEntry('README.txt')
  $writer = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding $false))
  $writer.Write(($readme -replace "`r?`n", "`r`n"))
  $writer.Dispose()
} finally {
  $zip.Dispose()
}
$zipPath
