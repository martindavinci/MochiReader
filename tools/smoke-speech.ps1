# SPDX-License-Identifier: GPL-3.0-or-later
# Part of tools/smoke.ps1: reading aloud in the real app, with the real voices of Windows, at a volume hardly heard and for
# as short as each check allows. Nobody listens: everything here is what the page says about itself.
# Media keys are only ever pressed from inside the page: a real key would reach whatever else plays on this machine.
$SpeechTestVolume = '0.05'
$SpeechFastPresses = 14
$SpeechWaitS = 20
$SpeechPollMs = 200
$SpeechSentenceJumps = 8
$SpeechFollowMaxLines = 40
$PressKeyAndAction = 'press.MediaPlayPause.pause'
$VK_SPACE = 0x20
$MOUSEEVENTF_RIGHTDOWN = 8
$MOUSEEVENTF_RIGHTUP = 16
$MOUSEEVENTF_WHEEL = 0x0800
$WheelDown = [uint32]::MaxValue - 120 + 1

function Send-Speech([string]$Command) { Start-Second "--speech $Command" }

function Wait-Speech([scriptblock]$Done, [string]$What, [int]$Tab = 0) {
  $limit = (Get-Date).AddSeconds($SpeechWaitS)
  while ($true) {
    $tabs = @(Get-Tabs)
    if (& $Done $tabs[$Tab]) { return $tabs[$Tab] }
    if ((Get-Date) -gt $limit) { throw "FAIL  $What, the report says: $($tabs[$Tab].speech | ConvertTo-Json -Compress -Depth 4) toast: $($tabs[$Tab].toast) panel: $($tabs[$Tab].panelText)" }
    Start-Sleep -Milliseconds $SpeechPollMs
  }
}

function Start-Reading {
  Start-Second "--speech-test-volume $SpeechTestVolume"
  Start-Sleep -Milliseconds $SecondProcessMs
  Send-Speech 'speech.start'
}

# As fast as the voice goes: what is said here is only there to be over.
function Set-SpeechFast {
  foreach ($press in 1..$SpeechFastPresses) { Send-Speech 'speech.faster' }
  Wait-Speech { param($t) $t.speech.rate -eq 3 } 'the speed reaches its top' | Out-Null
}

function New-SpeechNote([string]$Name, [int]$Paragraphs = 30) {
  $path = Join-Path $Work $Name
  $text = (1..$Paragraphs | ForEach-Object { "Questa $([char]0xE8) la frase numero $_ del testo. Questa $([char]0xE8) la sua seconda frase.`n" }) -join "`n"
  Write-Note $path "---`nlang: it`n---`n# Titolo della nota`n`n$text"
  $path
}

function Test-SpeechMarkdown {
  Wait-AppGone
  $note = New-SpeechNote 'lettura.md'
  $app = Start-App @("`"$note`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Reading
    $tab = Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'reading starts'
    Assert-That ($tab.speech.highlight.Count -eq 1 -and $tab.speech.highlight[0] -eq $tab.speech.sentence) "the sentence read is the one highlighted: $($tab.speech | ConvertTo-Json -Compress)"
    Assert-That ($tab.speech.audioPlaying) 'the silent audio plays while reading'
    Assert-That ($tab.speechBar.Contains('lettura.md')) "the bar says what is being read: $($tab.speechBar)"
    Pass 'a note is read aloud, with its sentence highlighted, a bar, and the silent audio playing'

    Send-Speech 'media.pause'
    $tab = Wait-Speech { param($t) $t.speech.state -eq 'paused' } 'the pause action of the media session pauses'
    Assert-That (-not $tab.speech.audioPlaying) 'in a pause the audio is really paused'
    Send-Speech 'media.play'
    $tab = Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'the play action of the media session resumes'
    Assert-That ($tab.speech.audioPlaying) 'after a pause the audio plays again'
    $before = $tab.speech.current
    Send-Speech 'media.nexttrack'
    Wait-Speech { param($t) $t.speech.current.block -gt $before.block -or $t.speech.current.sentence -gt $before.sentence } 'the next action of the media session moves on' | Out-Null
    Send-Speech $PressKeyAndAction
    Wait-Speech { param($t) $t.speech.state -eq 'paused' } 'a press seen as key and action pauses' | Out-Null
    Start-Sleep -Milliseconds $SpeechPollMs
    Assert-That ((Get-Tabs)[0].speech.state -eq 'paused') 'a press seen as key and action counts once'
    Send-Speech 'speech.toggle'
    Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'toggling resumes' | Out-Null
    Pass 'the handlers of the media session act on the reading, and a press seen twice counts once'

    Set-SpeechFast
    Assert-That ((Get-State).options.speechRate -eq 3) 'the speed is kept'
    $saved = Get-SavedPosition 'lettura.md'
    Wait-State { $now = Get-SavedPosition 'lettura.md'; $now.line -ne $saved.line -or $now.sentence -ne $saved.sentence } 'the position moves with each sentence'
    Pass 'the position is saved at each change of sentence, and the speed is kept'

    foreach ($jump in 1..$SpeechSentenceJumps) { Send-Speech 'speech.nextBlock' }
    $tab = Wait-Speech { param($t) $t.speech.current.block -ge $SpeechSentenceJumps } 'moving on by block'
    Start-Sleep -Milliseconds $SpeechPollMs
    $tab = (Get-Tabs)[0]
    Assert-That ($tab.screenLine -gt 1 -and [math]::Abs($tab.position.line - $tab.screenLine) -lt $SpeechFollowMaxLines) "the page follows the sentence: screen at line $($tab.screenLine), voice at line $($tab.position.line)"
    Pass 'the page follows the sentence'

    Send-Speech 'key.PageDown'
    $tab = Wait-Speech { param($t) -not $t.speech.following } 'a scrolling key lets go of the sentence'
    Assert-That ($tab.speechBar.Contains('frase') -or $tab.speechBar.Contains('sentence')) "the bar offers to follow again: $($tab.speechBar)"
    Send-Speech 'speech.follow'
    Wait-Speech { param($t) $t.speech.following } 'following again' | Out-Null
    Pass 'moving by hand stops the following until asked again'

    $tab = (Get-Tabs)[0]
    Send-Speech 'speech.toggle'
    $tab = Wait-Speech { param($t) $t.speech.state -eq 'paused' } 'a pause before closing'
    Start-Sleep -Milliseconds $SaveSettleMs
    $sentence = $tab.speech.sentence
    $position = (Get-Tabs)[0].position
  } finally {
    Stop-App $app
  }

  $saved = Get-SavedPosition 'lettura.md'
  Assert-That ($saved.line -eq $position.line -and $saved.sentence -eq $position.sentence) "the sentence read is saved at closing: line $($position.line) sentence $($position.sentence), saved $($saved | ConvertTo-Json -Compress)"
  $app = Start-App @("`"$note`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' -and $t[0].position.line -eq $saved.line })[0]
    Assert-That ($tab.position.sentence -eq $saved.sentence) "reopened at sentence $($saved.sentence), not $($tab.position.sentence)"
    Start-Reading
    $tab = Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'reading starts where it stopped'
    Assert-That ($tab.speech.sentence -eq $sentence) "reading starts at '$sentence', not '$($tab.speech.sentence)'"
    Pass 'closed and opened again, the reading goes on from the same sentence'
  } finally {
    Stop-App $app
  }
}

function Test-SpeechEnd {
  Wait-AppGone
  $note = New-SpeechNote 'fine.md' 1
  $app = Start-App @("`"$note`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Reading
    Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'reading starts' | Out-Null
    Set-SpeechFast
    Wait-Speech { param($t) -not $t.speech } 'the end of the file stops the reading' | Out-Null
    $tabs = @(Get-Tabs)
    Assert-That ($tabs.Count -eq 1) 'the end of a file opens nothing else'
    Assert-That (-not $tabs[0].toast) "the end of a file is no error: $($tabs[0].toast)"
    Pass 'at the end of a file the reading stops, and nothing else opens'
  } finally {
    Stop-App $app
  }
}

function Test-SpeechVoiceGone {
  Wait-AppGone
  $note = New-SpeechNote 'voce persa.md' 4
  $app = Start-App @("`"$note`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Reading
    $tab = Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'reading starts'
    $position = $tab.position
    Send-Speech 'voice-gone'
    $tab = Wait-Speech { param($t) -not $t.speech } 'a voice that is gone stops the reading'
    Assert-That ($tab.toast -and ($tab.toast.Contains('voice') -or $tab.toast.Contains('voce'))) "a message says why: $($tab.toast)"
    Assert-That ($tab.position.line -eq $position.line) 'the position stays where the voice was'
    Pass 'a voice that fails stops the reading with a message, and the position stays'
  } finally {
    Stop-App $app
  }
}

function Test-SpeechNothingOrNoVoice {
  Wait-AppGone
  $code = Join-Path $Work 'solo codice.md'
  Write-Note $code "``````text`nsolo codice`n``````n"
  # No voice of Windows speaks Klingon, whatever is installed.
  $foreign = Join-Path $Work 'altra lingua.md'
  Write-Note $foreign "---`nlang: tlh`n---`nNuqneH, this is a sentence with no voice to read it.`n"
  $app = Start-App @("`"$code`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Reading
    $tab = Wait-Speech { param($t) $t.toast } 'a file of only code says it has nothing to read'
    Assert-That (-not $tab.speech) 'nothing is being read'
    Pass 'a file with nothing to read says so, and the voice does not wait'
    Start-Second "`"$foreign`""
    Wait-Tabs 2 { param($t) @($t | Where-Object { $_.status -eq 'ok' }).Count -eq 2 } | Out-Null
    Send-Speech 'speech.start'
    $tab = Wait-Speech { param($t) $t.panel -eq 'voice-help' } 'a language with no voice opens the message' 1
    Assert-That (-not $tab.speech) 'nothing is being read'
    Assert-That ($tab.panelText -match 'Windows') "the message tells about Windows: $($tab.panelText)"
    Pass 'a language with no voice says how to add one in Windows'
  } finally {
    Stop-App $app
  }
}

function Test-SpeechTwoTabs {
  Wait-AppGone
  $first = New-SpeechNote 'uno.md'
  $second = New-SpeechNote 'due.md'
  $app = Start-App @("`"$first`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Reading
    Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'reading starts' | Out-Null
    Start-Second "`"$second`""
    Wait-Tabs 2 { param($t) @($t | Where-Object { $_.status -eq 'ok' }).Count -eq 2 } | Out-Null
    $tabs = @(Get-Tabs)
    Assert-That ($tabs[0].speech.state -eq 'playing') 'a new tab does not stop the voice'
    Assert-That ($tabs[0].speechBar.Contains('uno.md')) "the bar still says what is being read: $($tabs[0].speechBar)"
    Send-Speech 'speech.start'
    Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'the tab in front starts reading' 1 | Out-Null
    Assert-That (-not (Get-Tabs)[0].speech) 'one tab reads at a time'
    Pass 'one tab reads at a time, and another tab in front does not stop it'
    Send-Speech 'tab.close'
    Wait-Tabs 1 { param($t) -not $t[0].speech } | Out-Null
    Pass 'closing the tab being read stops the voice'
  } finally {
    Stop-App $app
  }
}

function Test-SpeechVoiceOptions {
  Wait-AppGone
  $note = New-SpeechNote 'opzioni.md' 1
  $app = Start-App @("`"$note`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Second '--show-panel options'
    $tab = Wait-Speech { param($t) $t.panelText -match 'Elsa|Cosimo|Mark|Zira|David' } 'the options list the voices of Windows'
    Assert-That ($tab.panelText -match 'Elsa|Cosimo') "the Italian voices are offered: $($tab.panelText)"
    Pass 'the options offer a voice for each language'
  } finally {
    Stop-App $app
  }
}

function Test-SpeechBook {
  Wait-AppGone
  $book = Copy-Fixture 'plain.epub'
  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Reading
    $tab = Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'a book is read aloud'
    Assert-That ($tab.speech.highlight.Count -eq 1 -and $tab.speech.highlight[0] -eq $tab.speech.sentence) "the highlight is made in the frame of the book, whose scripts are blocked: $($tab.speech | ConvertTo-Json -Compress)"
    Pass 'the sentence of a book is highlighted in its sandboxed frame, by the player and not by hand'

    Set-SpeechFast
    Wait-Speech { param($t) -not $t.speech -or $t.text.Contains($PlainSecondChapter) } 'the reading passes to the next chapter by itself' | Out-Null
    Wait-Speech { param($t) -not $t.speech } 'the book ends the reading' | Out-Null
    $tab = (Get-Tabs)[0]
    Assert-That ($tab.text.Contains($PlainSecondChapter)) 'the page went along to the last chapter'
    Assert-That (-not $tab.toast) "the end of a book is no error: $($tab.toast)"
    Pass 'a book goes on from chapter to chapter, with the page, and ends at its end'

    $saved = (Get-State).positions.$PlainKey
    Assert-That ($saved.cfi -and $saved.cfi.StartsWith('epubcfi(/6/4')) "the place saved is in the last chapter: $($saved.cfi)"
    $cfi = (Get-Tabs)[0].position.cfi
    Assert-That ($cfi -eq $saved.cfi) "the sentence stays the position once the voice stops: $cfi and $($saved.cfi)"
  } finally {
    Stop-App $app
  }
  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    $tab = (Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' })[0]
    Assert-That ($tab.position.cfi -eq $saved.cfi) "reopened at the sentence, $($saved.cfi), not $($tab.position.cfi)"
    Assert-That ($tab.text.Contains($PlainSecondChapter)) 'reopened in the same chapter'
    Pass 'a book closed while reading opens again at the same sentence'
  } finally {
    Stop-App $app
  }
}

function Test-SpeechBookPages {
  Wait-AppGone
  $book = Copy-Fixture 'long-chapters.epub'
  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    $first = (Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' })[0]
    Start-Reading
    Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'a long book is read aloud' | Out-Null
    $pages = $first.excerpt
    foreach ($jump in 1..$SpeechFastPresses) { Send-Speech 'speech.nextBlock' }
    $tab = Wait-Speech { param($t) $t.speech.current.block -ge $SpeechSentenceJumps -and $t.excerpt -ne $pages } 'the page follows the sentence in a book'
    Assert-That ($tab.speech.highlight[0] -eq $tab.speech.sentence) "the highlight stays on the sentence on another page: $($tab.speech | ConvertTo-Json -Compress)"
    Pass 'the page of a book turns to follow the sentence'
    Send-Speech 'speech.nextSection'
    $tab = Wait-Speech { param($t) $t.speech.state -eq 'playing' -and $t.text.Contains('Chapter Two') -and $t.excerpt.Contains('Chapter Two') } 'moving by section passes to the next chapter, with its page'
    Assert-That ($tab.speech.highlight[0] -eq $tab.speech.sentence) "the highlight comes along to the new frame: $($tab.speech | ConvertTo-Json -Compress)"
    Send-Speech 'speech.prevSection'
    Wait-Speech { param($t) $t.speech.state -eq 'playing' -and $t.text.Contains('Chapter One') } 'moving back by section passes to the chapter before' | Out-Null
    Pass 'moving by section goes from chapter to chapter, both ways'
  } finally {
    Stop-App $app
  }
}

function Test-SpeechFixedLayout {
  Wait-AppGone
  $book = Copy-Fixture 'fixed.epub'
  $app = Start-App @("`"$book`"")
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Reading
    $tab = Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'a book of fixed pages is read aloud'
    Assert-That ($tab.speech.highlight[0] -eq $tab.speech.sentence) "the highlight works on a fixed page: $($tab.speech | ConvertTo-Json -Compress)"
    Set-SpeechFast
    Wait-Speech { param($t) -not $t.speech } 'a book of fixed pages ends the reading at its last page' | Out-Null
    Assert-That ((Get-Tabs)[0].text.Contains($PlainSecondChapter)) 'the spread went along to the last page'
    Pass 'a book of fixed pages is read to its end, spread after spread'
  } finally {
    Stop-App $app
  }
}

# Real keys, sent only with the app in front. None of them is a media key: those would reach whatever else plays here.
function Test-SpeechKeys {
  foreach ($file in (New-SpeechNote 'tasti lettura.md'), (Copy-Fixture 'long-chapters.epub')) {
    Wait-AppGone
    $app = Start-App @("`"$file`"")
    try {
      $window = Wait-AppWindow $app
      Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
      Start-Second "--speech-test-volume $SpeechTestVolume"
      Start-Sleep -Milliseconds $SecondProcessMs
      [void][SmokeInput]::SetForegroundWindow($window)
      Start-Sleep -Milliseconds $SecondProcessMs
      if (-not (Assert-KeysDo $window @($VK_F5) { param($t) $t.speech.state -eq 'playing' } 'f5 starts reading')) {
        'SKIP  the app is not in front, so the keys of the reading were not checked'
        return
      }
      Assert-That (Assert-KeysDo $window @($VK_SPACE) { param($t) $t.speech.state -eq 'paused' } 'space pauses') 'the keys stay with the app'
      Assert-That (Assert-KeysDo $window @($VK_RIGHT) { param($t) $t.speech.current.block -gt 0 -or $t.speech.current.sentence -gt 0 } 'the right arrow moves on in a pause') 'the keys stay with the app'
      $paused = (Get-Tabs)[0].speech.current
      Assert-That (Assert-KeysDo $window @($VK_LEFT) { param($t) $t.speech.current.block -lt $paused.block -or $t.speech.current.sentence -lt $paused.sentence } 'the left arrow goes back') 'the keys stay with the app'
      Assert-That (Assert-KeysDo $window @($VK_OEM_PLUS) { param($t) $t.speech.rate -gt 1 } 'plus reads faster') 'the keys stay with the app'
      Assert-That (Assert-KeysDo $window @($VK_SPACE) { param($t) $t.speech.state -eq 'playing' } 'space resumes') 'the keys stay with the app'
      Pass "the keys of the reading work in $(Split-Path $file -Leaf)"
    } finally {
      Stop-App $app
    }
  }
}

# A real click on the middle of the window, which only goes out with the app in front.
function Test-SpeechClick {
  foreach ($file in (New-SpeechNote 'clic.md' 80), (Copy-Fixture 'long-chapters.epub')) {
    Wait-AppGone
    $app = Start-App @("`"$file`"")
    try {
      $window = Wait-AppWindow $app
      Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
      [void][SmokeInput]::SetForegroundWindow($window)
      Start-Sleep -Milliseconds $SecondProcessMs
      if (-not (Send-Click $window)) { 'SKIP  the app is not in front, so a click was not checked'; return }
      Assert-That (-not (Get-Tabs)[0].speech) 'from idle a click does not start the voice'
      Start-Reading
      $tab = Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'reading starts'
      $before = $tab.speech.current.block
      if (-not (Send-Click $window)) { 'SKIP  the app is not in front, so a click was not checked'; return }
      $tab = Wait-Speech { param($t) $t.speech.current.block -gt $before } 'a click on a sentence takes the voice there'
      Pass "a click on a sentence takes the voice there in $(Split-Path $file -Leaf), and from idle it makes no sound"
    } finally {
      Stop-App $app
    }
  }
}

function Test-SpeechCloseWhileReading {
  Wait-AppGone
  $note = New-SpeechNote 'chiusura.md'
  $app = Start-App @("`"$note`"")
  $closed = $false
  try {
    Wait-AppWindow $app | Out-Null
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Reading
    Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'reading starts' | Out-Null
    Send-Speech 'speech.nextBlock'
    $tab = Wait-Speech { param($t) $t.speech.current.block -gt 0 } 'the voice moves on'
    $WM_CLOSE = 0x10
    [void][AppWindows]::PostMessage((Wait-AppWindow $app), $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    $closed = $app.WaitForExit($AppCloseWaitMs)
    Assert-That $closed 'the app closes while it reads'
  } finally {
    Stop-App $app
  }
  $saved = Get-SavedPosition 'chiusura.md'
  Assert-That ($saved.line -ge $tab.position.line) "the place of the voice is saved at closing: line $($saved.line), voice at $($tab.position.line)"
  Pass 'the app closes while it reads, with the place of the voice saved'
}

function Test-SpeechFileChanges {
  Wait-AppGone
  $note = New-SpeechNote 'cambia.md'
  $app = Start-App @("`"$note`"")
  try {
    $window = Wait-AppWindow $app
    Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
    Start-Reading
    Wait-Speech { param($t) $t.speech.state -eq 'playing' } 'reading starts' | Out-Null
    Write-Note $note "---`nlang: it`n---`n# Titolo della nota`n`nQuesto testo nuovo si legge da capo.`n`nE poi si continua.`n"
    if (-not (Invoke-FocusReturn $window)) { 'SKIP  the focus did not come back to the app, so a change of file while reading was not checked'; return }
    Wait-Speech { param($t) $t.speech.sentence -match 'nuovo|poi si continua|Titolo' -and $t.text.Contains('Questo testo nuovo') } 'the voice goes on in the new text' | Out-Null
    Pass 'a file changed while reading goes on in the new text'
  } finally {
    Stop-App $app
  }
}

# A real right click on the middle of the window, and real keys on the menu it opens, only with the app in front.
function Send-RightClick([IntPtr]$Window) {
  if ([SmokeInput]::GetForegroundWindow() -ne $Window) { return $false }
  $box = New-Object SmokeInput+Rect
  [void][SmokeInput]::GetWindowRect($Window, [ref]$box)
  $back = [System.Windows.Forms.Cursor]::Position
  [void][SmokeInput]::SetCursorPos([int](($box.Left + $box.Right) / 2), [int](($box.Top + $box.Bottom) / 2))
  [SmokeInput]::mouse_event($MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  [SmokeInput]::mouse_event($MOUSEEVENTF_RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $SecondProcessMs
  [System.Windows.Forms.Cursor]::Position = $back
  $true
}

function Test-SpeechMenu {
  foreach ($file in (New-SpeechNote 'menu.md' 80), (Copy-Fixture 'long-chapters.epub')) {
    Wait-AppGone
    $app = Start-App @("`"$file`"")
    try {
      $window = Wait-AppWindow $app
      Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
      Start-Second "--speech-test-volume $SpeechTestVolume"
      [void][SmokeInput]::SetForegroundWindow($window)
      Start-Sleep -Milliseconds $SecondProcessMs
      if (-not (Send-RightClick $window)) { 'SKIP  the app is not in front, so the menu of the text was not checked'; return }
      Wait-Speech { param($t) $t.textMenu } 'a right click opens the menu of the text' | Out-Null
      Assert-That (Assert-KeysDo $window @($VK_ESCAPE) { param($t) -not $t.textMenu } 'esc closes the menu') 'the keys stay with the app'
      Assert-That (-not (Get-Tabs)[0].speech) 'closing the menu reads nothing'
      if (-not (Send-RightClick $window)) { 'SKIP  the app is not in front, so the menu of the text was not checked'; return }
      Wait-Speech { param($t) $t.textMenu } 'a right click opens the menu again' | Out-Null
      Assert-That (Assert-KeysDo $window @($VK_RETURN) { param($t) $t.speech.state -eq 'playing' } 'the menu reads from there') 'the keys stay with the app'
      $tab = (Get-Tabs)[0]
      Assert-That ($tab.speech.current.block -gt 0) "reading starts at the point of the click, not at the top: $($tab.speech | ConvertTo-Json -Compress)"
      Pass "the menu of the text reads from where it was opened in $(Split-Path $file -Leaf)"
    } finally {
      Stop-App $app
    }
  }
}

# A real turn of the wheel over the middle of the window, only with the app in front: in a note, and in the scrolling
# view of a book, where it happens inside the frame of the section.
function Send-Wheel([IntPtr]$Window) {
  if ([SmokeInput]::GetForegroundWindow() -ne $Window) { return $false }
  $box = New-Object SmokeInput+Rect
  [void][SmokeInput]::GetWindowRect($Window, [ref]$box)
  $back = [System.Windows.Forms.Cursor]::Position
  [void][SmokeInput]::SetCursorPos([int](($box.Left + $box.Right) / 2), [int](($box.Top + $box.Bottom) / 2))
  [SmokeInput]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, $WheelDown, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $SecondProcessMs
  [System.Windows.Forms.Cursor]::Position = $back
  $true
}

function Test-SpeechWheel {
  $book = Copy-Fixture 'long-chapters.epub'
  foreach ($file in (New-SpeechNote 'rotella.md' 80), $book) {
    Wait-AppGone
    if ($file -eq $book) {
      Open-ToSavePosition $book
      Set-EpubView 'scrolled'
    }
    $app = Start-App @("`"$file`"")
    try {
      $window = Wait-AppWindow $app
      Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
      Start-Reading
      Wait-Speech { param($t) $t.speech.following } 'reading starts, following' | Out-Null
      [void][SmokeInput]::SetForegroundWindow($window)
      Start-Sleep -Milliseconds $SecondProcessMs
      if (-not (Send-Wheel $window)) { 'SKIP  the app is not in front, so the wheel was not checked'; return }
      Wait-Speech { param($t) -not $t.speech.following } 'the wheel lets go of the sentence' | Out-Null
      # The view reports a scroll a moment after it ends.
      Start-Sleep -Milliseconds $SaveSettleMs
      $tab = (Get-Tabs)[0]
      foreach ($jump in 1..$SpeechSentenceJumps) { Send-Speech 'speech.nextBlock' }
      Wait-Speech { param($t) $t.speech.current.block -ge $tab.speech.current.block + $SpeechSentenceJumps } 'the voice goes on' | Out-Null
      Start-Sleep -Milliseconds $SaveSettleMs
      $after = (Get-Tabs)[0]
      Assert-That ($after.excerpt -eq $tab.excerpt -and $after.screenLine -eq $tab.screenLine) "the text stays where the wheel left it: '$($tab.excerpt)' line $($tab.screenLine), then '$($after.excerpt)' line $($after.screenLine)"
      Send-Speech 'speech.follow'
      Wait-Speech { param($t) $t.speech.following -and $t.excerpt -ne $tab.excerpt } 'following again takes the text to the voice' | Out-Null
      Pass "the wheel stops the following in $(Split-Path $file -Leaf) until asked again"
    } finally {
      Stop-App $app
    }
  }
  Set-EpubView 'paginated'
}
