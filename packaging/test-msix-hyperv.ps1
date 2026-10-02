# Run package lifecycle checks only on explicitly marked disposable Windows VMs.
param(
  [string]$Config,
  [string]$BaselinePackage,
  [string]$CandidatePackage,
  [string]$Certificate,
  [switch]$Inventory,
  [switch]$Preflight
)
$ErrorActionPreference = 'Stop'
Import-Module Hyper-V -ErrorAction Stop
$root = Split-Path -Parent $PSScriptRoot
if ($Inventory) {
  Get-VM | Select-Object Name,Id,State,Generation,Notes | ConvertTo-Json -Depth 4
  return
}
foreach ($path in @($Config, $BaselinePackage, $CandidatePackage, $Certificate)) {
  if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw '缺少测试配置、旧版/新版 MSIX 或开发公钥证书；不会修改虚拟机。' }
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-PackageIdentity([string]$Path) {
  $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Path))
  try {
    if (-not $zip.GetEntry('AppxSignature.p7x')) { throw '虚拟机旁加载需要已签名的开发测试包。' }
    $entry = $zip.GetEntry('AppxManifest.xml')
    if (-not $entry) { throw 'MSIX 缺少清单。' }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { [xml]$xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
    return $xml.Package.Identity
  } finally { $zip.Dispose() }
}
$old = Read-PackageIdentity $BaselinePackage
$new = Read-PackageIdentity $CandidatePackage
if ($old.Name -ne $new.Name -or $old.Publisher -ne $new.Publisher -or $old.ProcessorArchitecture -ne 'x64' -or $new.ProcessorArchitecture -ne 'x64' -or [version]$new.Version -le [version]$old.Version) {
  throw '升级包必须同名、同发布者、同为 x64，且新版版本更高；不会修改虚拟机。'
}
$cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Certificate)))
try {
  if ($cert.Subject -ne $new.Publisher -or $cert.HasPrivateKey) { throw '仅允许传入与开发包发布者匹配的公钥 CER，不复制私钥到虚拟机。' }
} finally { $cert.Dispose() }
$configuration = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$rows = @($configuration.machines)
if ($rows.Count -ne 2 -or @($rows.os | Sort-Object -Unique).Count -ne 2 -or @($rows | Where-Object { $_.os -notin @('Windows10', 'Windows11') }).Count) { throw '测试矩阵必须包含 Windows10 与 Windows11 各一台。' }
if (@($rows.vmId | Sort-Object -Unique).Count -ne 2) { throw 'Windows 10/11 必须使用不同虚拟机。' }
$targets = @()
foreach ($row in $rows) {
  $vm = Get-VM -Id ([Guid]$row.vmId) -ErrorAction Stop
  if ($vm.Notes -ne 'Zone MSIX disposable test VM') { throw "虚拟机 $($vm.Name) 没有专用测试标记，拒绝还原。" }
  $checkpoint = Get-VMSnapshot -VM $vm | Where-Object { $_.Id -eq [Guid]$row.checkpointId }
  if (-not $checkpoint) { throw "虚拟机 $($vm.Name) 的指定干净快照不存在。" }
  $credentialPath = $row.credentialFile
  if (-not [IO.Path]::IsPathRooted($credentialPath)) { $credentialPath = Join-Path (Split-Path -Parent (Resolve-Path -LiteralPath $Config)) $credentialPath }
  $credential = Import-Clixml -LiteralPath $credentialPath
  if ($credential -isnot [Management.Automation.PSCredential]) { throw '凭据文件必须由本机当前账号通过 Get-Credential | Export-Clixml 创建。' }
  $targets += @{ vm = $vm; checkpoint = $checkpoint; credential = $credential; os = $row.os }
}
if ($Preflight) { Write-Host '两台专用测试虚拟机、快照、凭据及升级包预检通过；未修改虚拟机。'; return }
$reportDir = Join-Path $root ('.tmp/msix-hyperv/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$reports = @()
foreach ($target in $targets) {
  $session = $null
  $report = @{ os = $target.os; vmId = $target.vm.Id.ToString(); status = 'failed'; lifecycleOnly = $true }
  try {
    # All matrix members have passed preflight before the first mutation.
    Restore-VMSnapshot -VMSnapshot $target.checkpoint -Confirm:$false
    if ((Get-VM -Id $target.vm.Id).State -eq 'Off') { Start-VM -VM $target.vm | Out-Null }
    $deadline = (Get-Date).AddMinutes(5)
    do {
      try { $session = New-PSSession -VMId $target.vm.Id -Credential $target.credential -ErrorAction Stop } catch { Start-Sleep -Seconds 3 }
    } until ($session -or (Get-Date) -gt $deadline)
    if (-not $session) { throw 'PowerShell Direct 登录失败；请检查测试系统与本地测试账号。' }
    $guestRoot = Invoke-Command -Session $session -ScriptBlock {
      $directory = Join-Path $env:ProgramData ('ZoneMsixTest/' + [Guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
      # The limited desktop task must be able to write its own test report.
      $acl = Get-Acl -LiteralPath $directory
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
      Set-Acl -LiteralPath $directory -AclObject $acl
      $directory
    }
    Copy-Item -LiteralPath $BaselinePackage -Destination "$guestRoot/baseline.msix" -ToSession $session
    Copy-Item -LiteralPath $CandidatePackage -Destination "$guestRoot/candidate.msix" -ToSession $session
    Copy-Item -LiteralPath $Certificate -Destination "$guestRoot/development.cer" -ToSession $session
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'test-msix-guest.ps1') -Destination "$guestRoot/test.ps1" -ToSession $session
    $taskName = 'ZoneMsixValidation-' + [Guid]::NewGuid().ToString('N')
    Invoke-Command -Session $session -ArgumentList $guestRoot,$taskName,$target.os -ScriptBlock {
      param($directory,$name,$expectedOS)
      Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
      # Trust the public test certificate here; the lifecycle task stays unelevated.
      Import-Certificate -FilePath "$directory/development.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
      $explorer = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $identity.User.Value }
      if (-not $explorer) { throw '测试账号没有已登录桌面；请先登录专用测试账号，再保存干净快照。' }
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$directory/test.ps1`" -Directory `"$directory`" -ExpectedOS $expectedOS"
      $principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Force | Out-Null
      Start-ScheduledTask -TaskName $name
    }
    $deadline = (Get-Date).AddMinutes(15)
    do {
      Start-Sleep -Seconds 2
      $finished = Invoke-Command -Session $session -ArgumentList $guestRoot -ScriptBlock { param($directory) Test-Path -LiteralPath "$directory/result.json" }
    } until ($finished -or (Get-Date) -gt $deadline)
    if (-not $finished) { throw '测试任务超时；没有将未完成的流程记为通过。' }
    Copy-Item -LiteralPath "$guestRoot/result.json" -Destination (Join-Path $reportDir "$($target.os).json") -FromSession $session
    $guestReport = Get-Content -LiteralPath (Join-Path $reportDir "$($target.os).json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $report.result = $guestReport
    $report.status = $guestReport.status
    Invoke-Command -Session $session -ArgumentList $taskName -ScriptBlock { param($name) Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  } catch { $report.error = $_.Exception.Message }
  finally {
    if ($session) { Remove-PSSession $session }
    if ((Get-VM -Id $target.vm.Id).State -ne 'Off') { Stop-VM -VM $target.vm -TurnOff -Force }
    $reports += $report
  }
}
$matrix = @{ status = $(if (@($reports | Where-Object { $_.status -ne 'passed' }).Count) { 'failed' } else { 'passed' }); results = $reports; releaseReady = $false; limitations = @('覆盖包安装、真实桌面启动、升级数据保留与卸载；不替代应用内播放、数据库语义迁移和商店更新服务验收。') }
[IO.File]::WriteAllText((Join-Path $reportDir 'matrix.json'), ($matrix | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
Write-Host "测试报告：$reportDir/matrix.json"
if ($matrix.status -ne 'passed') { throw 'Windows 10/11 MSIX 测试矩阵未通过。' }
