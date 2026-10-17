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
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
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
  $outerWidth = [int]($Width * $scale + $frameWidth)
  $outerHeight = [int]($Height * $scale + $frameHeight)
  $desktopOverflow = $outerWidth -gt [ZoneBaselineWindow]::GetSystemMetrics(0) -or $outerHeight -gt [ZoneBaselineWindow]::GetSystemMetrics(1)
  if (-not [ZoneBaselineWindow]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $outerWidth, $outerHeight, 0x14)) { throw 'Cannot resize owned window' }
  if (-not [ZoneBaselineWindow]::GetClientRect($handle, [ref]$client)) { throw 'Cannot confirm owned client bounds' }
  $override = $false
  if ($desktopOverflow -and (($client.Right - $client.Left) -ne [int]($Width * $scale) -or ($client.Bottom - $client.Top) -ne [int]($Height * $scale))) {
    # Avoid the desktop's default maximum tracking size for this owned off-screen capture only.
    if (-not [ZoneBaselineWindow]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, $outerWidth, $outerHeight, 0x414)) { throw 'Cannot preserve requested off-screen client bounds' }
    $override = $true
  }
  @{ requestedClient = @{ width = $Width; height = $Height }; dpi = [int]($scale * 96); pid = $RootPid; desktopOverflow = $desktopOverflow; desktopTrackingOverride = $override } | ConvertTo-Json -Depth 4 -Compress
} finally { if ($previous -ne [IntPtr]::Zero) { [ZoneBaselineWindow]::SetThreadDpiAwarenessContext($previous) | Out-Null } }
