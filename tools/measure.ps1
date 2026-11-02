# SPDX-License-Identifier: GPL-3.0-or-later
# Repeatable startup measures of the release build. Every mode prints medians, in ms.
#   measure.ps1 -File <path> [-Runs 5]           process start to the page's second frame, seen from inside.
#                                                For comparison only: it ends before the window is on screen.
#   measure.ps1 -Screen -File <path> [-Runs 5]   process start to the text on screen, seen by tools/observer.cs.
#                                                This one decides the target: text at 90% of its final contrast.
#   measure.ps1 -Warm -File <path> [-Runs 5]     launch of a second process to the file shown in the running app.
#   measure.ps1 -Memory -File <path>             all the memory of the app with the file open.
# Add -NoBuild to measure the exe already built, or -Exe <path> to measure another one.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$File,
  [int]$Runs = 5,
  [switch]$Screen,
  [switch]$Warm,
  [switch]$Memory,
  [switch]$NoBuild,
  [string]$Exe
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\app-process.ps1"

$HoldMs = 2000
$WarmTimeoutS = 10
$WarmSettleMs = 300
$MemorySettleS = 5
$DotNetFolder = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"

function Get-Median([double[]]$Values) {
  $sorted = @($Values | Sort-Object)
  $middle = [math]::Floor($sorted.Count / 2)
  if ($sorted.Count % 2) { return $sorted[$middle] }
  return ($sorted[$middle - 1] + $sorted[$middle]) / 2
}

function Show-Series([string]$Name, [double[]]$Values) {
  $rounded = ($Values | ForEach-Object { [math]::Round($_, 1) }) -join ' / '
  '{0,-22} median {1,7:F1} ms   runs {2}' -f $Name, (Get-Median $Values), $rounded
}

function Invoke-InsideRuns {
  $reports = foreach ($run in 1..$Runs) {
    Wait-AppGone
    $start = New-Object System.Diagnostics.ProcessStartInfo $AppExe, "--measure `"$File`""
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    # WebView2 complains there as it closes, and nothing there is a measure.
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    $process.BeginErrorReadLine()
    $output = $process.StandardOutput.ReadToEnd()
    $process.WaitForExit()
    if (-not $output.Trim()) { throw "run $run wrote no time" }
    $output | ConvertFrom-Json
  }
  Wait-AppGone
  Show-Series 'second frame, inside' ($reports | ForEach-Object { $_.paintMs })
  Show-Series 'window shown, inside' ($reports | ForEach-Object { $_.shownMs })
}

function Invoke-ScreenRuns {
  $work = Join-Path $AppTarget 'measure'
  New-Item -ItemType Directory -Force $work | Out-Null
  $observer = Join-Path $work 'observer.exe'
  & "$DotNetFolder\csc.exe" /nologo /optimize /target:exe /r:System.Drawing.dll "/out:$observer" "$PSScriptRoot\observer.cs" | Write-Verbose
  if ($LASTEXITCODE) { throw 'the observer did not compile' }
  $results = Join-Path $work 'screen.jsonl'
  Remove-Item $results -ErrorAction SilentlyContinue
  foreach ($run in 1..$Runs) {
    Wait-AppGone
    & $observer $AppExe $File $results (Join-Path $work "run$run") $HoldMs | Write-Verbose
    if ($LASTEXITCODE) { throw "the observer failed on run $run" }
  }
  Wait-AppGone
  $reports = Get-Content $results | ForEach-Object { $_ | ConvertFrom-Json }
  $notFront = @($reports | Where-Object { -not $_.fg }).Count
  if ($notFront) { "warning: on $notFront runs the window was not in front" }
  Show-Series 'window visible' ($reports | ForEach-Object { $_.visibleSeen })
  Show-Series 'text contrast 50%' ($reports | ForEach-Object { $_.contrast50 })
  Show-Series 'text contrast 90%' ($reports | ForEach-Object { $_.contrast90 })
  Show-Series 'final frame' ($reports | ForEach-Object { $_.text99Ms })
  "screens: $work\run<n>-first.png, -text.png, -final.png"
}

function Invoke-WarmRuns {
  $results = Join-Path $AppTarget 'measure-warm.txt'
  Remove-Item $results -ErrorAction SilentlyContinue
  Wait-AppGone
  $app = Start-App @()
  Wait-AppWindow $app | Out-Null
  try {
    foreach ($run in 1..$Runs) {
      $t0 = [AppWindows]::Now()
      $arguments = "--measure-open `"$File`" --t0 $t0 --measure-out `"$results`""
      $second = New-Object System.Diagnostics.ProcessStartInfo $AppExe, $arguments
      $second.UseShellExecute = $false
      [System.Diagnostics.Process]::Start($second).Dispose()
      $limit = (Get-Date).AddSeconds($WarmTimeoutS)
      while (@(Get-Content $results -ErrorAction SilentlyContinue).Count -lt $run) {
        if ((Get-Date) -gt $limit) { throw "run $run did not finish" }
        Start-Sleep -Milliseconds 10
      }
      Start-Sleep -Milliseconds $WarmSettleMs
    }
  } finally {
    Stop-App $app
  }
  $times = Get-Content $results | ForEach-Object { [double]::Parse($_, [cultureinfo]::InvariantCulture) }
  Show-Series 'open in running app' $times
}

function Invoke-MemoryRun {
  Wait-AppGone
  $app = Start-App @("`"$File`"")
  Wait-AppWindow $app | Out-Null
  try {
    Start-Sleep -Seconds $MemorySettleS
    $processes = @(Get-AppProcessTree $app.Id)
    $workingSet = ($processes | Measure-Object WorkingSet64 -Sum).Sum / 1MB
    $private = ($processes | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB
    'processes {0}   working set {1:F1} MB   private {2:F1} MB' -f $processes.Count, $workingSet, $private
  } finally {
    Stop-App $app
  }
}

if (-not (Test-Path -LiteralPath $File)) { throw "no such file: $File" }
$File = (Resolve-Path -LiteralPath $File).ProviderPath
Assert-AppNotRunning
if (-not $NoBuild -and -not $Exe) { Build-App @('--release') }
$AppExe = if ($Exe) { $Exe } else { Join-Path $AppTarget 'release\mochireader.exe' }

if ($Screen) { Invoke-ScreenRuns }
elseif ($Warm) { Invoke-WarmRuns }
elseif ($Memory) { Invoke-MemoryRun }
else { Invoke-InsideRuns }
