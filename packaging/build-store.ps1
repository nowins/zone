# Build and retain a Store-specific installer. Unsigned builds are verification artifacts only.
param([switch]$ValidateOnly, [switch]$AllowUnsigned)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
function Get-ZoneHash([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
  finally { $hasher.Dispose(); $stream.Dispose() }
}
$root = Split-Path -Parent $PSScriptRoot
$conf = Get-Content -LiteralPath (Join-Path $root 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$missing = [System.Collections.Generic.List[string]]::new()
$publisher = $env:ZONE_PUBLISHER
if (-not $publisher) { $missing.Add('ZONE_PUBLISHER（Partner Center 发布者名称）') }
$links = @{}
foreach ($key in @('INSTALLER', 'PRIVACY', 'SUPPORT', 'DOWNLOAD')) {
  $value = [Environment]::GetEnvironmentVariable("ZONE_${key}_URL")
  $uri = $null
  if (-not $value) { $missing.Add("ZONE_${key}_URL（正式 HTTPS 地址）"); continue }
  if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.HostNameType -eq 'Unknown' -or $uri.IsLoopback) {
    throw "ZONE_${key}_URL 必须是无账户信息的公开 HTTPS 地址"
  }
  $links[$key] = $uri.AbsoluteUri
}
$artifactName = "Zone_$($conf.version)_x64-setup.exe"
if ($links.INSTALLER -and ([Uri]$links.INSTALLER).AbsolutePath -notmatch "/$([regex]::Escape($artifactName))$") {
  throw "ZONE_INSTALLER_URL 必须包含不可变的版本化文件名 $artifactName"
}
$cert = $null
if (-not $env:ZONE_CERT_THUMBPRINT) { $missing.Add('ZONE_CERT_THUMBPRINT（受信任代码签名证书）') }
else {
  $thumbprint = $env:ZONE_CERT_THUMBPRINT -replace '\s', ''
  if ($thumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw '证书指纹格式无效' }
  $cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint" -ErrorAction SilentlyContinue
  if (-not $cert) { $cert = Get-Item -LiteralPath "Cert:\LocalMachine\My\$thumbprint" -ErrorAction SilentlyContinue }
  if (-not $cert -or -not $cert.HasPrivateKey) { throw '未找到可用的签名证书及私钥' }
  if ($cert.Subject -eq $cert.Issuer) { throw '开发自签证书不能用于正式 Win32 商店包' }
  if ($cert.NotBefore -gt (Get-Date) -or $cert.NotAfter -le (Get-Date)) { throw '签名证书尚未生效或已过期' }
  if (-not ($cert.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3')) { throw '证书没有代码签名用途' }
  $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
  try { if (-not $chain.Build($cert)) { throw '签名证书链不受信任，开发自签证书不能用于正式 Win32 商店包' } }
  finally { $chain.Dispose() }
  if ($publisher -and $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -ne $publisher) { throw '发布者名称与证书主体不一致' }
}
if ($missing.Count -and -not $AllowUnsigned) { throw "发布条件尚未齐备：`n$($missing -join "`n")" }
Push-Location $root
try {
  node packaging/check-version.mjs
  if ($LASTEXITCODE -ne 0) { throw '版本校验失败' }
  if ($ValidateOnly) { Write-Host '发布配置校验完成'; return }
  npm run audit:release
  if ($LASTEXITCODE -ne 0) { throw '发布依赖安全检查失败' }
  if ($AllowUnsigned) { Write-Warning '正在构建验证包；不能将此包作为正式商店发布产物。' }
  $tempDir = Join-Path $root '.tmp/store-build'
  New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
  $overlay = @{ bundle = @{} }
  if ($publisher) { $overlay.bundle.publisher = $publisher }
  if ($cert -and -not $AllowUnsigned) {
    $overlay.bundle.windows = @{ certificateThumbprint = $thumbprint; digestAlgorithm = 'sha256'; timestampUrl = 'https://timestamp.digicert.com'; tsp = $true }
  }
  $overlayPath = Join-Path $tempDir 'signing.json'
  [IO.File]::WriteAllText($overlayPath, ($overlay | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  $previousLinks = @{}
  try {
    foreach ($key in @('PRIVACY', 'SUPPORT', 'DOWNLOAD')) {
      $name = "VITE_ZONE_${key}_URL"
      $previousLinks[$name] = [Environment]::GetEnvironmentVariable($name)
      if ($links[$key]) { [Environment]::SetEnvironmentVariable($name, $links[$key]) }
    }
    npx tauri build --config src-tauri/tauri.microsoftstore.conf.json --config $overlayPath --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw '商店安装包构建失败，未保存任何旧产物' }
  } finally { foreach ($name in $previousLinks.Keys) { [Environment]::SetEnvironmentVariable($name, $previousLinks[$name]) } }
  $installer = Join-Path $root "src-tauri/target/release/bundle/nsis/$artifactName"
  $exe = Join-Path $root 'src-tauri/target/release/zone-player.exe'
  foreach ($path in @($installer, $exe)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "缺少构建产物：$path" }
    if (-not $AllowUnsigned -and (Get-AuthenticodeSignature -LiteralPath $path).Status -ne 'Valid') { throw "构建产物签名无效：$path" }
  }
  $outDir = Join-Path $PSScriptRoot "dist/store/$($conf.version)"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $out = Join-Path $outDir $artifactName
  if (Test-Path -LiteralPath $out) {
    if ((Get-ZoneHash $out) -ne (Get-ZoneHash $installer)) { throw '已有同版本产物，禁止覆盖。请提升版本或先保存、移走本地验证包。' }
  } else { Copy-Item -LiteralPath $installer -Destination $out }
  $report = @{ version = $conf.version; installer = $artifactName; sha256 = (Get-ZoneHash $out); sizeBytes = (Get-Item -LiteralPath $out).Length; signature = (Get-AuthenticodeSignature -LiteralPath $out).Status.ToString(); releaseReady = $false; missing = @($missing); links = $links; validationOnly = [bool]$AllowUnsigned; pending = @('上传到版本化 HTTPS 地址并核对 SHA256', '隔离系统安装、升级、卸载及商店认证') }
  [IO.File]::WriteAllText((Join-Path $outDir 'release-report.json'), ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Write-Host "已保存：$out"
  Write-Host '发布报告：同目录 release-report.json；正式提交前完成其中 pending 项。'
} finally { Pop-Location }
