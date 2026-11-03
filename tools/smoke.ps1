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

# A note long enough to scroll, with one paragraph every two lines.
$LongNoteParagraphs = 400
$LongNoteLinesPerParagraph = 2
$ShortNoteParagraphs = 20
# The line of a paragraph well inside the note, at the top of the screen when the note opens there.
$SavedLine = 401
$VK_NEXT = 0x22
$PageDownPresses = 5
# SAVE_DEBOUNCE_MS of position.js and some room.
$SaveSettleMs = 1000
$FocusSettleMs = 500
$StateWaitS = 10
# A note of questions: each is a heading, a long paragraph and its answer in a closed details, on these lines of 10.
$FaqQuestions = 40
$FaqLinesPerQuestion = 10
$FaqHiddenAt = 7
$FaqParagraphRepeats = 40
# The hidden answer of question 21, and the paragraph before it, as close to it as the heading after it.
$FaqHiddenLine = 207
$FaqNearestLine = 203
$VK_DOWN = 0x28
$FaqWalkPresses = 4
$FaqWalkRounds = 8
$PlacedX = 140
$PlacedY = 90
$PlacedWidth = 760
$PlacedHeight = 540
$SW_MAXIMIZE = 3
$SW_RESTORE = 9
$SWP_NOZORDER = 4

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SmokeInput {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int t, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
}
'@
Add-Type -AssemblyName System.Windows.Forms

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

function Write-Note([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding $false))
}

function New-LongText([string]$Word, [int]$Paragraphs) {
  (1..$Paragraphs | ForEach-Object { "$Word numero $_.`n" }) -join "`n"
}

function Get-StateFile { Join-Path $StateDir 'mochi.json' }

function Get-State { [System.IO.File]::ReadAllText((Get-StateFile), [System.Text.Encoding]::UTF8) | ConvertFrom-Json }

function Get-SavedPosition([string]$Name) {
  $state = Get-State
  $property = $state.positions.PSObject.Properties | Where-Object { $_.Name -like "*\$Name" }
  if ($property) { $property.Value }
}

function Wait-State([scriptblock]$Done, [string]$What) {
  $limit = (Get-Date).AddSeconds($StateWaitS)
  while (-not (& $Done)) {
    if ((Get-Date) -gt $limit) { throw "FAIL  $What" }
    Start-Sleep -Milliseconds $AppPollMs
  }
}

# Moves the focus to another window and back, as the reader does when returning to the app. Windows lets a program
# take the foreground only under some conditions, so the answer says whether it really happened.
function Invoke-FocusReturn([IntPtr]$Window) {
  $other = New-Object System.Windows.Forms.Form
  try {
    $other.ShowInTaskbar = $false
    $other.Show()
    $other.Activate()
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds $FocusSettleMs
    if ([SmokeInput]::GetForegroundWindow() -ne $other.Handle) { return $false }
    if (-not [SmokeInput]::SetForegroundWindow($Window)) { return $false }
    Start-Sleep -Milliseconds $FocusSettleMs
    [SmokeInput]::GetForegroundWindow() -eq $Window
  } finally {
    $other.Close()
    $other.Dispose()
  }
}

function Test-DeletedFile {
  Wait-AppGone
  $note = New-Note 'da cancellare.md' 'Testo che resta visibile.'
  $app = Start-App @("`"$note`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Remove-Item $note
    if (Invoke-FocusReturn $window) {
      $tabs = Wait-Tabs 1 { param($t) $t[0].notice.Length -gt 0 }
      Pass 'the window coming back to the front notices a deleted file'
    } else {
      'SKIP  Windows did not let the focus move, so the window coming back to the front was not checked'
      Start-Second "`"$note`""
      $tabs = Wait-Tabs 1 { param($t) $t[0].notice.Length -gt 0 }
    }
    Assert-That ($tabs[0].status -eq 'ok') 'a deleted file keeps its tab as it was'
    Assert-That ($tabs[0].text.Contains('Testo che resta visibile.')) 'the text of a deleted file stays'
    Assert-That (-not $app.HasExited) 'the app is still running'
    Pass 'a deleted file keeps its text and gets a message'
  } finally {
    Stop-App $app
  }

  $app = Start-App @("`"$note`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tabs = Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' }
    Assert-That ($tabs[0].status -eq 'missing') "a deleted file is reported as missing, not $($tabs[0].status)"
    Assert-That ($tabs[0].notice.Length -gt 0) 'a deleted file opened again gets a message in its tab'
    Pass 'a deleted file opened again gets a message in its tab'
  } finally {
    Stop-App $app
  }

  $app = Start-App @()
  try {
    Wait-AppWindow $app | Out-Null
    Wait-State {
      $recent = @((Get-State).recents) | Where-Object { $_.path -eq $note }
      $recent -and -not $recent.exists
    } 'a deleted file stays in the recents, marked as missing'
    Pass 'a deleted file stays in the recents, marked as missing'
  } finally {
    Stop-App $app
  }
}

function Set-SavedLine([string]$Name, [int]$Line) {
  $state = Get-State
  $state.positions.PSObject.Properties | Where-Object { $_.Name -like "*\$Name" } | ForEach-Object { $_.Value.line = $Line }
  [System.IO.File]::WriteAllText((Get-StateFile), ($state | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
}

function New-FaqText([string]$Word) {
  $paragraph = ("$Word lunga da leggere con calma. " * $FaqParagraphRepeats).Trim()
  (1..$FaqQuestions | ForEach-Object {
    "## Domanda $_`n`n$paragraph`n`n<details><summary>Risposta $_</summary>`n`nLa risposta nascosta $_.`n`n</details>`n"
  }) -join "`n"
}

function Test-CollapsedSections {
  Wait-AppGone
  $name = 'domande e risposte.md'
  $note = Join-Path $Work $name
  Write-Note $note (New-FaqText 'Spiegazione')

  $app = Start-App @("`"$note`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
  } finally {
    Stop-App $app
  }

  # A position saved by a version that could stop on a hidden block, or in a section open back then.
  Set-SavedLine $name $FaqHiddenLine
  $app = Start-App @("`"$note`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].position.line -eq $FaqNearestLine } | Out-Null
    Pass "a position in a closed section opens at the nearest block on screen, line $FaqNearestLine"

    Write-Note $note (New-FaqText 'Cambiata')
    Start-Second "`"$note`""
    $tabs = Wait-Tabs 1 { param($t) $t[0].text.Contains('Cambiata lunga') }
    Assert-That ($tabs[0].position.line -eq $FaqNearestLine) "a file with closed sections read again stays at line $FaqNearestLine, not $($tabs[0].position.line)"
    Pass 'a file with closed sections changed on disk is read again and keeps the position'

    foreach ($round in 1..$FaqWalkRounds) {
      [void][SmokeInput]::SetForegroundWindow($window)
      Start-Sleep -Milliseconds $SecondProcessMs
      $before = (Get-Tabs)[0].position.line
      $sent = $true
      foreach ($press in 1..$FaqWalkPresses) { $sent = $sent -and (Send-Keys $window ([byte[]]@($VK_DOWN))) }
      if (-not $sent) {
        'SKIP  the app is not in front, so a real walk through the closed sections was not checked'
        return
      }
      Start-Sleep -Milliseconds $SaveSettleMs
      $line = (Get-Tabs)[0].position.line
      Assert-That ($line -ge $before) "the keys go forward: line $before, then $line"
      Assert-That ($line % $FaqLinesPerQuestion -ne $FaqHiddenAt) "the position is on screen, not on the hidden line $line"
      Wait-State { (Get-SavedPosition $name).line -eq $line } "a scroll is saved after it ends, line $line"
      Stop-App $app
      $app = Start-App @("`"$note`"")
      $window = Wait-AppWindow $app
      $tabs = Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' }
      Wait-Tabs 1 { param($t) $t[0].position.line -eq $line } | Out-Null
    }
    Pass "$FaqWalkRounds times scroll, close, open again past closed sections: the same point"
  } finally {
    Stop-App $app
  }
}

function Test-Position {
  Wait-AppGone
  $name = 'lunga posizione.md'
  $note = Join-Path $Work $name
  Write-Note $note (New-LongText 'Paragrafo' $LongNoteParagraphs)

  $app = Start-App @("`"$note`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
  } finally {
    Stop-App $app
  }
  $saved = Get-SavedPosition $name
  Assert-That ($null -ne $saved) 'closing the app saves the position of its tabs'
  Assert-That ($saved.line -eq 1) "a note never scrolled is saved at its start, not at line $($saved.line)"
  Pass 'closing the app saves the position of its tabs'

  # Written here so that this part does not depend on Windows letting real keys through.
  Set-SavedLine $name $SavedLine

  $app = Start-App @("`"$note`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].position.line -eq $SavedLine } | Out-Null
    Pass "a file opens at its saved position, line $SavedLine"

    Write-Note $note (New-LongText 'Cambiato' $LongNoteParagraphs)
    Start-Second "`"$note`""
    $tabs = Wait-Tabs 1 { param($t) $t[0].text.Contains('Cambiato numero 1.') }
    Assert-That ($tabs[0].position.line -eq $SavedLine) "a file read again stays at line $SavedLine, not $($tabs[0].position.line)"
    Pass 'a file changed on disk is read again and keeps the position'

    Write-Note $note (New-LongText 'Breve' $ShortNoteParagraphs)
    Start-Second "`"$note`""
    $tabs = Wait-Tabs 1 { param($t) $t[0].text.Contains('Breve numero 1.') }
    Assert-That ($tabs[0].status -eq 'ok' -and $tabs[0].position.line -gt 0) 'a file that shrank has a position'
    Assert-That ($tabs[0].position.line -lt $SavedLine) 'a file that shrank moves to a block it still has'
    Pass "a file that shrank goes to the nearest block, line $($tabs[0].position.line)"

    Write-Note $note (New-LongText 'Paragrafo' $LongNoteParagraphs)
    Start-Second "`"$note`""
    Wait-Tabs 1 { param($t) $t[0].text.Contains('Paragrafo numero 1.') } | Out-Null

    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    $sent = $true
    $before = (Get-Tabs)[0].position.line
    foreach ($press in 1..$PageDownPresses) { $sent = $sent -and (Send-Keys $window ([byte[]]@($VK_NEXT))) }
    if ($sent) {
      Start-Sleep -Milliseconds $SaveSettleMs
      $line = (Get-Tabs)[0].position.line
      Assert-That ($line -gt $before) "the keys scroll the text: line $before, then $line"
      Wait-State { (Get-SavedPosition $name).line -eq $line } "a scroll is saved after it ends, line $line"
      Pass "a scroll is saved after it ends, line $line"
      Stop-App $app
      $app = Start-App @("`"$note`"")
      Wait-AppWindow $app | Out-Null
      Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].position.line -eq $line } | Out-Null
      Pass 'open, scroll, close, open again: the same point'
    } else {
      'SKIP  the app is not in front, so a real scroll was not checked'
    }
  } finally {
    Stop-App $app
  }
}

function Get-WindowBox([IntPtr]$Window) {
  $box = New-Object SmokeInput+Rect
  [void][SmokeInput]::GetWindowRect($Window, [ref]$box)
  '{0},{1},{2},{3}' -f $box.Left, $box.Top, ($box.Right - $box.Left), ($box.Bottom - $box.Top)
}

function Test-WindowPlacement {
  Wait-AppGone
  $wanted = '{0},{1},{2},{3}' -f $PlacedX, $PlacedY, $PlacedWidth, $PlacedHeight
  $app = Start-App @()
  try {
    $window = Wait-AppWindow $app
    [void][SmokeInput]::SetWindowPos($window, [IntPtr]::Zero, $PlacedX, $PlacedY, $PlacedWidth, $PlacedHeight, $SWP_NOZORDER)
  } finally {
    Stop-App $app
  }
  $app = Start-App @()
  try {
    $window = Wait-AppWindow $app
    $box = Get-WindowBox $window
    Assert-That ($box -eq $wanted) "the window comes back at $wanted, not $box"
    Pass 'the window remembers its position and size'
    [void][SmokeInput]::ShowWindow($window, $SW_MAXIMIZE)
  } finally {
    Stop-App $app
  }
  $app = Start-App @()
  try {
    $window = Wait-AppWindow $app
    Assert-That ([SmokeInput]::IsZoomed($window)) 'a maximized window comes back maximized'
    [void][SmokeInput]::ShowWindow($window, $SW_RESTORE)
    $box = Get-WindowBox $window
    Assert-That ($box -eq $wanted) "a maximized window restores to $wanted, not $box"
    Pass 'a maximized window comes back maximized and restores to its size'
  } finally {
    Stop-App $app
  }
}

function Test-CorruptState {
  Wait-AppGone
  $broken = '{ this is not the state'
  [System.IO.File]::WriteAllText((Get-StateFile), $broken)
  $note = New-Note 'dopo lo stato rotto.md' 'Si apre lo stesso.'
  $app = Start-App @("`"$note`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    $kept = @(Get-ChildItem $StateDir -Filter 'mochi.json.bad-*' | Where-Object { [System.IO.File]::ReadAllText($_.FullName) -eq $broken })
    Assert-That ($kept.Count -eq 1) 'a broken state file is kept aside'
    Wait-State { @((Get-State).recents).Count -eq 1 } 'the state starts again after a broken file'
    Pass 'a broken state file is kept aside and the app starts empty'
  } finally {
    Stop-App $app
  }
}

Assert-AppNotRunning
if (-not $NoBuild) { Build-App @('--features', 'smoke') }
$AppExe = Join-Path $AppTarget 'debug\mochireader.exe'
$Work = Join-Path ([System.IO.Path]::GetTempPath()) "mochi-smoke-$PID"
New-Item -ItemType Directory $Work | Out-Null
# The state of the smoke build stays here, away from the recents and positions of the person running it.
$StateDir = Join-Path $Work 'state'
New-Item -ItemType Directory $StateDir | Out-Null
$env:MOCHIREADER_STATE_DIR = $StateDir
try {
  Test-EmptyStart
  Test-Burst
  Test-RunningApp
  Test-UnreachableFile
  Test-FailedTabRetries
  Test-LargeFile
  Test-BrowserKeysKeepTheSession
  Test-DeletedFile
  Test-Position
  Test-CollapsedSections
  Test-WindowPlacement
  Test-CorruptState
  'smoke: all checks passed'
} finally {
  Get-AppMainProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
