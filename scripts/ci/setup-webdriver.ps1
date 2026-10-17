[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$directory = Join-Path $root '.tmp/ci-tools'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$runtimeKeys = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$runtimeVersions = @($runtimeKeys | ForEach-Object {
  $entry = Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue
  if ($entry.pv -match '^\d+\.\d+\.\d+\.\d+$' -and [version]$entry.pv -gt [version]'0.0.0.0') { [version]$entry.pv }
})
if (-not $runtimeVersions.Count) { throw 'Microsoft WebView2 Runtime is required; no installed runtime was found.' }
$runtime = ($runtimeVersions | Sort-Object -Descending | Select-Object -First 1).ToString()
$prefix = ($runtime.Split('.')[0..2] -join '.')
$candidates = @()
if ($env:EDGEWEBDRIVER) { $candidates += Join-Path $env:EDGEWEBDRIVER 'msedgedriver.exe' }
$installed = Get-Command msedgedriver.exe -ErrorAction SilentlyContinue
if ($installed) { $candidates += $installed.Source }
$candidates += Join-Path $directory 'msedgedriver.exe'
$driver = $null
foreach ($candidate in $candidates) {
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    $description = & $candidate --version
    if ($description -match ([regex]::Escape($prefix) + '\.\d+')) { $driver = (Resolve-Path -LiteralPath $candidate).Path; break }
  }
}
if (-not $driver) {
  $archive = Join-Path $directory 'edgedriver.zip'
  $downloaded = $false
  $versions = @($runtime)
  foreach ($attempt in 0..1) {
    if ($attempt -eq 1) {
      $major = $runtime.Split('.')[0]
      $fallback = (Invoke-RestMethod -Uri "https://msedgedriver.microsoft.com/LATEST_RELEASE_${major}_WINDOWS").Trim()
      if ($fallback -notmatch ('^' + [regex]::Escape($prefix) + '\.\d+$')) { throw "No Edge WebDriver matches WebView2 $runtime." }
      $versions += $fallback
    }
    try {
      Invoke-WebRequest -Uri "https://msedgedriver.microsoft.com/$($versions[$attempt])/edgedriver_win64.zip" -OutFile $archive
      $downloaded = $true
      break
    } catch {
      if ($attempt -eq 1) { throw }
    }
  }
  if (-not $downloaded) { throw 'Edge WebDriver download did not complete.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force
  $driver = Join-Path $directory 'msedgedriver.exe'
}
# Resolve the native module when PowerShell 5 inherits a PowerShell 7 module path.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$signature = Get-AuthenticodeSignature -LiteralPath $driver
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') {
  throw 'Edge WebDriver must have a valid Microsoft signature.'
}
$description = & $driver --version
if ($description -notmatch ([regex]::Escape($prefix) + '\.\d+')) { throw 'Edge WebDriver and WebView2 versions do not match.' }
$metadata = @{ runtime = $runtime; driver = $driver; driverVersion = $description.Trim() }
$metadata | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $directory 'webdriver.json')
if ($env:GITHUB_OUTPUT) { "driver=$driver" | Out-File -Encoding utf8 -Append -FilePath $env:GITHUB_OUTPUT }
$metadata | ConvertTo-Json
