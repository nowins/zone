# Zone MSIX 打包脚本（Windows 商店路线 B / 旁加载测试）。
#
# 用法：
#   npm run package:msix                      # 完整构建并打包，自动生成开发证书签名
#   .\packaging\build-msix.ps1 -SkipBuild     # 复用已有 release exe 重新打包
#   .\packaging\build-msix.ps1 -Cert my.pfx -CertPassword ****   # 用指定证书签名
#
# 前置：winget install --id Microsoft.WinAppCli -e（winapp CLI 0.6+）
# 上架商店前：把 packaging/Package.appxmanifest 里的 Identity Name/Publisher
# 改成 Partner Center 分配的值（或用 -PackageName / -Publisher 参数覆盖）。

param(
  [string]$Cert = "",
  [string]$CertPassword = "password",
  [string]$PackageName = "",
  [string]$Publisher = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pkgDir = $PSScriptRoot
$staging = Join-Path $pkgDir ".staging"
$distDir = Join-Path $pkgDir "dist"

if (-not (Get-Command winapp -ErrorAction SilentlyContinue)) {
  throw "未找到 winapp CLI。请先安装：winget install --id Microsoft.WinAppCli -e"
}

# 1. 构建 release exe（无安装器，MSIX 直接收 exe）
if (-not $SkipBuild) {
  Push-Location $root
  try {
    node packaging/check-version.mjs
    if ($LASTEXITCODE -ne 0) { throw "版本校验失败" }
    npx tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "release 构建失败，停止打包，不能复用旧 exe" }
  } finally { Pop-Location }
}

$exe = Join-Path $root "src-tauri\target\release\zone-player.exe"
if (-not (Test-Path $exe)) { throw "未找到 $exe，请先去掉 -SkipBuild 完整构建。" }

# 2. 版本号：tauri.conf.json 的三段式转 MSIX 要求的四段式
$conf = [System.IO.File]::ReadAllText((Join-Path $root "src-tauri\tauri.conf.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$v = $conf.version.Split(".")
$patch = "0"
if ($v.Count -gt 2) { $patch = $v[2] }
$msixVersion = "$($v[0]).$($v[1]).$patch.0"

# 3. 组装 staging 目录（exe + 盖章后的清单 + Assets）
$resolvedStaging = [IO.Path]::GetFullPath($staging)
$expectedStaging = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.staging'))
if ($resolvedStaging -ne $expectedStaging -or (Test-Path -LiteralPath $staging) -and (Get-Item -LiteralPath $staging).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw "不安全的 staging 路径" }
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $resolvedStaging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item $exe (Join-Path $staging "zone-player.exe")
Copy-Item -LiteralPath (Join-Path $pkgDir "THIRD_PARTY_NOTICES.txt") -Destination (Join-Path $staging "THIRD_PARTY_NOTICES.txt")
Copy-Item -Recurse (Join-Path $pkgDir "Assets") (Join-Path $staging "Assets")

$manifestText = [System.IO.File]::ReadAllText((Join-Path $pkgDir "Package.appxmanifest"), [System.Text.Encoding]::UTF8)
# 只在 <Identity> 标签内盖章，避免误伤 XML 声明、TargetDeviceFamily 与 Capability
$identity = [regex]::Match($manifestText, '<Identity[^>]*>')
$newIdentity = $identity.Value -replace 'Version="[0-9.]+"', "Version=`"$msixVersion`""
if ($PackageName) {
  $newIdentity = $newIdentity -replace 'Name="[^"]+"', "Name=`"$PackageName`""
}
if ($Publisher) {
  $newIdentity = $newIdentity -replace 'Publisher="[^"]+"', "Publisher=`"$Publisher`""
}
$manifestText = $manifestText.Replace($identity.Value, $newIdentity)
$stagingManifest = Join-Path $staging "Package.appxmanifest"
[System.IO.File]::WriteAllText($stagingManifest, $manifestText, (New-Object System.Text.UTF8Encoding($false)))

$publisherDn = ([regex]::Match($manifestText, 'Publisher="([^"]+)"')).Groups[1].Value
if (-not $publisherDn) { throw "清单中未找到 Identity Publisher。" }

# 4. 签名证书：默认按清单 Publisher 生成/复用开发证书
if (-not $Cert) {
  $Cert = Join-Path $pkgDir "devcert.pfx"
  if (-not (Test-Path $Cert)) {
    winapp cert generate --publisher $publisherDn --output $Cert --password $CertPassword --export-cer
    if ($LASTEXITCODE -ne 0) { throw "winapp cert generate 失败" }
    Write-Host "已生成开发证书 $Cert（默认密码 password，仅用于本机测试）"
    Write-Host "旁加载安装前需信任证书（管理员）：winapp cert install `"$Cert`""
  }
}

# 5. 打包
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$out = Join-Path $distDir "Zone_${msixVersion}_x64.msix"
winapp package $staging --manifest $stagingManifest --cert $Cert --cert-password $CertPassword --skip-pri --output $out
if ($LASTEXITCODE -ne 0) { throw "winapp package 失败" }

Write-Host ""
Write-Host "MSIX 已生成：$out"
Write-Host "本机旁加载：Add-AppxPackage `"$out`"（需先信任签名证书）"

