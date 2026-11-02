# SPDX-License-Identifier: GPL-3.0-or-later
# Drives the real app, built with the smoke feature, and checks the tabs it reports through --dump-tabs.
#   smoke.ps1 [-NoBuild] [-BurstRounds <n>]
# Exits 1 on the first failed check. Close MochiReader before running it.
[CmdletBinding()]
param([switch]$NoBuild, [int]$BurstRounds = 3)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\app-process.ps1"

$BurstFiles = 5
$DumpRetryMs = 500
# Time for a second process to pass on a file, before checking that nothing changed.
$SecondProcessMs = 500
$TabsWaitS = 20
$SlowFileShownWithinS = 5
# TEST-NET-1: an address that never answers, like a network drive that was disconnected.
$UnreachableFile = '\\192.0.2.1\share\report.md'
# OPEN_TIMEOUT of docs.rs and some room for a machine under load.
$UnreachableAnswerWithinS = 15

function Pass([string]$Message) { "PASS  $Message" }

function Assert-That([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "FAIL  $Message" }
}

function New-Note([string]$Name, [string]$Sentence) {
  $path = Join-Path $Work $Name
  [System.IO.File]::WriteAllText($path, "---`nlang: it`n---`n# $Name`n`n$Sentence`n", (New-Object System.Text.UTF8Encoding $false))
  $path
}

function Start-Second([string]$Arguments) {
  $start = New-Object System.Diagnostics.ProcessStartInfo $AppExe, $Arguments
  $start.UseShellExecute = $false
  [System.Diagnostics.Process]::Start($start).Dispose()
}

function Get-Tabs {
  $out = Join-Path $Work 'tabs.json'
  $limit = (Get-Date).AddSeconds($TabsWaitS)
  Remove-Item $out -ErrorAction SilentlyContinue
  while ($true) {
    # Asked again and again: until the page listens, a request goes nowhere.
    Start-Second "--dump-tabs `"$out`""
    Start-Sleep -Milliseconds $DumpRetryMs
    if (Test-Path $out) {
      $json = [System.IO.File]::ReadAllText($out, [System.Text.Encoding]::UTF8)
      return @(ConvertFrom-Json $json | ForEach-Object { $_ })
    }
    if ((Get-Date) -gt $limit) { throw 'FAIL  the app did not report its tabs' }
  }
}

function Wait-Tabs([int]$Count, [scriptblock]$Done) {
  $limit = (Get-Date).AddSeconds($TabsWaitS)
  while ($true) {
    $tabs = @(Get-Tabs)
    if ($tabs.Count -eq $Count -and (& $Done $tabs)) { return $tabs }
    if ((Get-Date) -gt $limit) { throw "FAIL  expected $Count tabs, got: $($tabs | ConvertTo-Json -Compress)" }
  }
}

function Get-AppMainProcesses { @(Get-Process $AppProcessName -ErrorAction SilentlyContinue) }

function Test-Burst {
  # Spaces, accents, underscores and commas in the names, as in the files of the author.
  $egrave = [char]0xE8
  $names = 1..$BurstFiles | ForEach-Object { "Lunaris Essentials_ $egrave, vale $_.md" }
  $notes = @($names | ForEach-Object { New-Note $_ "Frase numero $($names.IndexOf($_)) del file." })
  foreach ($round in 1..$BurstRounds) {
    Wait-AppGone
    $starts = @($notes | ForEach-Object {
      $start = New-Object System.Diagnostics.ProcessStartInfo $AppExe, "`"$_`""
      $start.UseShellExecute = $false
      $start
    })
    $processes = @($starts | ForEach-Object { [System.Diagnostics.Process]::Start($_) })
    try {
      $tabs = Wait-Tabs $BurstFiles { param($t) -not ($t | Where-Object { $_.status -eq 'loading' }) }
      $left = @(Get-AppMainProcesses)
      Assert-That ($left.Count -eq 1) "round ${round}: one process stays, found $($left.Count)"
      foreach ($index in 0..($BurstFiles - 1)) {
        $tab = $tabs | Where-Object { $_.path -eq $notes[$index] }
        Assert-That ($null -ne $tab) "round ${round}: a tab for $($notes[$index])"
        Assert-That ($tab.status -eq 'ok' -and $tab.firstPageRendered) "round ${round}: $($tab.path) is shown"
        Assert-That ($tab.text.Contains("Frase numero $index del file.")) "round ${round}: the text of $($tab.path)"
        Assert-That (-not $tab.text.Contains('lang:')) "round ${round}: no frontmatter in $($tab.path)"
      }
    } finally {
      foreach ($process in $processes) {
        if (-not $process.HasExited) { Stop-App $process }
      }
    }
    Pass "round ${round}: $BurstFiles processes at once make $BurstFiles tabs in one window"
  }
}

function Test-RunningApp {
  Wait-AppGone
  $first = New-Note 'prima.md' 'Testo della prima nota.'
  $second = New-Note 'seconda.md' 'Testo della seconda nota.'
  $other = New-Note 'nota.txt' 'Non si apre.'
  $missing = Join-Path $Work 'assente.md'
  $app = Start-App @("`"$first`"")
  try {
    Wait-AppWindow $app | Out-Null
    Start-Second "`"$second`""
    Wait-Tabs 2 { param($t) @($t | Where-Object { $_.status -eq 'ok' }).Count -eq 2 } | Out-Null
    Pass 'a file opened while the app runs becomes a new tab'

    Start-Second "`"$($first.ToUpperInvariant())`""
    Start-Sleep -Milliseconds $SecondProcessMs
    Wait-Tabs 2 { $true } | Out-Null
    Pass 'a file already open does not get a second tab'

    Start-Second "`"$other`""
    Start-Sleep -Milliseconds $SecondProcessMs
    Wait-Tabs 2 { $true } | Out-Null
    Pass 'another kind of file gets no tab'

    Start-Second "`"$missing`""
    $tabs = Wait-Tabs 3 { param($t) @($t | Where-Object { $_.status -eq 'missing' }).Count -eq 1 }
    $tab = $tabs | Where-Object { $_.status -eq 'missing' }
    Assert-That ($tab.path -eq $missing -and $tab.notice.Length -gt 0) 'a missing file gets a message in its tab'
    Assert-That (-not $app.HasExited) 'the app is still running'
    Pass 'a missing file gets a message in its tab'
  } finally {
    Stop-App $app
  }
}

function Test-EmptyStart {
  Wait-AppGone
  $app = Start-App @()
  try {
    Wait-AppWindow $app | Out-Null
    Assert-That (@(Get-Tabs).Count -eq 0) 'no tabs without a file'
    Pass 'the app starts without a file'
  } finally {
    Stop-App $app
  }
}

function Test-UnreachableFile {
  Wait-AppGone
  $started = Get-Date
  $app = Start-App @("`"$UnreachableFile`"")
  try {
    $window = Wait-AppWindow $app
    $shownAfter = ((Get-Date) - $started).TotalSeconds
    Assert-That ($shownAfter -lt $SlowFileShownWithinS) "the window appears at once, it took $shownAfter s"
    Pass ('the window does not wait for an unreachable drive ({0:F1} s)' -f $shownAfter)

    $limit = (Get-Date).AddSeconds($UnreachableAnswerWithinS)
    while ($true) {
      Assert-That (-not [AppWindows]::IsHungAppWindow($window)) 'the window keeps answering'
      $tabs = @(Get-Tabs)
      if ($tabs.Count -eq 1 -and $tabs[0].status -ne 'loading') { break }
      Assert-That ((Get-Date) -lt $limit) 'an unreachable file gets an answer in time'
    }
    Assert-That ($tabs[0].notice.Length -gt 0) 'an unreachable file gets a message in its tab'
    Pass ('an unreachable file gets a message after {0:F1} s: {1}' -f ((Get-Date) - $started).TotalSeconds, $tabs[0].status)
  } finally {
    Stop-App $app
  }
}

Assert-AppNotRunning
if (-not $NoBuild) { Build-App @('--features', 'smoke') }
$AppExe = Join-Path $AppTarget 'debug\mochireader.exe'
$Work = Join-Path ([System.IO.Path]::GetTempPath()) "mochi-smoke-$PID"
New-Item -ItemType Directory $Work | Out-Null
try {
  Test-EmptyStart
  Test-Burst
  Test-RunningApp
  Test-UnreachableFile
  'smoke: all checks passed'
} finally {
  Get-AppMainProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
