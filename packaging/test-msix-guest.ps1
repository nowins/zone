# Executed by an interactive scheduled task inside a disposable Windows test VM.
param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][ValidateSet('Windows10','Windows11')][string]$ExpectedOS)
$ErrorActionPreference = 'Stop'
$resolvedDirectory = [IO.Path]::GetFullPath($Directory)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $env:ProgramData 'ZoneMsixTest')) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedDirectory.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedDirectory) -notmatch '^[a-f0-9]{32}$') { throw '来宾测试只能在专用 ProgramData/ZoneMsixTest 目录运行。' }
$computer = Get-CimInstance Win32_ComputerSystem
if ($computer.Model -ne 'Virtual Machine' -or $computer.Manufacturer -notmatch '^Microsoft') { throw '来宾测试只允许在 Hyper-V 虚拟机运行，不能修改宿主机。' }
Import-Module Appx
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$result = @{ status = 'failed'; stages = @(); limitations = @('升级检查验证安装器保留既有文件；应用内数据库迁移与音频播放需额外验证。') }
function Read-Identity($Path) {
  $zip = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $reader = [IO.StreamReader]::new($zip.GetEntry('AppxManifest.xml').Open())
    try { [xml]$xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
    return $xml.Package.Identity
  } finally { $zip.Dispose() }
}
function Find-TestProcesses($Package) {
  @(Get-Process zone-player -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $Package.InstallLocation 'zone-player.exe') })
}
function Start-And-Check($Package) {
  Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\' + $Package.PackageFamilyName + '!Zone')
  $deadline = (Get-Date).AddSeconds(45)
  do {
    Start-Sleep -Seconds 1
    $processes = Find-TestProcesses $Package
  } until (@($processes | Where-Object { $_.MainWindowHandle -ne 0 }).Count -or (Get-Date) -gt $deadline)
  if (-not @($processes | Where-Object { $_.MainWindowHandle -ne 0 }).Count) { throw '应用未成功创建桌面窗口。' }
  Start-Sleep -Seconds 5
  if (-not (Find-TestProcesses $Package).Count) { throw '应用启动后退出。' }
  $dataRoot = Join-Path $env:LOCALAPPDATA ('Packages/' + $Package.PackageFamilyName)
  $databases = @(Get-ChildItem -LiteralPath $dataRoot -Filter zone.sqlite -Recurse -File -ErrorAction SilentlyContinue)
  if (-not $databases.Count) { throw '应用启动后未在包数据目录生成 zone.sqlite。' }
  # Force-stop only the test package process before installer/data assertions.
  Find-TestProcesses $Package | Stop-Process -Force
  return $databases.FullName
}
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $result.system = @{ caption = $os.Caption; build = $os.BuildNumber; architecture = $os.OSArchitecture }
  if ($os.ProductType -ne 1 -or $os.OSArchitecture -notmatch '64' -or ($ExpectedOS -eq 'Windows10' -and ([int]$os.BuildNumber -lt 17763 -or [int]$os.BuildNumber -ge 22000)) -or ($ExpectedOS -eq 'Windows11' -and [int]$os.BuildNumber -lt 22000)) { throw '测试系统不是预期的 Windows 客户端版本。' }
  $baseline = Read-Identity "$Directory/baseline.msix"
  $candidate = Read-Identity "$Directory/candidate.msix"
  if (Get-AppxPackage -Name $baseline.Name) { throw '干净快照中已存在测试包。' }
  Import-Certificate -FilePath "$Directory/development.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
  Add-AppxPackage -Path "$Directory/baseline.msix" -ForceApplicationShutdown
  $package = Get-AppxPackage -Name $baseline.Name
  if (-not $package -or $package.Version -ne [version]$baseline.Version) { throw '旧版安装结果不符。' }
  $result.stages += 'install-baseline'
  $databases = @(Start-And-Check $package)
  $result.stages += 'launch-baseline-and-create-database'
  $state = Join-Path $env:LOCALAPPDATA ('Packages/' + $package.PackageFamilyName + '/LocalState')
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  $marker = Join-Path $state 'zone-upgrade-test.txt'
  [IO.File]::WriteAllText($marker, [Guid]::NewGuid().ToString())
  $paths = @($marker) + $databases
  $hashes = @{}
  foreach ($path in $paths) { $hashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
  $media = Join-Path $env:USERPROFILE 'Music/ZoneMsixTest.wav'
  if (Test-Path -LiteralPath $media) { throw '测试媒体路径已存在，拒绝覆盖。' }
  New-Item -ItemType Directory -Path (Split-Path -Parent $media) -Force | Out-Null
  # A valid silent PCM WAV fixture; this stage checks source preservation only.
  $header = [Convert]::FromBase64String('UklGRiSZAQBXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQCZAQA=')
  [IO.File]::WriteAllBytes($media, [byte[]]($header + [byte[]]::new(104704)))
  $mediaHash = (Get-FileHash -LiteralPath $media -Algorithm SHA256).Hash
  Add-AppxPackage -Path "$Directory/candidate.msix" -ForceApplicationShutdown
  $package = Get-AppxPackage -Name $candidate.Name
  if (-not $package -or $package.Version -ne [version]$candidate.Version) { throw '新版升级结果不符。' }
  foreach ($path in $paths) { if (-not (Test-Path -LiteralPath $path) -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $hashes[$path]) { throw '升级安装改变或丢失既有应用数据。' } }
  $result.stages += 'upgrade-and-preserve-data'
  Start-And-Check $package | Out-Null
  $result.stages += 'launch-candidate'
  $appId = $package.PackageFamilyName + '!Zone'
  Remove-AppxPackage -Package $package.PackageFullName
  if ((Get-AppxPackage -Name $candidate.Name) -or (Get-StartApps | Where-Object { $_.AppID -eq $appId }) -or (Test-Path -LiteralPath $marker)) { throw '卸载后仍残留应用注册、入口或包内测试数据。' }
  if (-not (Test-Path -LiteralPath $media) -or (Get-FileHash -LiteralPath $media -Algorithm SHA256).Hash -ne $mediaHash) { throw '卸载改变或删除了原始媒体文件。' }
  $result.stages += 'uninstall-and-preserve-source-media'
  $result.status = 'passed'
} catch { $result.error = $_.Exception.Message }
finally {
  $path = Join-Path $Directory 'result.json'
  [IO.File]::WriteAllText($path, ($result | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
if ($result.status -ne 'passed') { exit 1 }
