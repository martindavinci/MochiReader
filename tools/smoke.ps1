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

# Ctrl+R, F5 and Ctrl+Shift+R: each reloads a page in a browser, which would lose every tab.
$VK_SHIFT = 0x10
$VK_CONTROL = 0x11
$VK_R = 0x52
$VK_F5 = 0x74
$ReloadKeys = @(@($VK_CONTROL, $VK_R), @($VK_F5), @($VK_CONTROL, $VK_SHIFT, $VK_R))
$KeyUp = 2
$ReloadSettleMs = 1500

# One long list, the shape that used to stop the page. 5 MB and not 10, because this is the debug build: its render
# of 10 MB takes longer than OPEN_TIMEOUT. In one go the page stops here for about 2 s.
$LargeFileEntry = "- Voce con **testo** e [link](https://e.org/x) ok`n"
$LargeFileEntries = 100000
$LargeFileWatchS = 20
$LargeFileMaxAnswerMs = 1000
$AnswerPollMs = 2

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SmokeInput {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
'@

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

function Test-FailedTabRetries {
  Wait-AppGone
  $late = Join-Path $Work 'arriva dopo.md'
  $app = Start-App @("`"$late`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'missing' } | Out-Null
    [System.IO.File]::WriteAllText($late, "# Ora esiste`n", (New-Object System.Text.UTF8Encoding $false))
    Start-Second "`"$late`""
    $tabs = Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' }
    Assert-That ($tabs[0].text.Contains('Ora esiste')) 'the text of the file that came back'
    Assert-That ($tabs[0].notice.Length -eq 0) 'no message left from the failure'
    Pass 'a tab that failed opens when the file is opened again'
  } finally {
    Stop-App $app
  }
}

function Get-WindowTitle([IntPtr]$Window) {
  $title = New-Object System.Text.StringBuilder 260
  [void][AppWindows]::GetWindowText($Window, $title, 260)
  $title.ToString()
}

function Test-LargeFile {
  Wait-AppGone
  $large = Join-Path $Work 'lunga.md'
  [System.IO.File]::WriteAllText($large, ($LargeFileEntry * $LargeFileEntries), (New-Object System.Text.UTF8Encoding $false))
  $names = 'uno.md', 'due.md'
  $notes = @($names | ForEach-Object { New-Note $_ "Testo di $_." })
  $app = Start-App @("`"$large`"")
  try {
    $window = Wait-AppWindow $app
    # The page sets the title, so the title following a request shows that the page is free to answer.
    $slowest = 0
    $turn = 0
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $LargeFileWatchS) {
      $index = $turn % $names.Count
      $turn++
      $asked = $clock.ElapsedMilliseconds
      Start-Second "`"$($notes[$index])`""
      while ((Get-WindowTitle $window) -ne $names[$index]) {
        Assert-That ($clock.ElapsedMilliseconds - $asked -lt $LargeFileWatchS * 1000) 'the page answers while a large file opens'
        Start-Sleep -Milliseconds $AnswerPollMs
      }
      $slowest = [math]::Max($slowest, $clock.ElapsedMilliseconds - $asked)
    }
    Assert-That ($slowest -lt $LargeFileMaxAnswerMs) "the page answers while a large file opens: the slowest took $slowest ms"
    $tabs = Wait-Tabs 3 { param($t) @($t | Where-Object { $_.status -eq 'ok' }).Count -eq 3 }
    $text = ($tabs | Where-Object { $_.path -eq $large }).text
    $entries = ([regex]::Matches($text, 'Voce con testo e link ok')).Count
    Assert-That ($entries -eq $LargeFileEntries) "every entry of a large file is on the page, found $entries"
    Pass "the page answers while a large file opens, the slowest in $slowest ms, and all of it arrives"
  } finally {
    Stop-App $app
  }
}

function Send-Keys([IntPtr]$Window, [byte[]]$Keys) {
  # Real keys go to whatever is in front, so they are only sent to the app.
  if ([SmokeInput]::GetForegroundWindow() -ne $Window) { return $false }
  foreach ($key in $Keys) { [SmokeInput]::keybd_event($key, 0, 0, [UIntPtr]::Zero) }
  [array]::Reverse($Keys)
  foreach ($key in $Keys) { [SmokeInput]::keybd_event($key, 0, $KeyUp, [UIntPtr]::Zero) }
  $true
}

function Test-BrowserKeysKeepTheSession {
  Wait-AppGone
  $first = New-Note 'tasti uno.md' 'Testo uno.'
  $second = New-Note 'tasti due.md' 'Testo due.'
  $app = Start-App @("`"$first`"")
  try {
    $window = Wait-AppWindow $app
    Start-Second "`"$second`""
    Wait-Tabs 2 { param($t) @($t | Where-Object { $_.status -eq 'ok' }).Count -eq 2 } | Out-Null
    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    foreach ($keys in $ReloadKeys) {
      if (-not (Send-Keys $window ([byte[]]$keys))) {
        "SKIP  the app is not in front, so the reload keys were not sent and nothing was checked"
        return
      }
      Start-Sleep -Milliseconds $ReloadSettleMs
      Assert-That (@(Get-Tabs).Count -eq 2) "the tabs survive the keys $($keys -join '+')"
    }
    Pass 'the reload keys of the browser keep the tabs'
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
  Test-FailedTabRetries
  Test-LargeFile
  Test-BrowserKeysKeepTheSession
  'smoke: all checks passed'
} finally {
  Get-AppMainProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
