param([Parameter(Mandatory=$true)][string]$Manifest, [Parameter(Mandatory=$true)][string]$Driver, [Parameter(Mandatory=$true)][string]$Report, [switch]$BackendOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node).Source
$Manifest = (Resolve-Path -LiteralPath $Manifest).Path
$Driver = (Resolve-Path -LiteralPath $Driver).Path
$Report = [IO.Path]::GetFullPath((Join-Path $root $Report))
if (-not $Report.StartsWith((Join-Path $root '.tmp'), [StringComparison]::OrdinalIgnoreCase)) { throw '报告必须位于本任务的 .tmp 目录。' }
New-Item -ItemType Directory -Force $Report | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ZoneIsolatedDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Startup {
    public int cb; public string reserved; public string desktop; public string title;
    public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2;
    public IntPtr reservedPtr,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
  [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,IntPtr security);
  [DllImport("user32.dll",SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string directory,ref Startup startup,out ProcessInfo process);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  public static string Quote(string value) {
    var text=new StringBuilder("\""); int slashes=0;
    foreach(char c in value){if(c=='\\'){slashes++;continue;}text.Append('\\',c=='"'?slashes*2+1:slashes);slashes=0;text.Append(c);}
    text.Append('\\',slashes*2);return text.Append('"').ToString();
  }
}
'@
$name = 'ZoneWhisper-' + [Guid]::NewGuid().ToString('N')
$desktop = [ZoneIsolatedDesktop]::CreateDesktop($name,[IntPtr]::Zero,[IntPtr]::Zero,0,0x10000000,[IntPtr]::Zero)
if ($desktop -eq [IntPtr]::Zero) { throw "无法创建独立测试桌面：$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$info = [ZoneIsolatedDesktop+ProcessInfo]::new()
$outcome = @{desktop=$name;switchedInputDesktop=$false;ok=$false;startedAt=[DateTime]::UtcNow.ToString('o')}
try {
  $startup = [ZoneIsolatedDesktop+Startup]::new()
  $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
  $startup.desktop = 'winsta0\' + $name
  $startup.flags = 1
  $startup.show = 0
  $testMode = if ($BackendOnly) { '--local-whisper-backend' } else { '--local-whisper' }
  $arguments = @($node,(Join-Path $root 'tests/run-native-artifact.mjs'),'--manifest',$Manifest,'--driver',$Driver,'--report',$Report,$testMode)
  $command = [Text.StringBuilder]::new((($arguments | ForEach-Object {[ZoneIsolatedDesktop]::Quote($_)}) -join ' '))
  if (-not [ZoneIsolatedDesktop]::CreateProcess($node,$command,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x08000000,[IntPtr]::Zero,$root,[ref]$startup,[ref]$info)) { throw "独立桌面测试启动失败：$([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $outcome.ownerPid = $info.pid
  Write-Output "测试正在独立桌面 $name 执行；不会切换用户桌面。报告：$Report"
  while ([ZoneIsolatedDesktop]::WaitForSingleObject($info.process,1000) -eq 258) {}
  $code = [uint32]0
  [void][ZoneIsolatedDesktop]::GetExitCodeProcess($info.process,[ref]$code)
  $outcome.exitCode=$code;$outcome.ok=$code -eq 0
} finally {
  if ($info.thread -ne [IntPtr]::Zero) {[void][ZoneIsolatedDesktop]::CloseHandle($info.thread)}
  if ($info.process -ne [IntPtr]::Zero) {[void][ZoneIsolatedDesktop]::CloseHandle($info.process)}
  [void][ZoneIsolatedDesktop]::CloseDesktop($desktop)
  $outcome.finishedAt=[DateTime]::UtcNow.ToString('o')
  $outcome | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Report 'desktop-result.json')
}
if (-not $outcome.ok) { throw "独立桌面验收失败，查看 $Report/result.json" }
