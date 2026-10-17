param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
  [Parameter(Mandatory = $true)][ValidatePattern('^com\.zone\.player\.ci\.run-[a-z0-9-]+$')][string]$Identifier,
  [Parameter(Mandatory = $true)][ValidateRange(920, 1600)][int]$Width,
  [Parameter(Mandatory = $true)][ValidateRange(620, 1200)][int]$Height
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$RootPid"
$executable = [IO.Path]::GetFullPath($ExpectedExecutable)
if (-not $process -or $process.ExecutablePath -ne $executable) { throw 'Refusing a window outside the exact owned executable' }
if (-not [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($executable)).Contains($Identifier)) { throw 'Missing embedded CI identity' }
$handle = (Get-Process -Id $RootPid).MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'Owned native window is unavailable' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ZoneBaselineWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
}
'@
# Change only this helper thread's coordinate interpretation, never display settings.
$previous = [ZoneBaselineWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
  [ZoneBaselineWindow]::ShowWindow($handle, 9) | Out-Null
  $client = New-Object ZoneBaselineWindow+Rect
  $outer = New-Object ZoneBaselineWindow+Rect
  if (-not [ZoneBaselineWindow]::GetClientRect($handle, [ref]$client) -or -not [ZoneBaselineWindow]::GetWindowRect($handle, [ref]$outer)) { throw 'Cannot read owned window bounds' }
  $scale = [ZoneBaselineWindow]::GetDpiForWindow($handle) / 96.0
  $frameWidth = ($outer.Right - $outer.Left) - ($client.Right - $client.Left)
  $frameHeight = ($outer.Bottom - $outer.Top) - ($client.Bottom - $client.Top)
  if (-not [ZoneBaselineWindow]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, [int]($Width * $scale + $frameWidth), [int]($Height * $scale + $frameHeight), 0x14)) { throw 'Cannot resize owned window' }
  @{ requestedClient = @{ width = $Width; height = $Height }; dpi = [int]($scale * 96); pid = $RootPid } | ConvertTo-Json -Depth 4 -Compress
} finally { if ($previous -ne [IntPtr]::Zero) { [ZoneBaselineWindow]::SetThreadDpiAwarenessContext($previous) | Out-Null } }
