# SPDX-License-Identifier: GPL-3.0-or-later
# Reads a real document aloud for a long time with the window minimised, to see whether anything slows down or stops, the
# way a browser can slow down a page nobody is looking at. First without the flags that keep a page in the background
# awake, and with them only if that was not enough. Target: every delay between two sentences under 1 s, no voice errors.
#   listen-test.ps1 -File <document> [-Minutes 30] [-NoBuild]
# The document comes from outside: real ones stay out of the repo. A document shorter than the time is read again.
# Reads at a volume hardly heard, set for this test only. Exits 1 if the run missed the target, even with the flags.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$File,
  [int]$Minutes = 30,
  [switch]$NoBuild
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\app-process.ps1"

$TestVolume = '0.05'
$PollS = 5
$StartWaitS = 30
$DumpWaitMs = 1500
$CommandGapMs = 500
$SW_MINIMIZE = 6
$ToFlagsOfTheBackground = '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'
$OcclusionFeature = ',CalculateNativeWinOcclusion'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ListenWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@

function Send-App([string]$Arguments) {
  $start = New-Object System.Diagnostics.ProcessStartInfo $AppExe, $Arguments
  $start.UseShellExecute = $false
  [System.Diagnostics.Process]::Start($start).Dispose()
}

function Get-Report([string]$Out) {
  Remove-Item $Out -ErrorAction SilentlyContinue
  Send-App "--dump-tabs `"$Out`""
  $limit = (Get-Date).AddMilliseconds($DumpWaitMs)
  while ((Get-Date) -lt $limit) {
    if (Test-Path $Out) {
      try {
        return @(ConvertFrom-Json ([System.IO.File]::ReadAllText($Out, [System.Text.Encoding]::UTF8)) | ForEach-Object { $_ })[0]
      } catch [System.IO.IOException] {
        Write-Verbose "the report was being replaced: $_"
      }
    }
    Start-Sleep -Milliseconds $AppPollMs
  }
  $null
}

function Wait-Report([string]$Out, [scriptblock]$Done, [string]$Otherwise) {
  $limit = (Get-Date).AddSeconds($StartWaitS)
  while ($true) {
    $report = Get-Report $Out
    if ($report -and (& $Done $report)) { return }
    if ((Get-Date) -gt $limit) { throw $Otherwise }
  }
}

function Get-FlagsWithoutTheBackground {
  $conf = [System.IO.File]::ReadAllText((Join-Path $AppRoot 'src-tauri\tauri.conf.json')) | ConvertFrom-Json
  $flags = $conf.app.windows[0].additionalBrowserArgs
  foreach ($flag in $ToFlagsOfTheBackground) { $flags = $flags.Replace(" $flag", '') }
  $flags.Replace($OcclusionFeature, '')
}

function Assert-BrowserFlags([bool]$WithFlags) {
  $browser = @(Get-AppLeftovers | Where-Object { $_.Name -ne "$AppProcessName.exe" -and -not $_.CommandLine.Contains('--type=') })
  if ($browser.Count -ne 1) { throw "one browser for the run, found $($browser.Count)" }
  foreach ($flag in $ToFlagsOfTheBackground) {
    if ($browser[0].CommandLine.Contains($flag) -ne $WithFlags) {
      throw "the run is meant to go with flags: $WithFlags, and the browser runs on: $($browser[0].CommandLine)"
    }
  }
}

function Invoke-Run([string]$Label, [bool]$WithFlags, [string]$Work) {
  $log = Join-Path $Work "$Label.jsonl"
  $out = Join-Path $Work 'tabs.json'
  if ($WithFlags) { Remove-Item Env:MOCHIREADER_BROWSER_ARGS -ErrorAction SilentlyContinue }
  else { $env:MOCHIREADER_BROWSER_ARGS = Get-FlagsWithoutTheBackground }
  Wait-AppGone
  $app = Start-App @("`"$File`"")
  $iconicSamples = 0
  $normalSamples = 0
  $lastState = $null
  $minutesRun = 0
  $appEndedEarly = $false
  try {
    $window = Wait-AppWindow $app
    Assert-BrowserFlags $WithFlags
    Wait-Report $out { param($report) $report.status -eq 'ok' } 'the document did not open'
    Send-App "--speech-test-volume $TestVolume --speech-test-log `"$log`""
    Start-Sleep -Milliseconds $CommandGapMs
    Send-App '--speech speech.start'
    Wait-Report $out { param($report) $report.speech } 'reading did not start'
    [void][ListenWindow]::ShowWindow($window, $SW_MINIMIZE)
    $started = Get-Date
    $end = $started.AddMinutes($Minutes)
    while ((Get-Date) -lt $end) {
      Start-Sleep -Seconds $PollS
      if ($app.HasExited) {
        $appEndedEarly = $true
        break
      }
      if ([ListenWindow]::IsIconic($window)) { $iconicSamples += 1 } else { $normalSamples += 1 }
      $report = Get-Report $out
      # The document ended, which is no failure, and the time is not over: from the top again.
      if ($report -and -not $report.speech) {
        if ($report.toast) { $lastState = $report.toast; break }
        Send-App '--speech speech.start'
      }
    }
    $minutesRun = ((Get-Date) - $started).TotalMinutes
  } finally {
    Stop-App $app
    Remove-Item Env:MOCHIREADER_BROWSER_ARGS -ErrorAction SilentlyContinue
  }
  $report = & node (Join-Path $PSScriptRoot 'listen-log.mjs') $log $Minutes | ConvertFrom-Json
  $missed = @($report.missed)
  if ($appEndedEarly) { $missed += "the app ended by itself after $([math]::Round($minutesRun, 2)) minutes" }
  if ($normalSamples) { $missed += "the window was not minimised in $normalSamples samples of $($iconicSamples + $normalSamples)" }
  if ($lastState) { $missed += "the reading stopped with a message: $lastState" }
  "$Label, $([math]::Round($minutesRun, 2)) minutes: $($report.sentences) sentences, $($report.ended) ended, $($report.restarts) restarts, delay median $($report.medianDelayMs) ms, max $($report.maxDelayMs) ms, $($report.delaysOver1s) over 1 s, errors: $(@($report.errors).Count), minimised in $iconicSamples of $($iconicSamples + $normalSamples) samples"
  $missed | ForEach-Object { "  missed: $_" }
  if ($missed.Count) { 'FAIL' } else { 'PASS' }
}

Assert-AppNotRunning
if (-not $NoBuild) { Build-App @('--features', 'smoke') }
$AppExe = Join-Path $AppTarget 'debug\mochireader.exe'
$Work = Join-Path ([System.IO.Path]::GetTempPath()) "mochi-listen-$PID"
New-Item -ItemType Directory $Work | Out-Null
$env:MOCHIREADER_STATE_DIR = Join-Path $Work 'state'
New-Item -ItemType Directory $env:MOCHIREADER_STATE_DIR | Out-Null
$failed = $false
try {
  $plain = Invoke-Run 'without-flags' $false $Work
  $plain | Select-Object -SkipLast 1
  if ($plain[-1] -eq 'PASS') {
    'without the flags the target is met: the flags are not needed for this'
  } else {
    'without the flags the target is missed: the same again with them'
    $with = Invoke-Run 'with-flags' $true $Work
    $with | Select-Object -SkipLast 1
    if ($with[-1] -eq 'PASS') {
      'with the flags the target is met: they stay'
    } else {
      'with the flags too the target is missed'
      $failed = $true
    }
  }
} finally {
  Get-AppLeftovers | Where-Object { $_.Name -eq "$AppProcessName.exe" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item Env:MOCHIREADER_STATE_DIR -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
if ($failed) { exit 1 }
