# Expand the pinned Microsoft runtime into a new MSIX staging directory.
param([string]$Destination, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configuration = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'webview2-runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$uri = $null
if ($configuration.version -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $configuration.architecture -ne 'x64' -or $configuration.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or
    -not [Uri]::TryCreate($configuration.url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https' -or $uri.Host -ne 'msedge.sf.dl.delivery.mp.microsoft.com' -or $uri.UserInfo -or $uri.Query -or
    -not $uri.AbsolutePath.EndsWith("/Microsoft.WebView2.FixedVersionRuntime.$($configuration.version).x64.cab")) {
  throw '离线 WebView2 配置必须固定版本、x64、SHA256 和微软官方 HTTPS 地址。'
}
if ($ValidateOnly) { return $configuration }
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $root '.tmp/msix-build')) + [IO.Path]::DirectorySeparatorChar
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (-not $destinationPath.StartsWith($stagingRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $destinationPath.Substring($stagingRoot.Length) -notmatch '^[a-f0-9]{32}[\\/]WebView2$' -or (Test-Path -LiteralPath $destinationPath)) {
  throw '离线运行时只能写入新建的 MSIX 临时打包目录。'
}
$cache = Join-Path $root ('.tmp/msix-webview2-cache/' + $configuration.version)
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$cab = Join-Path $cache 'runtime.cab'
if (-not (Test-Path -LiteralPath $cab)) {
  $download = Join-Path $cache ([Guid]::NewGuid().ToString('N') + '.cab')
  Invoke-WebRequest -UseBasicParsing -Uri $uri.AbsoluteUri -OutFile $download
  $cab = $download
}
$stream = [IO.File]::OpenRead($cab)
$hasher = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
finally { $hasher.Dispose(); $stream.Dispose() }
if ($hash -ne $configuration.sha256) { throw '离线 WebView2 CAB 校验失败；停止打包，不使用损坏缓存。' }
if ((Split-Path -Leaf $cab) -ne 'runtime.cab') {
  # The source and target are both inside the validated version cache.
  Move-Item -LiteralPath $cab -Destination (Join-Path $cache 'runtime.cab')
  $cab = Join-Path $cache 'runtime.cab'
}
$expanded = Join-Path $root ('.tmp/msix-webview2-expanded/' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $expanded) { throw '临时解包目录已存在，拒绝复用。' }
New-Item -ItemType Directory -Path $expanded | Out-Null
expand.exe $cab '-F:*' $expanded | Out-Null
if ($LASTEXITCODE -ne 0) { throw '离线 WebView2 解包失败。' }
$executables = @(Get-ChildItem -LiteralPath $expanded -Filter msedgewebview2.exe -File -Recurse)
if ($executables.Count -ne 1) { throw '离线 WebView2 运行时目录不唯一或缺少主程序。' }
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$signature = Get-AuthenticodeSignature -LiteralPath $executables[0].FullName
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)' -or
    [Diagnostics.FileVersionInfo]::GetVersionInfo($executables[0].FullName).ProductVersion -ne $configuration.version) {
  throw '离线 WebView2 签名、发布者或版本校验失败。'
}
$runtime = $executables[0].Directory.FullName
# Keep all runtime resources and license notices intact.
Copy-Item -LiteralPath $runtime -Destination $destinationPath -Recurse
return $configuration
