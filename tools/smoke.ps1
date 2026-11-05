# SPDX-License-Identifier: GPL-3.0-or-later
# Drives the real app, built with the smoke feature, and checks the tabs it reports through --dump-tabs.
#   smoke.ps1 [-NoBuild] [-BurstRounds <n>] [-Only <Test-Name>, ...]
# Exits 1 on the first failed check. Close MochiReader before running it.
[CmdletBinding()]
param([switch]$NoBuild, [int]$BurstRounds = 3, [string[]]$Only)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\app-process.ps1"
. "$PSScriptRoot\smoke-net-log.ps1"
. "$PSScriptRoot\smoke-speech.ps1"

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
# Notes of images with no size in the text, so the page only reaches its real length as they load: four lines each.
$ImageWidth = 700
$ImageHeight = 500
$ImagesLines = 4
$ShortImages = 6
$LongImages = 60
# Captions of the short note with more than a screen after them, and one too close to the end to reach the top.
$ShortImagesLines = 7, 9, 11, 15
$ShortImagesEndLine = 19
# A caption near the end of the long note, past where a page with no images yet ends, and one in the middle.
$LongImagesLines = 231, 119
$ImagesRounds = 2
$ImagesFlowRounds = 5
# Time for images still loading to change the page, before checking that nothing moved.
$ImagesSettleMs = 1000
$PlacedX = 140
$PlacedY = 90
$PlacedWidth = 760
$PlacedHeight = 540
$SW_MAXIMIZE = 3
$SW_RESTORE = 9
$SWP_NOZORDER = 4

$FixtureDir = Join-Path $AppRoot 'test\fixtures'
$PlainKey = 'epub:urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e01|Plain Fixture|2'
$PlainFirstChapter = 'first paragraph of the first chapter'
$PlainSecondChapter = 'first paragraph of the second chapter'
$PlainSecondChapterCfi = 'epubcfi(/6/4!/4/2/1:0)'
# The spine of the fixture has two items: this one leads nowhere.
$NowhereCfi = 'epubcfi(/6/40!/4/2/1:0)'
# The time the plan gives a script in a book to reach the app, once the book is open.
$CanaryWaitS = 5
$ScriptedSentence = 'This book tries to reach the application from its content.'
$CanaryFile = 'canary'
$SelfScriptSentence = 'This book names a script of the application.'
$NetworkSentence = 'This book tries to reach the network from its content.'
# The ports the book in network.epub reaches for, and the one in network-html.epub.
$NetworkPorts = 48311..48319
$SvgPageAfterDrawing = 'The page after the drawing.'
$SvgPageAfterNothing = 'The page after the one with no body.'
$LinksSvgPage = 'The page with the link in a drawing.'
$LinksMapPage = 'The page with the image map.'
$LinksOutPage = 'The page with the link out of the book.'
$LinksEndPage = 'The page after the links.'
$NotABook = 'This is not a ZIP file.'
$DamagedKey = 'epub:urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e0c|Damaged Chapters Fixture|7'
$DamagedFirstPage = 'The page before the damage'
$DamagedAfterSpoiled = 'The page after the spoiled file'
$DamagedAfterMissing = 'The page after the missing file'
$DamagedAfterEmpty = 'The page after the empty file'
# In either language of the interface. Only ASCII, because this script may be read as ANSI.
$UnreadableSection = 'cannot be read|non si pu'
$LongKey = 'epub:urn:uuid:6f1d6a51-3c0e-4e0a-9b52-0d7a3f2c1e0d|Long Chapters Fixture|3'
# What a file holds while a copy or a sync is writing it: the start of a ZIP, with no directory at its end.
$CutBookBytes = 1000
$VK_LEFT = 0x25
$VK_RIGHT = 0x27
$VK_ESCAPE = 0x1B
$VK_D = 0x44
$VK_T = 0x54
$VK_TAB = 0x09
$VK_RETURN = 0x0D
$VK_OEM_COMMA = 0xBC
# More than the controls of the options panel before its button.
$MaxTabsToLicenses = 30
$VK_OEM_PLUS = 0xBB
$MOUSEEVENTF_LEFTDOWN = 2
$MOUSEEVENTF_LEFTUP = 4
$DoubleClickGapMs = 90
$RowsOfHeadings = 40

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
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
}
'@
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

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
      # The report is whole when it is there, but a later request replacing it can refuse a reader for a moment.
      try {
        $json = [System.IO.File]::ReadAllText($out, [System.Text.Encoding]::UTF8)
        return @(ConvertFrom-Json $json | ForEach-Object { $_ })
      } catch [System.IO.IOException] {
        Write-Verbose "the report was being replaced: $_"
      }
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
    # The page sets the title, so the title following a request shows that the page is free to answer. What is timed is
    # only the page answering: from the second process having passed on its file and gone, to the new title. The start of
    # that process is the machine's, and a loaded machine has stretched it past any limit that means something here.
    $slowest = 0
    $turn = 0
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $LargeFileWatchS) {
      $index = $turn % $names.Count
      $turn++
      $second = Start-App @("`"$($notes[$index])`"")
      Assert-That ($second.WaitForExit($AppWaitS * 1000)) 'a second process passes on its file and ends'
      $second.Dispose()
      $asked = $clock.ElapsedMilliseconds
      while (-not (Get-WindowTitle $window).StartsWith($names[$index])) {
        Assert-That ($clock.ElapsedMilliseconds - $asked -lt $LargeFileWatchS * 1000) 'the page answers while a large file opens'
        Start-Sleep -Milliseconds $AnswerPollMs
      }
      $slowest = [math]::Max($slowest, $clock.ElapsedMilliseconds - $asked)
    }
    Assert-That ($slowest -lt $LargeFileMaxAnswerMs) "the page answers a passed-on file while a large one opens: the slowest took $slowest ms"
    $tabs = Wait-Tabs 3 { param($t) @($t | Where-Object { $_.status -eq 'ok' }).Count -eq 3 }
    $text = ($tabs | Where-Object { $_.path -eq $large }).text
    $entries = ([regex]::Matches($text, 'Voce con testo e link ok')).Count
    Assert-That ($entries -eq $LargeFileEntries) "every entry of a large file is on the page, found $entries"
    Pass "the page answers a passed-on file while a large one opens, the slowest in $slowest ms, and all of it arrives"
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

# The window takes the focus when it shows, not before: the keys must reach the text from then on, with nothing clicked.
function Test-FirstKeysReachTheText {
  Wait-AppGone
  $note = Join-Path $Work 'primi tasti.md'
  Write-Note $note (New-LongText 'Paragrafo' $LongNoteParagraphs)
  $app = Start-App @("`"$note`"")
  try {
    $window = Wait-AppWindow $app
    $before = (Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' })[0].position.line
    if (-not (Send-Keys $window ([byte[]]@($VK_NEXT)))) {
      'SKIP  the app did not come to the front, so the first key was not sent and nothing was checked'
      return
    }
    Start-Sleep -Milliseconds $SaveSettleMs
    $line = (Get-Tabs)[0].position.line
    Assert-That ($line -gt $before) "the first key scrolls the text: line $before, then $line"
    Pass 'the window comes to the front on its own and the first key reaches the text'
  } finally {
    Stop-App $app
  }
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
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].screenLine -eq $FaqNearestLine } | Out-Null
    Pass "a position in a closed section opens at the nearest block on screen, line $FaqNearestLine"

    Write-Note $note (New-FaqText 'Cambiata')
    Start-Second "`"$note`""
    $tabs = Wait-Tabs 1 { param($t) $t[0].text.Contains('Cambiata lunga') }
    Assert-That ($tabs[0].screenLine -eq $FaqNearestLine) "a file with closed sections read again stays at line $FaqNearestLine, not $($tabs[0].screenLine)"
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
      Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].screenLine -eq $line } | Out-Null
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
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].screenLine -eq $SavedLine } | Out-Null
    Pass "a file opens at its saved position, line $SavedLine"

    Write-Note $note (New-LongText 'Cambiato' $LongNoteParagraphs)
    Start-Second "`"$note`""
    # The text arrives a moment before the place does: what counts is that the place comes back, and stays.
    $tabs = Wait-Tabs 1 { param($t) $t[0].text.Contains('Cambiato numero 1.') -and $t[0].screenLine -eq $SavedLine }
    Assert-That ($tabs[0].screenLine -eq $SavedLine) "a file read again stays at line $SavedLine, not $($tabs[0].screenLine)"
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
      Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].screenLine -eq $line } | Out-Null
      Pass 'open, scroll, close, open again: the same point'
    } else {
      'SKIP  the app is not in front, so a real scroll was not checked'
    }
  } finally {
    Stop-App $app
  }
}

function New-ImagesNote([string]$Name, [int]$Images) {
  $folder = Join-Path $Work ([System.IO.Path]::GetFileNameWithoutExtension($Name))
  New-Item -ItemType Directory $folder | Out-Null
  $picture = New-Object System.Drawing.Bitmap $ImageWidth, $ImageHeight
  try {
    # A file for each, so that the page has to wait for each.
    $blocks = 1..$Images | ForEach-Object {
      $picture.Save((Join-Path $folder "img$_.png"), [System.Drawing.Imaging.ImageFormat]::Png)
      "![]($([uri]::EscapeDataString((Split-Path $folder -Leaf)))/img$_.png)`n`nDidascalia $_.`n"
    }
  } finally {
    $picture.Dispose()
  }
  $note = Join-Path $Work $Name
  Write-Note $note ($blocks -join "`n")
  $note
}

function Open-ToSavePosition([string]$Note) {
  $app = Start-App @("`"$Note`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
  } finally {
    Stop-App $app
  }
}

# Without a real scroll the line must stay what it was. `-Reachable` also asks for it to be at the top of the screen,
# which a page without its images is too short for, so this cannot pass if the images do not arrive.
function Assert-OpensAt([string]$Note, [string]$Name, [int]$Line, [switch]$Reachable) {
  $app = Start-App @("`"$Note`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    if ($Reachable) { Wait-Tabs 1 { param($t) $t[0].screenLine -eq $Line } | Out-Null }
    Start-Sleep -Milliseconds $ImagesSettleMs
    $tab = (Get-Tabs)[0]
    Assert-That ($tab.position.line -eq $Line) "${Name}: the position stays at line $Line, not $($tab.position.line)"
    if ($Reachable) { Assert-That ($tab.screenLine -eq $Line) "${Name}: line $Line stays at the top, not $($tab.screenLine)" }
  } finally {
    Stop-App $app
  }
  $saved = (Get-SavedPosition $Name).line
  Assert-That ($saved -eq $Line) "${Name}: closing keeps saved line $Line, not $saved"
}

function Test-PositionWithImages {
  Wait-AppGone
  $name = 'immagini brevi.md'
  $note = New-ImagesNote $name $ShortImages
  Open-ToSavePosition $note
  foreach ($round in 1..$ImagesRounds) {
    foreach ($line in $ShortImagesLines) {
      Set-SavedLine $name $line
      Assert-OpensAt $note $name $line -Reachable
    }
    Set-SavedLine $name $ShortImagesEndLine
    Assert-OpensAt $note $name $ShortImagesEndLine
  }
  Pass "a note of images opens at its saved line and keeps it, $ImagesRounds rounds of $($ShortImagesLines.Count + 1) lines"

  $longName = 'immagini lunghe.md'
  $long = New-ImagesNote $longName $LongImages
  Open-ToSavePosition $long
  foreach ($round in 1..$ImagesRounds) {
    foreach ($line in $LongImagesLines) {
      Set-SavedLine $longName $line
      Assert-OpensAt $long $longName $line -Reachable
    }
  }
  Pass "a long note of images opens at its saved line and keeps it, $ImagesRounds rounds of $($LongImagesLines.Count) lines"

  # The whole way with real keys. It opens at the top, and each opening starts with no image loaded.
  Set-SavedLine $name 1
  $app = Start-App @("`"$note`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Sleep -Milliseconds $ImagesSettleMs
    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    if (-not (Send-Keys $window ([byte[]]@($VK_NEXT)))) {
      'SKIP  the app is not in front, so a real scroll through a note of images was not checked'
      return
    }
    Start-Sleep -Milliseconds $SaveSettleMs
    $tab = (Get-Tabs)[0]
    $line = $tab.position.line
    Assert-That ($line -gt 1) 'a key takes the screen from where the reader was sent, and scrolls the text'
    Assert-That ($tab.screenLine -eq $line) "after a real scroll the position is what is on screen: $line, $($tab.screenLine)"
    Wait-State { (Get-SavedPosition $name).line -eq $line } "a scroll is saved after it ends, line $line"
  } finally {
    Stop-App $app
  }
  foreach ($round in 1..$ImagesFlowRounds) { Assert-OpensAt $note $name $line -Reachable }
  Pass "open, scroll, close, then $ImagesFlowRounds times open and close through a note of images: the same point, line $line"
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

function Copy-Fixture([string]$Name, [string]$Folder = $Work) {
  Copy-Item (Join-Path $FixtureDir $Name) $Folder -PassThru | ForEach-Object FullName
}

function Test-EpubOpens {
  Wait-AppGone
  $plain = Copy-Fixture 'plain.epub'
  $app = Start-App @("`"$plain`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.kind -eq 'epub') "a book is a book, not $($tab.kind)"
    Assert-That ($tab.status -eq 'ok') "a book opens, not: $($tab.status), $($tab.notice)"
    Assert-That ($tab.firstPageRendered) 'a book shows its first page'
    Assert-That ($tab.text.Contains($PlainFirstChapter)) "the text of the first chapter is there, not: $($tab.text)"
    Assert-That (-not $tab.text.Contains($PlainSecondChapter)) 'only the section on screen is there'
    Assert-That ($tab.key -eq $PlainKey) "a book is known by its identifier, title and sections, not $($tab.key)"
    Assert-That ($tab.title -eq 'Plain Fixture') "a book has the title it declares, not $($tab.title)"
    Wait-State { @((Get-State).recents | Where-Object { $_.path -eq $plain -and $_.title -eq 'Plain Fixture' }).Count -eq 1 } 'a book goes to the recents with its title'
    Pass 'a book opens at its first page and goes to the recents'
  } finally {
    Stop-App $app
  }
}

function Test-EpubScripts {
  Wait-AppGone
  $canary = Join-Path $StateDir $CanaryFile
  Remove-Item $canary -ErrorAction SilentlyContinue
  $plain = Copy-Fixture 'plain.epub'
  $scripted = Copy-Fixture 'scripted.epub'
  $app = Start-App @("`"$plain`"")
  try {
    Wait-AppWindow $app | Out-Null
    # Without a book that opens, no script running proves nothing.
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].firstPageRendered } | Out-Null
    Start-Second "`"$scripted`""
    Wait-Tabs 2 { param($t) @($t | Where-Object { $_.status -eq 'loading' }).Count -eq 0 } | Out-Null
    Start-Sleep -Seconds $CanaryWaitS
    Assert-That (-not (Test-Path $canary)) 'a script in a book reached the app: the canary exists'
    $tab = @(Get-Tabs) | Where-Object { $_.path -eq $scripted }
    Assert-That ($tab.status -eq 'ok') "the book with scripts opens, not: $($tab.status), $($tab.notice)"
    Assert-That ($tab.firstPageRendered) 'the book with scripts shows a page'
    Assert-That ($tab.text.Contains($ScriptedSentence)) "the text of the book with scripts is there, not: $($tab.text)"
    Pass 'a book with scripts opens, shows its text, and its scripts do not reach the app'
  } finally {
    Stop-App $app
  }
}

# What the CSP lets through: a script of the app itself, named by the book. It would fill its page in the book's frame.
function Test-EpubSelfScript {
  Wait-AppGone
  $book = Copy-Fixture 'self-script.epub'
  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.status -eq 'ok' -and $tab.firstPageRendered) "the book naming the app opens, not: $($tab.status), $($tab.notice)"
    Start-Sleep -Seconds $CanaryWaitS
    $text = (@(Get-Tabs)[0]).text.Trim()
    Assert-That ($text -eq $SelfScriptSentence) "a script of the app ran in the frame of a book, which now holds: $text"
    Pass 'a book cannot run a script of the app in its own frame'
  } finally {
    Stop-App $app
  }
}

function Test-EpubNoNetwork {
  foreach ($fixture in 'network.epub', 'network-html.epub') { Test-BookStaysOffline $fixture }
}

# Chromium connects for some things in a page before the CSP has its say, and no request ever arrives. So this listens.
function Test-BookStaysOffline([string]$Fixture) {
  Wait-AppGone
  $book = Copy-Fixture $Fixture
  $listeners = foreach ($port in $NetworkPorts) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $listener.Start()
    $listener
  }
  try {
    # Without listeners that hear a connection, no connection heard proves nothing.
    $control = New-Object System.Net.Sockets.TcpClient('127.0.0.1', $NetworkPorts[0])
    Start-Sleep -Milliseconds $SecondProcessMs
    Assert-That ($listeners[0].Pending()) 'the check of the network hears nothing, so it proves nothing'
    $listeners[0].AcceptTcpClient().Dispose()
    $control.Dispose()

    $app = Start-App @("`"$book`"")
    try {
      Wait-AppWindow $app | Out-Null
      $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
      Assert-That ($tab.status -eq 'ok' -and $tab.firstPageRendered) "$Fixture opens, not: $($tab.status), $($tab.notice)"
      Assert-That ($tab.text.Contains($NetworkSentence)) "the text of $Fixture is there, not: $($tab.text)"
      Start-Sleep -Seconds $CanaryWaitS
      $reached = @($listeners | Where-Object { $_.Pending() } | ForEach-Object { $_.LocalEndpoint.Port })
      Assert-That ($reached.Count -eq 0) "$Fixture made the app connect to ports $($reached -join ', ')"
      Pass "$Fixture opens and connects to nothing"
    } finally {
      Stop-App $app
    }
  } finally {
    $listeners | ForEach-Object { $_.Stop() }
  }
}

# A page the renderer cannot stand on would take the book with it: no message, and no way past that page.
function Test-EpubSvgPages {
  Wait-AppGone
  $book = Copy-Fixture 'svg-pages.epub'
  $app = Start-App @("`"$book`"")
  try {
    $window = Wait-AppWindow $app
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.status -eq 'ok' -and $tab.firstPageRendered) "a book that starts with a drawn page opens, not: $($tab.status), $($tab.notice)"
    Assert-That ($tab.key.Length -gt 0) 'a book that starts with a drawn page is known by its key'
    Assert-That ($tab.text.Contains('Drawn page')) "the drawn page is on screen, not: $($tab.text)"
    Wait-State { @((Get-State).recents | Where-Object { $_.path -eq $book }).Count -eq 1 } 'a book that starts with a drawn page goes to the recents'
    Pass 'a book that starts with a drawn page opens'
    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    $next = @($VK_CONTROL, $VK_RIGHT)
    if (-not (Assert-KeysDo $window $next { param($t) $t.text.Contains($SvgPageAfterDrawing) } 'the keys move on from a drawn page')) {
      'SKIP  the app is not in front, so moving past a page with no body was not checked'
      return
    }
    Assert-That (Assert-KeysDo $window $next { param($t) -not $t.text.Contains($SvgPageAfterDrawing) } 'the keys reach the page with no body') 'the keys stay with the app'
    Assert-That (Assert-KeysDo $window $next { param($t) $t.text.Contains($SvgPageAfterNothing) } 'the keys move on from a page with no body') 'the keys stay with the app'
    Pass 'neither a drawn page nor a page with no body stops the reader'
  } finally {
    Stop-App $app
  }
}

# foliate only sees a[href]. Any other link left to the browser would take the page away and the keys with it.
function Test-EpubLinks {
  Wait-AppGone
  $book = Copy-Fixture 'links.epub'
  $app = Start-App @("`"$book`"")
  try {
    $window = Wait-AppWindow $app
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.text.Contains($LinksSvgPage)) "the book of links opens, not: $($tab.status), $($tab.text)"
    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    # The place too: the raw file of the chapter in the frame would have the right text and no reader around it.
    $steps = @(
      @{ What = 'an SVG link'; Text = $LinksMapPage; Cfi = 'epubcfi(/6/4!' },
      @{ What = 'an area of an image map'; Text = $LinksOutPage; Cfi = 'epubcfi(/6/6!' }
    )
    foreach ($step in $steps) {
      if (-not (Send-Click $window)) { 'SKIP  the app is not in front, so the links in a book were not checked'; return }
      $limit = (Get-Date).AddSeconds($StateWaitS)
      while ($true) {
        $tab = @(Get-Tabs)[0]
        if ($tab.text.Contains($step.Text) -and $tab.position.cfi.StartsWith($step.Cfi)) { break }
        if ((Get-Date) -gt $limit) { throw "FAIL  $($step.What) goes to its place in the book, not: $($tab.position.cfi), $($tab.text)" }
        Start-Sleep -Milliseconds $AppPollMs
      }
    }
    if (-not (Send-Click $window)) { 'SKIP  the app is not in front, so a link out of a book was not checked'; return }
    $tab = @(Get-Tabs)[0]
    Assert-That ($tab.firstPageRendered -and $tab.text.Contains($LinksOutPage)) "an SVG link out of the book leaves the page where it is, not: $($tab.text)"
    Assert-That (Assert-KeysDo $window @($VK_CONTROL, $VK_T) { param($t) $t.panel -eq 'toc' } 'ctrl+t opens the contents after a link') 'the keys stay with the app'
    Assert-That (Assert-KeysDo $window @($VK_ESCAPE) { param($t) -not $t.panel } 'esc closes the contents after a link') 'the keys stay with the app'
    Assert-That (Assert-KeysDo $window @($VK_CONTROL, $VK_RIGHT) { param($t) $t.text.Contains($LinksEndPage) } 'the keys move on after a link') 'the keys stay with the app'
    Pass 'an SVG link and an image map keep the reader in the book, and the keys in the reader'
  } finally {
    Stop-App $app
  }
}

function Test-BrokenEpubs {
  Wait-AppGone
  $empty = Join-Path $Work 'vuoto.epub'
  [System.IO.File]::WriteAllBytes($empty, [byte[]]@())
  $text = Join-Path $Work 'non un libro.epub'
  Write-Note $text $NotABook
  $books = @((Copy-Fixture 'corrupt.epub'), (Copy-Fixture 'drm.epub'), $empty, $text)
  $plain = Copy-Fixture 'plain.epub'
  $app = Start-App @("`"$plain`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    foreach ($book in $books) { Start-Second "`"$book`"" }
    $tabs = Wait-Tabs ($books.Count + 1) { param($t) @($t | Where-Object { $_.status -eq 'loading' }).Count -eq 0 }
    foreach ($book in $books) {
      $tab = $tabs | Where-Object { $_.path -eq $book }
      Assert-That ($tab.status -eq 'error') "$book is refused, not: $($tab.status)"
      Assert-That ($tab.notice.Length -gt 0) "$book gets a message in its tab"
      Assert-That (-not $tab.firstPageRendered) "$book shows no page"
      Assert-That ($tab.text.Length -eq 0) "$book shows no text, not: $($tab.text)"
    }
    Assert-That (-not $app.HasExited) 'the app is still running'
    Assert-That (-not [AppWindows]::IsHungAppWindow($window)) 'the window keeps answering'
    Assert-That (($tabs | Where-Object { $_.path -eq $plain }).status -eq 'ok') 'the book that opened stays open'
    Pass 'a book damaged, with DRM, empty or not a book at all gets a message, and the app goes on'
  } finally {
    Stop-App $app
  }
}

# A section that cannot be read must say so and let the reader past it, by every key, in both directions and again later.
function Test-EpubDamagedChapters {
  Wait-AppGone
  $book = Copy-Fixture 'damaged-chapters.epub'
  $app = Start-App @("`"$book`"")
  try {
    $window = Wait-AppWindow $app
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.status -eq 'ok' -and $tab.text.Contains($DamagedFirstPage)) "a book with a damaged chapter opens, not: $($tab.status), $($tab.text)"
    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    # What is on screen and the place saved for it, or the place could stay behind on the page before.
    $at = {
      param($Keys, $Section, $Text)
      Assert-KeysDo $window $Keys { param($t) $t.position.cfi.StartsWith("epubcfi(/6/$Section!") -and $t.text -match $Text -and $t.firstPageRendered } "keys $($Keys -join '+') reach section $Section, showing $Text"
    }
    if (-not (& $at @($VK_RIGHT) 4 $UnreadableSection)) {
      'SKIP  the app is not in front, so moving past a damaged chapter was not checked'
      return
    }
    Pass 'the arrow reaches a chapter that fails to unpack, and it says so'
    $walk = @(
      @(@($VK_RIGHT), 6, $DamagedAfterSpoiled),
      @(@($VK_LEFT), 4, $UnreadableSection),
      @(@($VK_LEFT), 2, $DamagedFirstPage),
      @(@($VK_CONTROL, $VK_RIGHT), 4, $UnreadableSection),
      @(@($VK_CONTROL, $VK_RIGHT), 6, $DamagedAfterSpoiled),
      @(@($VK_RIGHT), 8, $UnreadableSection),
      @(@($VK_RIGHT), 10, $DamagedAfterMissing),
      @(@($VK_SHIFT, $VK_RIGHT), 12, $UnreadableSection),
      @(@($VK_SHIFT, $VK_RIGHT), 14, $DamagedAfterEmpty),
      @(@($VK_CONTROL, $VK_LEFT), 12, $UnreadableSection)
    )
    foreach ($step in $walk) {
      Assert-That (& $at $step[0] $step[1] $step[2]) 'the keys stay with the app'
    }
    Pass 'arrows and section keys go through spoiled, missing and empty chapters, both ways'
    Assert-That (Assert-KeysDo $window @($VK_CONTROL, $VK_D) { $true } 'ctrl+d') 'the keys stay with the app'
    Wait-State { @((Get-State).bookmarks).Count -eq 1 } 'a damaged chapter can hold a bookmark like any other'
    Wait-State { (Get-State).positions.$DamagedKey.cfi.StartsWith('epubcfi(/6/12!') } 'the place saved is the damaged chapter on screen'
  } finally {
    Stop-App $app
  }

  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.status -eq 'ok' -and $tab.position.cfi.StartsWith('epubcfi(/6/12!')) "a book reopens at its damaged chapter, not: $($tab.status), $($tab.position.cfi)"
    Assert-That ($tab.text -match $UnreadableSection) "a damaged chapter says so when the book reopens there, not: $($tab.text)"
    Pass 'a book closed on a damaged chapter opens there again, with the message'
  } finally {
    Stop-App $app
  }
}

# The scrolling view: a scroll after going to a place has to count like any other, or closing loses it.
function Set-EpubView([string]$View) {
  $state = Get-State
  $state.options | Add-Member -NotePropertyName 'epubView' -NotePropertyValue $View -Force
  [System.IO.File]::WriteAllText((Get-StateFile), ($state | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
}

function Test-EpubScrollPosition {
  Wait-AppGone
  $book = Copy-Fixture 'long-chapters.epub'
  Open-ToSavePosition $book
  Set-EpubView 'scrolled'
  try {
    Invoke-EpubScrollChecks $book
  } finally {
    Wait-AppGone
    # The tests after this one click on a short page, which here would be short of the middle of the window.
    Set-EpubView 'paginated'
  }
}

function Invoke-EpubScrollChecks([string]$book) {
  $app = Start-App @("`"$book`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    if (-not (Assert-KeysDo $window @($VK_CONTROL, $VK_RIGHT) { param($t) $t.position.cfi.StartsWith('epubcfi(/6/4!') -and $t.text.Contains('Chapter Two') } 'ctrl+right goes to the next section')) {
      'SKIP  the app is not in front, so a scroll in a book was not checked'
      return
    }
    Start-Sleep -Milliseconds $SaveSettleMs
    $top = (Get-Tabs)[0].position.cfi
    # One press: the first gesture is the one that went missing, and a later one spaced from it would have hidden that.
    Assert-That (Send-Keys $window ([byte[]]@($VK_NEXT))) 'the keys stay with the app'
    Start-Sleep -Milliseconds ($SaveSettleMs * 2)
    $scrolled = (Get-Tabs)[0].position.cfi
    Assert-That ($scrolled -ne $top -and $scrolled.StartsWith('epubcfi(/6/4!')) "the first scroll after going to a section counts: $top, then $scrolled"
    Wait-State { (Get-State).positions.$LongKey.cfi -eq $scrolled } "a scroll in a book is saved after it ends, $scrolled"
    Pass 'the first scroll after going to a section is saved'
    Assert-That (Assert-KeysDo $window @($VK_CONTROL, $VK_OEM_PLUS) { $true } 'ctrl+plus') 'the keys stay with the app'
    Start-Sleep -Milliseconds $SaveSettleMs
    $grown = (Get-Tabs)[0].position.cfi
    Assert-That ($grown -ne $top) "a change of size after a scroll stays there, it does not go back to the top of the section: $grown"
    Pass 'a change of size after that scroll keeps the place'
    Assert-That (Send-Keys $window ([byte[]]@($VK_NEXT))) 'the keys stay with the app'
    Start-Sleep -Milliseconds ($SaveSettleMs * 2)
    $line = (Get-Tabs)[0].position.cfi
    Assert-That ($line -ne $grown) "the next scroll counts too: $grown, then $line"
  } finally {
    Stop-App $app
  }
  $saved = (Get-State).positions.$LongKey.cfi
  Assert-That ($saved -eq $line) "closing keeps the last place, $line, not $saved"

  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.position.cfi -ne $top -and $tab.position.cfi.StartsWith('epubcfi(/6/4!')) "a book reopens at the scroll, not at the top of the section: $($tab.position.cfi)"
    Pass 'scroll, close, open again: the same place, not the top of the section'
  } finally {
    Stop-App $app
  }
}

function Test-EpubObfuscatedFont {
  Wait-AppGone
  $book = Copy-Fixture 'obfuscated-font.epub'
  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.status -eq 'ok' -and $tab.firstPageRendered) "a book that only hides its fonts opens, not: $($tab.status), $($tab.notice)"
    Assert-That ($tab.text.Contains($PlainFirstChapter)) "a book that only hides its fonts shows its text, not: $($tab.text)"
    Pass 'a book that only hides its fonts is not taken for DRM'
  } finally {
    Stop-App $app
  }
}

function Test-EpubWithoutIdentifier {
  Wait-AppGone
  $book = Copy-Fixture 'no-id.epub'
  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.status -eq 'ok' -and $tab.firstPageRendered) "a book without an identifier opens, not: $($tab.status)"
    $hash = (Get-FileHash $book -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-That ($tab.key -eq "sha256:$hash") "a book without an identifier is known by its hash, not $($tab.key)"
    Pass 'a book without an identifier is known by the hash of its file'
  } finally {
    Stop-App $app
  }
}

function Set-SavedCfi([string]$Key, [string]$Cfi) {
  $state = Get-State
  $position = [pscustomobject]@{ kind = 'epub'; cfi = $Cfi; sentence = 0 }
  $state.positions | Add-Member -NotePropertyName $Key -NotePropertyValue $position -Force
  [System.IO.File]::WriteAllText((Get-StateFile), ($state | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
}

function Set-Bookmark([string]$Key, [string]$Path, [string]$Cfi) {
  $state = Get-State
  $position = [pscustomobject]@{ kind = 'epub'; cfi = $Cfi; sentence = 0 }
  $state.bookmarks = @([pscustomobject]@{ key = $Key; path = $Path; title = 'Bookmarked'; position = $position; excerpt = ''; createdAt = 1 })
  [System.IO.File]::WriteAllText((Get-StateFile), ($state | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
}

function Test-EpubPosition {
  Wait-AppGone
  $book = Copy-Fixture 'plain.epub'
  Open-ToSavePosition $book
  $saved = (Get-State).positions.$PlainKey
  Assert-That ($saved.kind -eq 'epub' -and $saved.cfi.StartsWith('epubcfi(')) "closing the app saves the place in a book, not $($saved | ConvertTo-Json -Compress)"
  Pass 'closing the app saves the place in a book'

  # Written here so that this part does not depend on Windows letting real keys through.
  Set-SavedCfi $PlainKey $PlainSecondChapterCfi
  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.text.Contains($PlainSecondChapter)) "a book opens at its saved place, not at: $($tab.text)"
    Pass 'a book opens at its saved place'
  } finally {
    Stop-App $app
  }

  $moved = Join-Path $Work 'spostato'
  New-Item -ItemType Directory $moved | Out-Null
  $elsewhere = Join-Path $moved 'un altro nome.epub'
  Set-Bookmark $PlainKey $book $PlainSecondChapterCfi
  Move-Item $book $elsewhere
  $app = Start-App @("`"$elsewhere`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.key -eq $PlainKey) "a moved book keeps its key, not $($tab.key)"
    Assert-That ($tab.text.Contains($PlainSecondChapter)) "a moved book opens at its saved place, not at: $($tab.text)"
    Pass 'a book moved and renamed opens at its saved place'
    Wait-State { @((Get-State).bookmarks | Where-Object { $_.path -eq $elsewhere }).Count -eq 1 } 'the bookmark of a moved book follows it to its new file'
    Pass 'the bookmark of a moved book follows it to its new file'
  } finally {
    Stop-App $app
  }

  Set-SavedCfi $PlainKey $NowhereCfi
  $app = Start-App @("`"$elsewhere`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.status -eq 'ok' -and $tab.firstPageRendered) "a saved place that leads nowhere still opens the book, not: $($tab.status), $($tab.notice)"
    Assert-That ($tab.text.Contains($PlainFirstChapter)) "a saved place that leads nowhere goes to the first page, not: $($tab.text)"
    Pass 'a saved place that leads nowhere opens the book at its first page'
  } finally {
    Stop-App $app
  }
}

function Send-Click([IntPtr]$Window, [int]$Times = 1) {
  if ([SmokeInput]::GetForegroundWindow() -ne $Window) { return $false }
  $box = New-Object SmokeInput+Rect
  [void][SmokeInput]::GetWindowRect($Window, [ref]$box)
  $back = [System.Windows.Forms.Cursor]::Position
  [void][SmokeInput]::SetCursorPos([int](($box.Left + $box.Right) / 2), [int](($box.Top + $box.Bottom) / 2))
  foreach ($press in 1..$Times) {
    if ($press -gt 1) { Start-Sleep -Milliseconds $DoubleClickGapMs }
    [SmokeInput]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    [SmokeInput]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
  Start-Sleep -Milliseconds $SecondProcessMs
  [System.Windows.Forms.Cursor]::Position = $back
  $true
}

# A note where a link lies under the middle of the window wherever it is scrolled to, and a list of headings that reaches
# the middle of the window too. The first click of a double click on a row closes the list and uncovers a link.
function Test-RowDoubleClick {
  Wait-AppGone
  $target = New-Note 'destinazione.md' 'La nota dei link.'
  $picture = New-Object System.Drawing.Bitmap $ImageWidth, $ImageHeight
  try { $picture.Save((Join-Path $Work 'link.png'), [System.Drawing.Imaging.ImageFormat]::Png) } finally { $picture.Dispose() }
  $note = Join-Path $Work 'tutti link.md'
  $link = '[![](link.png)](destinazione.md)'
  Write-Note $note ((1..$RowsOfHeadings | ForEach-Object { "## Titolo $_`n`n$link`n`n$link`n" }) -join "`n")
  $app = Start-App @("`"$note`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Sleep -Milliseconds $ImagesSettleMs
    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    if (-not (Assert-KeysDo $window @($VK_CONTROL, $VK_T) { param($t) $t.panel -eq 'toc' } 'ctrl+t opens the contents')) {
      'SKIP  the app is not in front, so a double click on a row was not checked'
      return
    }
    if (-not (Send-Click $window 2)) { 'SKIP  the app is not in front, so a double click on a row was not checked'; return }
    Start-Sleep -Milliseconds $SaveSettleMs
    $tabs = @(Get-Tabs)
    Assert-That (-not $tabs[0].panel) 'the first click lands on a row, which closes the list'
    Assert-That ($tabs.Count -eq 1) "the second click of a double click on a row opens nothing, found $($tabs.Count) tabs"
    # Without a link there, no tab opening proves nothing.
    if (-not (Send-Click $window)) { 'SKIP  the app is not in front, so the link behind the list was not checked'; return }
    Wait-Tabs 2 { param($t) @($t | Where-Object { $_.path -eq $target }).Count -eq 1 } | Out-Null
    Pass 'the second click of a double click on a row stays away from the link behind the list'
  } finally {
    Stop-App $app
  }
}

# Presses keys and waits for the tabs to say what they should. False: Windows kept the keys away, nothing was checked.
function Assert-KeysDo([IntPtr]$Window, [byte[]]$Keys, [scriptblock]$Done, [string]$What) {
  if (-not (Send-Keys $Window ([byte[]]$Keys.Clone()))) { return $false }
  $limit = (Get-Date).AddSeconds($StateWaitS)
  while (-not (& $Done (@(Get-Tabs)[0]))) {
    if ((Get-Date) -gt $limit) { throw "FAIL  $What" }
    Start-Sleep -Milliseconds $AppPollMs
  }
  $true
}

function Test-EpubKeys {
  Wait-AppGone
  $book = Copy-Fixture 'plain.epub'
  Open-ToSavePosition $book
  Set-SavedCfi $PlainKey 'epubcfi(/6/2!/4/2/1:0)'
  $app = Start-App @("`"$book`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    $inSecond = { param($t) $t.text.Contains($PlainSecondChapter) }
    $inFirst = { param($t) $t.text.Contains($PlainFirstChapter) }
    if (-not (Assert-KeysDo $window @($VK_RIGHT) $inSecond 'the right arrow turns the page of a book just opened')) {
      'SKIP  the app is not in front, so the keys in a book were not checked'
      return
    }
    Pass 'the right arrow turns the page of a book just opened'

    # Twice over, because a key pressed in a book only reaches the app through the frame of its section.
    foreach ($round in 1, 2) {
      if (-not (Send-Click $window)) { 'SKIP  the app is not in front, so a click in a book was not checked'; return }
      $tab = @(Get-Tabs)[0]
      Assert-That ($tab.focused -eq 'foliate-view') "round ${round}: a click puts the focus in the book, not on $($tab.focused)"
      $bookmarks = @((Get-State).bookmarks).Count
      Assert-That (Assert-KeysDo $window @($VK_CONTROL, $VK_D) { $true } 'ctrl+d') 'the keys stay with the app'
      Wait-State { @((Get-State).bookmarks).Count -eq $bookmarks + 1 } "round ${round}: ctrl+d in a book adds a bookmark"
      Assert-That (Assert-KeysDo $window @($VK_CONTROL, $VK_D) { $true } 'ctrl+d') 'the keys stay with the app'
      Wait-State { @((Get-State).bookmarks).Count -eq $bookmarks } "round ${round}: ctrl+d again takes the same bookmark away"
      Assert-That (Assert-KeysDo $window @($VK_CONTROL, $VK_T) { param($t) $t.panel -eq 'toc' } "round ${round}: ctrl+t in a book opens the contents") 'the keys stay with the app'
      Assert-That (Assert-KeysDo $window @($VK_ESCAPE) { param($t) -not $t.panel } "round ${round}: esc closes the contents") 'the keys stay with the app'
      Assert-That ((@(Get-Tabs)[0]).focused -eq 'foliate-view') "round ${round}: after a panel the keys go back to the book"
      $size = (Get-State).options.textSize
      Assert-That (Assert-KeysDo $window @($VK_CONTROL, $VK_OEM_PLUS) { $true } 'ctrl+plus') 'the keys stay with the app'
      Wait-State { (Get-State).options.textSize -ne $size } "round ${round}: ctrl+plus in a book changes the text size"
      $there = if ($round -eq 1) { $inFirst } else { $inSecond }
      $key = if ($round -eq 1) { $VK_LEFT } else { $VK_RIGHT }
      Assert-That (Assert-KeysDo $window @($key) $there "round ${round}: an arrow after a click turns the page") 'the keys stay with the app'
    }
    Pass 'after a click and after a new section the keys of the app work in a book'
    $line = (Get-Tabs)[0].position.cfi
  } finally {
    Stop-App $app
  }

  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.position.cfi -eq $line) "open, turn a page, close, open again: $line, not $($tab.position.cfi)"
    Assert-That ($tab.text.Contains($PlainSecondChapter)) 'open, turn a page, close, open again: the same section'
    Pass 'open, turn a page, close, open again: the same point'
  } finally {
    Stop-App $app
  }
}

# A book changing on disk. Whether the new file can be read shows only once it has a page, so until then the old one stays.
function Test-EpubChangesOnDisk {
  Wait-AppGone
  $book = Copy-Fixture 'plain.epub'
  $whole = [System.IO.File]::ReadAllBytes($book)
  Open-ToSavePosition $book
  Set-SavedCfi $PlainKey $PlainSecondChapterCfi
  $app = Start-App @("`"$book`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].text.Contains($PlainSecondChapter) } | Out-Null

    [System.IO.File]::WriteAllBytes($book, $whole[0..($CutBookBytes - 1)])
    if (-not (Invoke-FocusReturn $window)) {
      'SKIP  Windows did not let the focus move, so a second process asks for the check instead'
      Start-Second "`"$book`""
    }
    $tab = (Wait-Tabs 1 { param($t) $t[0].notice.Length -gt 0 })[0]
    Assert-That ($tab.status -eq 'ok') "a book cut short on disk keeps its tab as it was, not: $($tab.status)"
    Assert-That ($tab.firstPageRendered) 'a book cut short on disk still shows its page'
    Assert-That ($tab.text.Contains($PlainSecondChapter)) "the text stays when the book is cut short on disk, not: $($tab.text)"
    Pass 'a book cut short on disk keeps its text and gets a message'

    [System.IO.File]::WriteAllBytes($book, $whole)
    if (-not (Invoke-FocusReturn $window)) { Start-Second "`"$book`"" }
    $tab = (Wait-Tabs 1 { param($t) $t[0].notice.Length -eq 0 })[0]
    Assert-That ($tab.status -eq 'ok' -and $tab.firstPageRendered) "the whole book comes back, not: $($tab.status)"
    Assert-That ($tab.text.Contains($PlainSecondChapter)) "the whole book comes back at the same place, not: $($tab.text)"
    Pass 'a book whole again on disk comes back by itself at the same place'
  } finally {
    Stop-App $app
  }
}

function Test-FixedLayoutEpub {
  # Pages one to a screen, and pages in pairs, where the first page has an empty frame next to it.
  foreach ($fixture in 'fixed.epub', 'fixed-spread.epub') { Test-FixedLayoutBook $fixture }
}

function Test-FixedLayoutBook([string]$Fixture) {
  Wait-AppGone
  $book = Copy-Fixture $Fixture
  $app = Start-App @("`"$book`"")
  try {
    $window = Wait-AppWindow $app
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -ne 'loading' })[0]
    Assert-That ($tab.status -eq 'ok' -and $tab.firstPageRendered) "$Fixture opens, not: $($tab.status), $($tab.notice)"
    Assert-That ($tab.text.Contains($PlainFirstChapter)) "the first page of $Fixture has its text, not: $($tab.text)"
    Pass "$Fixture opens"
    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    if (-not (Assert-KeysDo $window @($VK_CONTROL, $VK_T) { param($t) $t.panel -eq 'toc' } "ctrl+t opens the contents of $Fixture")) {
      "SKIP  the app is not in front, so the keys in $Fixture were not checked"
      return
    }
    Assert-That (Assert-KeysDo $window @($VK_ESCAPE) { param($t) -not $t.panel } "esc closes the contents of $Fixture") 'the keys stay with the app'
    Assert-That (Assert-KeysDo $window @($VK_RIGHT) { param($t) $t.text.Contains($PlainSecondChapter) } "the right arrow goes to the next page of $Fixture") 'the keys stay with the app'
    Pass "the keys of the app work in $Fixture"
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

function Test-LicensesPanel {
  Wait-AppGone
  $note = New-Note 'licenze.md' 'Una frase da leggere.'
  $app = Start-App @("`"$note`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Second '--show-panel licenses'
    $text = (Wait-Tabs 1 { param($t) $t[0].licensesText })[0].licensesText
    foreach ($expected in 'GNU GENERAL PUBLIC LICENSE', 'Rust standard library', 'NSIS installer runtime', 'tauri 2.12.4') {
      Assert-That ($text.Contains($expected)) "the licenses in the app name $expected"
    }
    Assert-That (-not $text.Contains('<!doctype')) 'the licenses are the file, not the page in its place'
    Pass 'the app shows the licenses it carries'

    [void][SmokeInput]::SetForegroundWindow($window)
    Start-Sleep -Milliseconds $SecondProcessMs
    # Another window can take the front at any step here: that says nothing about the app.
    $notInFront = 'SKIP  the app is not in front, so the way from the options to the licenses was not checked'
    if (-not (Assert-KeysDo $window @($VK_ESCAPE) { param($t) -not $t.panel } 'esc closes the licenses')) { $notInFront; return }
    if (-not (Assert-KeysDo $window @($VK_CONTROL, $VK_OEM_COMMA) { param($t) $t.panel -eq 'options' } 'ctrl+comma opens the options')) { $notInFront; return }
    $tabs = 0
    # The panel has other buttons before it: its close button and the text size.
    while ((@(Get-Tabs)[0]).focused -ne 'button' -or (@(Get-Tabs)[0]).focusedText -notmatch 'Licen') {
      $tabs++
      Assert-That ($tabs -le $MaxTabsToLicenses) 'the options have a button for the licenses'
      if (-not (Send-Keys $window @($VK_TAB))) { $notInFront; return }
    }
    if (-not (Assert-KeysDo $window @($VK_RETURN) { param($t) $t.licensesText } 'the button shows the licenses')) { $notInFront; return }
    Pass 'the options lead to the licenses'
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
$AllTests = @(
  'Test-EmptyStart',
  'Test-Burst',
  'Test-RunningApp',
  'Test-UnreachableFile',
  'Test-FailedTabRetries',
  'Test-LargeFile',
  'Test-FirstKeysReachTheText',
  'Test-BrowserKeysKeepTheSession',
  'Test-DeletedFile',
  'Test-Position',
  'Test-CollapsedSections',
  'Test-PositionWithImages',
  'Test-WindowPlacement',
  'Test-RowDoubleClick',
  'Test-EpubOpens',
  'Test-EpubScripts',
  'Test-EpubSelfScript',
  'Test-EpubNoNetwork',
  'Test-EpubSvgPages',
  'Test-EpubLinks',
  'Test-BrokenEpubs',
  'Test-EpubDamagedChapters',
  'Test-EpubScrollPosition',
  'Test-EpubObfuscatedFont',
  'Test-EpubWithoutIdentifier',
  'Test-EpubPosition',
  'Test-EpubChangesOnDisk',
  'Test-EpubKeys',
  'Test-FixedLayoutEpub',
  'Test-CorruptState',
  'Test-LicensesPanel',
  'Test-NetLogStaysLocal',
  'Test-SpeechMarkdown',
  'Test-SpeechEnd',
  'Test-SpeechVoiceGone',
  'Test-SpeechNothingOrNoVoice',
  'Test-SpeechTwoTabs',
  'Test-SpeechVoiceOptions',
  'Test-SpeechBook',
  'Test-SpeechBookPages',
  'Test-SpeechFixedLayout',
  'Test-SpeechKeys',
  'Test-SpeechClick',
  'Test-SpeechCloseWhileReading',
  'Test-SpeechFileChanges',
  'Test-SpeechMenu',
  'Test-SpeechWheel'
)
foreach ($name in $Only) {
  if ($AllTests -notcontains $name) { throw "no test named $name" }
}
try {
  foreach ($test in $AllTests) {
    if (-not $Only -or $Only -contains $test) { & $test }
  }
  'smoke: all checks passed'
} finally {
  Get-AppMainProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
