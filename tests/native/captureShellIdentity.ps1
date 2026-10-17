param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^com\.zone\.player\.ci\.run-[a-z0-9-]+$')]
  [string]$Identifier
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Read-IdentityKey([string]$Name) {
  $path = "Software\Classes\AppUserModelId\$Name"
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $false)
  if ($null -eq $key) { return @{ exists = $false; values = @() } }
  try {
    $values = @($key.GetValueNames() | Sort-Object | ForEach-Object {
      @{ name = $_; kind = $key.GetValueKind($_).ToString(); value = $key.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    })
    return @{ exists = $true; values = $values }
  } finally { $key.Dispose() }
}
function Read-Shortcut([string]$Name) {
  $directory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $path = Join-Path $directory $Name
  if (-not [IO.File]::Exists($path)) { return @{ exists = $false } }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($path)
  $folder = (New-Object -ComObject Shell.Application).NameSpace($directory)
  $item = $folder.ParseName($Name)
  return @{ exists = $true; sha256 = $hash; target = $shortcut.TargetPath; icon = $shortcut.IconLocation; appUserModelId = $item.ExtendedProperty('System.AppUserModel.ID') }
}
@{
  protected = @{
    app = Read-IdentityKey 'com.zone.player'
    executableAlias = Read-IdentityKey 'zone-player.exe'
    shortcut = Read-Shortcut 'Zone.lnk'
  }
  isolated = @{
    app = Read-IdentityKey $Identifier
    shortcut = Read-Shortcut "Zone-$Identifier.lnk"
  }
} | ConvertTo-Json -Depth 10 -Compress
