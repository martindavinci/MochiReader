# SPDX-License-Identifier: GPL-3.0-or-later
# Part of tools/smoke.ps1: what the browser tries to reach in a session, as its own log tells it. No packets are captured.
$NetLogDebugPort = 48320
# The last to go out without the flags is the update of components, about 60 s after the start.
$NetLogSessionS = 75
$NetLogPage = 'http://tauri.localhost/'
$NetLogAnswerMs = 15000
$NetLogBufferBytes = 65536
$NetLogHoverWaitMs = 1000
$HoveredHost = 'mochi-note-hovered.example.com'
$ShownLinkHost = 'mochi-note-shown.example.com'
$PictureHost = 'mochi-note-picture.example.com'
$WindowsVoices = 'HKLM:\SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens'
$SpokenSentence = 'One sentence, to hear the end of it.'
$SpokenVolume = 0.1

# One call to the page through the debugging port, which only this test opens.
function Invoke-Page([string]$Method, [hashtable]$Params) {
  $targets = Invoke-RestMethod "http://127.0.0.1:$NetLogDebugPort/json/list"
  $page = @($targets | Where-Object { $_.type -eq 'page' -and $_.url.StartsWith($NetLogPage) })
  Assert-That ($page.Count -eq 1) "the page of the app is on the debugging port, found: $($targets | ConvertTo-Json -Compress)"
  $socket = New-Object System.Net.WebSockets.ClientWebSocket
  $limit = New-Object System.Threading.CancellationTokenSource $NetLogAnswerMs
  try {
    $socket.ConnectAsync([Uri]$page[0].webSocketDebuggerUrl, $limit.Token).GetAwaiter().GetResult()
    $call = @{ id = 1; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 5
    $bytes = [System.ArraySegment[byte]]::new([System.Text.Encoding]::UTF8.GetBytes($call))
    $socket.SendAsync($bytes, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $limit.Token).GetAwaiter().GetResult()
    $buffer = [System.ArraySegment[byte]]::new((New-Object byte[] $NetLogBufferBytes))
    while ($true) {
      $text = New-Object System.Text.StringBuilder
      do {
        $part = $socket.ReceiveAsync($buffer, $limit.Token).GetAwaiter().GetResult()
        [void]$text.Append([System.Text.Encoding]::UTF8.GetString($buffer.Array, 0, $part.Count))
      } until ($part.EndOfMessage)
      $reply = $text.ToString() | ConvertFrom-Json
      if ($reply.id -eq 1) { return $reply }
    }
  } finally {
    $socket.Dispose()
    $limit.Dispose()
  }
}

function Invoke-PageScript([string]$Script) {
  $reply = Invoke-Page 'Runtime.evaluate' @{ expression = $Script; awaitPromise = $true; returnByValue = $true }
  Assert-That (-not $reply.result.exceptionDetails) "the page refused a script: $($reply | ConvertTo-Json -Compress -Depth 5)"
  $reply.result.result.value
}

# The app starts its browser with the flags of tauri.conf.json, and the runtime adds those of the test to them.
function Assert-BrowserHasTheFlags {
  $conf = [System.IO.File]::ReadAllText((Join-Path $AppRoot 'src-tauri\tauri.conf.json')) | ConvertFrom-Json
  $browser = @(Get-NetLogBrowser | Where-Object { -not $_.CommandLine.Contains('--type=') })
  Assert-That ($browser.Count -eq 1) "one browser process for the session, found $($browser.Count)"
  foreach ($flag in $conf.app.windows[0].additionalBrowserArgs -split ' ') {
    Assert-That ($browser[0].CommandLine.Contains($flag)) "the browser runs without $flag, on: $($browser[0].CommandLine)"
  }
  Pass 'the browser runs with the flags of tauri.conf.json, whatever the test adds'
}

function Get-NetLogBrowser {
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Work) }
}

function Assert-VoicesStayLocal {
  $voices = Invoke-PageScript @'
new Promise((done) => {
  const answer = () => done(JSON.stringify(speechSynthesis.getVoices().filter((voice) => voice.localService).map((voice) => voice.name)));
  if (speechSynthesis.getVoices().length) answer();
  else speechSynthesis.addEventListener('voiceschanged', answer);
})
'@ | ConvertFrom-Json
  Assert-That (@($voices).Count -gt 0) 'the page lists a local voice'
  foreach ($voice in Get-ChildItem $WindowsVoices | ForEach-Object { $_.GetValue('') }) {
    Assert-That ($voices -contains $voice) "the page lost $voice, it lists: $($voices -join ', ')"
  }
  $spoken = Invoke-PageScript @"
new Promise((done) => {
  const sentence = new SpeechSynthesisUtterance('$SpokenSentence');
  sentence.voice = speechSynthesis.getVoices().find((voice) => voice.localService);
  sentence.volume = $SpokenVolume;
  sentence.onend = () => done('end');
  sentence.onerror = (event) => done(event.error);
  window.mochiSpokenSentence = sentence;
  speechSynthesis.speak(sentence);
})
"@
  Assert-That ($spoken -eq 'end') "a sentence ends with onend, not with: $spoken"
  Pass "the page lists the voices of Windows and speaks with them: $($voices -join ', ')"
}

function Assert-LinkHovered {
  $middle = Invoke-PageScript @"
(() => {
  const box = document.querySelector('a[href*="$HoveredHost"]').getBoundingClientRect();
  return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
})()
"@ | ConvertFrom-Json
  $mouse = @{ type = 'mouseMoved'; x = $middle.x; y = $middle.y }
  [void](Invoke-Page 'Input.dispatchMouseEvent' $mouse)
  Start-Sleep -Milliseconds $NetLogHoverWaitMs
  # Without the mouse on the link, no lookup of its host proves nothing.
  $hovered = Invoke-PageScript 'document.querySelector("a:hover")?.href ?? ""'
  Assert-That ($hovered.Contains($HoveredHost)) "the mouse is on the link, not on: $hovered"
}

function Test-NetLogStaysLocal {
  Wait-AppGone
  $log = Join-Path $Work 'net-log.json'
  $note = Join-Path $Work 'link esterni.md'
  Write-Note $note "# Link`n`n[Sotto il mouse](https://$HoveredHost/a)`n`n[Solo a schermo](https://$ShownLinkHost/b)`n`n![Figura](https://$PictureHost/c.png)`n"
  $book = Copy-Fixture 'plain.epub'
  # A first session in a folder of its own: with nothing fetched yet, the runtime has the most to fetch.
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $Work 'webview'
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--log-net-log=`"$log`" --remote-debugging-port=$NetLogDebugPort"
  try {
    $app = Start-App @("`"$note`"")
    try {
      Wait-AppWindow $app | Out-Null
      Wait-Tabs 1 { param($t) $t[0].status -eq 'ok' } | Out-Null
      Assert-BrowserHasTheFlags
      Assert-VoicesStayLocal
      Assert-LinkHovered
      Start-Second "`"$book`""
      Wait-Tabs 2 { param($t) @($t | Where-Object { $_.status -eq 'ok' }).Count -eq 2 } | Out-Null
      Start-Sleep -Seconds $NetLogSessionS
    } finally {
      Stop-App $app
    }
    # The browser ends after the app, and finishes the log as it does.
    $limit = (Get-Date).AddSeconds($AppWaitS)
    while (Get-NetLogBrowser) {
      if ((Get-Date) -gt $limit) { throw 'FAIL  the browser of the session did not end' }
      Start-Sleep -Milliseconds $AppPollMs
    }
  } finally {
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER, Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  }
  $seen = & node (Join-Path $AppRoot 'tools\net-log.mjs') $log | ConvertFrom-Json
  Assert-That ($seen.complete) 'the browser finished its log'
  # Without the page in it, a log with no other host proves nothing.
  Assert-That ($seen.hosts -contains ([Uri]$NetLogPage).Host) "the log saw the page of the app, it has: $($seen.hosts -join ', ')"
  Assert-That (@($seen.outside).Count -eq 0) "the browser tried to reach: $($seen.outside -join ', ')"
  Pass "the browser tried to reach only $($seen.hosts -join ', '), and probed the route to: $($seen.probes -join ', ')"
}
