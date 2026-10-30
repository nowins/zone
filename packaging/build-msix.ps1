# Build unsigned Store-upload packages or signed development packages for isolated testing.
param(
  [string]$Cert = '',
  [string]$CertPassword = 'password',
  [string]$PackageName = $env:ZONE_MSIX_PACKAGE_NAME,
  [string]$Publisher = $env:ZONE_MSIX_PUBLISHER,
  [string]$PublisherDisplayName = $env:ZONE_MSIX_PUBLISHER_DISPLAY_NAME,
  [switch]$ForStore,
  [switch]$ValidateOnly,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$conf = Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
[xml]$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Package.appxmanifest') -Raw -Encoding UTF8
$missing = [Collections.Generic.List[string]]::new()
if ($ForStore) {
  if (-not $PackageName) { $missing.Add('ZONE_MSIX_PACKAGE_NAME') }
  if (-not $Publisher) { $missing.Add('ZONE_MSIX_PUBLISHER') }
  if (-not $PublisherDisplayName) { $missing.Add('ZONE_MSIX_PUBLISHER_DISPLAY_NAME') }
  if ($Cert) { throw '商店 MSIX 由微软签名；不要传入本机开发证书。' }
  if ($SkipBuild) { throw '商店 MSIX 必须完整构建，不能使用 SkipBuild。' }
} elseif (-not $PackageName -and -not $Publisher -and -not $PublisherDisplayName) {
  $PackageName = 'ZonePlayer.Validation'
  $Publisher = 'CN=Zone MSIX Validation'
  $PublisherDisplayName = 'Zone 本地测试'
}
if (-not $ForStore -and (-not $PackageName -or -not $Publisher -or -not $PublisherDisplayName)) {
  throw '自定义 MSIX 标识时必须同时指定 PackageName、Publisher 和 PublisherDisplayName。'
}
$links = @{}
foreach ($key in @('PRIVACY', 'SUPPORT', 'DOWNLOAD', 'WEBSITE')) {
  $value = [Environment]::GetEnvironmentVariable('ZONE_' + $key + '_URL')
  if (-not $value) {
    if ($ForStore -and $key -in @('PRIVACY', 'SUPPORT')) { $missing.Add("ZONE_$($key)_URL") }
    continue
  }
  $uri = $null
  if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.IsLoopback -or $uri.HostNameType -eq 'Unknown') {
    throw "ZONE_$($key)_URL 必须是无账户信息的公开 HTTPS 地址。"
  }
  $links[$key] = $uri.AbsoluteUri
}
if ($missing.Count) { throw "商店 MSIX 配置尚未齐备：" + [Environment]::NewLine + ($missing -join [Environment]::NewLine) }
if ($PackageName -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$') { throw 'MSIX PackageName 格式无效。' }
try { $dn = [Security.Cryptography.X509Certificates.X500DistinguishedName]::new($Publisher) }
catch { throw 'MSIX Publisher 必须是 Partner Center 提供的 X.500 发布者标识。' }
if ($Publisher -notmatch '(^|,\s*)CN=') { throw 'MSIX Publisher 必须包含 CN。' }
if ($ForStore -and ($PackageName -in @('ZonePlayer', 'ZonePlayer.Validation') -or $Publisher -in @('CN=Zone Project', 'CN=Zone MSIX Validation'))) {
  throw '商店 MSIX 不能使用占位或本地测试标识；请复制 Partner Center 产品标识。'
}
$parts = $conf.version.Split('.')
if ($parts.Count -ne 3 -or @($parts | Where-Object { $_ -notmatch '^\d+$' -or [decimal]$_ -gt 65535 }).Count) { throw 'MSIX 版本必须为三段 0–65535 整数。' }
if ($ForStore -and [int]$parts[0] -eq 0) { throw '商店 MSIX 版本第一段必须非零。' }
$msixVersion = "$($conf.version).0"
Push-Location $root
try {
  node packaging/check-version.mjs
  if ($LASTEXITCODE -ne 0) { throw '版本校验失败。' }
  & (Join-Path $PSScriptRoot 'prepare-msix-runtime.ps1') -ValidateOnly | Out-Null
  if ($ValidateOnly) { Write-Host "MSIX 配置校验完成：$PackageName / $msixVersion"; return }
  if (-not (Get-Command winapp -ErrorAction SilentlyContinue)) { throw '未找到 winapp CLI。请安装 Microsoft.WinAppCLI（0.6 或更新版）。' }
  if ($ForStore) {
    npm run audit:release
    if ($LASTEXITCODE -ne 0) { throw '发布依赖安全检查失败。' }
  }
  if (-not $SkipBuild) {
    $previousLinks = @{}
    try {
      foreach ($key in $links.Keys) {
        $name = "VITE_ZONE_$($key)_URL"
        $previousLinks[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $links[$key])
      }
      npx tauri build --no-bundle
      if ($LASTEXITCODE -ne 0) { throw 'release 构建失败，停止打包，不能复用旧 exe。' }
    } finally { foreach ($name in $previousLinks.Keys) { [Environment]::SetEnvironmentVariable($name, $previousLinks[$name]) } }
  }
  $exe = Join-Path $root 'src-tauri/target/release/zone-player.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw '缺少 release exe。' }
  if ([Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion -ne $conf.version) { throw 'release exe 版本与配置不符，不能复用旧 exe。' }
  $runId = [Guid]::NewGuid().ToString('N')
  $staging = Join-Path $root ".tmp/msix-build/$runId"
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  Copy-Item -LiteralPath $exe -Destination (Join-Path $staging 'zone-player.exe')
  node (Join-Path $root 'scripts/check-whisper.mjs')
  if ($LASTEXITCODE -ne 0) { throw '本地 CPU 引擎未通过校验，停止打包。' }
  Copy-Item -LiteralPath (Join-Path $root 'src-tauri/binaries/whisper') -Destination (Join-Path $staging 'whisper') -Recurse
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'THIRD_PARTY_NOTICES.txt') -Destination $staging
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Assets') -Destination $staging -Recurse
  $runtime = & (Join-Path $PSScriptRoot 'prepare-msix-runtime.ps1') -Destination (Join-Path $staging 'WebView2')
  $manifest.Package.Identity.SetAttribute('Name', $PackageName)
  $manifest.Package.Identity.SetAttribute('Publisher', $Publisher)
  $manifest.Package.Identity.SetAttribute('Version', $msixVersion)
  $manifest.Package.Properties.PublisherDisplayName = $PublisherDisplayName
  $stagingManifest = Join-Path $staging 'Package.appxmanifest'
  $manifest.Save($stagingManifest)
  $mode = if ($ForStore) { 'store' } else { 'development' }
  $outDir = Join-Path $PSScriptRoot "dist/msix/$mode/$msixVersion/$runId"
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  $out = Join-Path $outDir "Zone_$($msixVersion)_x64.msix"
  $arguments = @('package', $staging, '--manifest', $stagingManifest, '--skip-pri', '--output', $out)
  if (-not $ForStore) {
    if (-not $Cert) {
      $certDir = Join-Path $root '.tmp/msix-certificates'
      New-Item -ItemType Directory -Path $certDir -Force | Out-Null
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $certId = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Publisher))).Replace('-', '').Substring(0, 16) }
      finally { $sha.Dispose() }
      $Cert = Join-Path $certDir "$certId.pfx"
      if (-not (Test-Path -LiteralPath $Cert)) {
        winapp cert generate --publisher $Publisher --output $Cert --password $CertPassword --export-cer
        if ($LASTEXITCODE -ne 0) { throw '开发证书生成失败。' }
      }
    }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new([IO.File]::ReadAllBytes($Cert), $CertPassword)
    try {
      if (-not $certificate.HasPrivateKey -or $certificate.Subject -ne $dn.Name -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) { throw '开发证书私钥、有效期或发布者与清单不符。' }
      [IO.File]::WriteAllBytes((Join-Path $outDir 'development.cer'), $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    } finally { $certificate.Dispose() }
    $arguments += @('--cert', $Cert, '--cert-password', $CertPassword)
  }
  winapp @arguments
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $out)) { throw 'MSIX 打包失败。' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($out)
  try {
    $signed = $null -ne $zip.GetEntry('AppxSignature.p7x')
    if (($ForStore -and $signed) -or (-not $ForStore -and -not $signed)) { throw 'MSIX 签名模式与构建用途不符。' }
    foreach ($file in @('AppxManifest.xml', 'zone-player.exe', 'THIRD_PARTY_NOTICES.txt', 'WebView2/msedgewebview2.exe', 'whisper/zone-whisper.exe', 'whisper/engine.json', 'whisper/LICENSE-whisper.txt')) { if (-not $zip.GetEntry($file)) { throw "MSIX 缺少文件：$file" } }
  } finally { $zip.Dispose() }
  $stream = [IO.File]::OpenRead($out); $hasher = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
  finally { $hasher.Dispose(); $stream.Dispose() }
  $report = @{ version = $conf.version; packageVersion = $msixVersion; packageName = $PackageName; publisher = $Publisher; publisherDisplayName = $PublisherDisplayName; package = (Split-Path -Leaf $out); sha256 = $hash; sizeBytes = (Get-Item -LiteralPath $out).Length; signed = $signed; validationOnly = -not [bool]$ForStore; releaseReady = $false; links = $links; webview2 = @{ mode = 'Evergreen preferred, bundled fixed fallback'; version = $runtime.version; source = $runtime.url; cabSha256 = $runtime.sha256 }; pending = @('本次产物的 Windows 10/11 干净系统安装、启动、升级与卸载', 'Partner Center 标识、商店认证与发布') }
  [IO.File]::WriteAllText((Join-Path $outDir 'release-report.json'), ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Write-Host "MSIX 已保存：$out"
  if ($ForStore) { Write-Host '此包供商店上传，由微软签名；不能直接旁加载。' }
  else { Write-Host '开发包仅供隔离系统测试；只在测试虚拟机信任同目录 development.cer。' }
} finally { Pop-Location }
