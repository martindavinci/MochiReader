# SPDX-License-Identifier: GPL-3.0-or-later
# What tools/measure.ps1 and tools/smoke.ps1 share: building the app, starting it, waiting for it, ending it.
# They set $AppExe, because each uses its own build.
$AppRoot = Split-Path $PSScriptRoot
$AppTarget = Join-Path $AppRoot 'src-tauri\target'
$AppProcessName = 'mochireader'
$AppDataMark = '*io.github.martindavinci.mochireader\EBWebView*'
$AppBuildJobs = '6'
$AppWaitS = 30
$AppPollMs = 100
$AppSettleMs = 2000
$AppCloseWaitMs = 5000

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AppWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long t);
  public static long Now() { long t; GetSystemTimePreciseAsFileTime(out t); return t; }
  // The main window of a process: the one with a title that is not the hidden one of the single instance plugin.
  public static IntPtr MainWindow(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) {
        var title = new StringBuilder(260); GetWindowText(h, title, 260);
        if (title.Length > 0 && !title.ToString().EndsWith("-siw")) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

function Build-App([string[]]$Flags) {
  # Cargo reports its progress on stderr, which the caller's Stop would take for a failure.
  $ErrorActionPreference = 'Continue'
  $arguments =@('build', '--manifest-path', (Join-Path $AppRoot 'src-tauri\Cargo.toml'), '-j', $AppBuildJobs) + $Flags
  & cargo @arguments 2>&1 | Write-Verbose
  if ($LASTEXITCODE) { throw "the build failed: cargo $($arguments -join ' ')" }
}

function Get-AppLeftovers {
  # Every process of the app, and every WebView2 process working on its data folder.
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' OR Name='$AppProcessName.exe'" |
    Where-Object { $_.Name -eq "$AppProcessName.exe" -or $_.CommandLine -like $AppDataMark }
}

function Assert-AppNotRunning {
  if (Get-AppLeftovers) { throw 'MochiReader is running: close it first, or the measure would talk to that copy.' }
}

function Wait-AppGone {
  $limit = (Get-Date).AddSeconds($AppWaitS)
  while (Get-AppLeftovers) {
    if ((Get-Date) -gt $limit) { throw 'the processes of the app did not end' }
    Start-Sleep -Milliseconds $AppPollMs
  }
  Start-Sleep -Milliseconds $AppSettleMs
}

function Start-App([string[]]$Arguments) {
  $start = New-Object System.Diagnostics.ProcessStartInfo $AppExe, ($Arguments -join ' ')
  $start.UseShellExecute = $false
  [System.Diagnostics.Process]::Start($start)
}

function Wait-AppWindow($Process) {
  $limit = (Get-Date).AddSeconds($AppWaitS)
  while ($true) {
    $window = [AppWindows]::MainWindow($Process.Id)
    if ($window -ne [IntPtr]::Zero -and [AppWindows]::IsWindowVisible($window)) { return $window }
    if ($Process.HasExited) { throw 'the app ended before showing its window' }
    if ((Get-Date) -gt $limit) { throw 'the window did not appear' }
    Start-Sleep -Milliseconds $AppPollMs
  }
}

function Get-AppProcessTree([int]$RootId) {
  $all = Get-CimInstance Win32_Process
  $ids = New-Object System.Collections.Generic.List[int]
  $ids.Add($RootId)
  for ($index = 0; $index -lt $ids.Count; $index++) {
    foreach ($child in $all) {
      if ($child.ParentProcessId -eq $ids[$index] -and -not $ids.Contains([int]$child.ProcessId)) { $ids.Add([int]$child.ProcessId) }
    }
  }
  foreach ($id in $ids) { Get-Process -Id $id -ErrorAction SilentlyContinue }
}

function Stop-App($Process) {
  $WM_CLOSE = 0x10
  $window = [AppWindows]::MainWindow($Process.Id)
  if ($window -ne [IntPtr]::Zero) { [void][AppWindows]::PostMessage($window, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) }
  if (-not $Process.WaitForExit($AppCloseWaitMs) -and -not $Process.HasExited) { $Process.Kill() }
  Wait-AppGone
}
