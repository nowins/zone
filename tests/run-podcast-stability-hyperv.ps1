param(
  [Parameter(Mandatory)][string]$VMName,
  [Parameter(Mandatory)][string]$CredentialFile,
  [Parameter(Mandatory)][string]$PreparedReport
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot
$vm = Get-VM -Name $VMName
if ($vm.Notes -notmatch 'Zone MSIX disposable test VM') { throw 'Use a dedicated disposable Zone test VM' }
if ($vm.State -notin @('Off', 'Running')) { throw 'VM must be off or running before the test' }
$startedVM = $vm.State -eq 'Off'
$prepared = Get-Content -LiteralPath (Join-Path $PreparedReport 'prepared.json') -Raw | ConvertFrom-Json
$exe = [IO.Path]::GetFullPath($prepared.executable)
if (-not $exe.StartsWith((Join-Path $repo '.tmp\podcast-stability\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Use an isolated prepared fixture' }
$credential = Import-Clixml -LiteralPath $CredentialFile
$runId = 'zone-podcast-stability-' + [Guid]::NewGuid().ToString('N')
$guest = 'C:\ZonePodcastStability\' + $runId
$output = Join-Path $PreparedReport 'hyperv'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$session = $null
$tasks = @()
try {
  if ($startedVM) { Start-VM -VM $vm | Out-Null }
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while (-not $session -and [DateTime]::UtcNow -lt $deadline) {
    try { $session = New-PSSession -VMId $vm.Id -Credential $credential -ErrorAction Stop }
    catch { Start-Sleep -Seconds 3 }
  }
  if (-not $session) { throw 'PowerShell Direct unavailable' }
  Invoke-Command -Session $session -ArgumentList $guest -ScriptBlock {
    param($root)
    if (Test-Path -LiteralPath $root) { throw 'Fresh guest directory required' }
    New-Item -ItemType Directory -Path $root | Out-Null
  }
  Copy-Item -LiteralPath $exe -Destination "$guest\zone-player.exe" -ToSession $session
  foreach ($dll in @('vcruntime140.dll', 'vcruntime140_1.dll')) {
    Copy-Item -LiteralPath (Join-Path (Split-Path $exe) $dll) -Destination "$guest\$dll" -ToSession $session
  }
  foreach ($file in @('runPodcastStabilityGuest.ps1', 'samplePodcastProcess.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "native\$file") -Destination "$guest\$file" -ToSession $session
  }
  function Start-GuestPhase([string]$phase, [string]$directory) {
    $name = "$runId-$phase"
    Invoke-Command -Session $session -ArgumentList $guest, $phase, $directory, $name -ScriptBlock {
      param($root, $phase, $directory, $name)
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
      $configuration = @{ phase = $phase; durationMs = 60000; cycles = 200; port = 19372; allowDiskFull = $phase -eq 'full-disk'; webviewDirectory = "$root\profile-$phase" } | ConvertTo-Json
      [IO.File]::WriteAllText("$directory\config.json", $configuration, [Text.UTF8Encoding]::new($false))
      # Interactive logon is required for a real WebView2 audio device.
      $user = (Get-CimInstance Win32_ComputerSystem).UserName
      if (-not $user) { throw 'Guest requires an interactive test user' }
      $arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}\runPodcastStabilityGuest.ps1" -Executable "{0}\zone-player.exe" -Directory "{1}" -Sampler "{0}\samplePodcastProcess.ps1"' -f $root, $directory
      $action = New-ScheduledTaskAction -Execute powershell.exe -Argument $arguments
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $name -Action $action -Principal $principal | Out-Null
      Start-ScheduledTask -TaskName $name
    }
    $script:tasks += $name
  }
  function Wait-GuestFile([string]$file, [int]$seconds = 120) {
    $until = [DateTime]::UtcNow.AddSeconds($seconds)
    while ([DateTime]::UtcNow -lt $until) {
      $content = Invoke-Command -Session $session -ArgumentList $file -ScriptBlock { param($file) if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file -Raw -Encoding UTF8 } }
      if ($content) { return $content | ConvertFrom-Json }
      $exited = Invoke-Command -Session $session -ArgumentList (Split-Path $file) -ScriptBlock { param($directory) Test-Path -LiteralPath "$directory\exit-code.txt" }
      if ($exited) { throw "Guest process exited without expected evidence: $file" }
      Start-Sleep -Seconds 2
    }
    throw "Guest timed out: $file"
  }
  function Collect-GuestPhase([string]$phase, [string]$directory) {
    $result = Wait-GuestFile "$directory\result.json"
    $destination = Join-Path $output $phase
    New-Item -ItemType Directory -Path $destination | Out-Null
    Copy-Item -Path "$directory\*.json*", "$directory\*.log" -Destination $destination -FromSession $session
    if (-not $result.ok) { throw "$phase failed: $($result.error)" }
    Write-Host "$phase passed; database integrity: $($result.databaseIntegrity)"
    return $result
  }
  $volume = Invoke-Command -Session $session -ArgumentList $guest -ScriptBlock {
    param($root)
    if (Test-Path 'R:\') { throw 'R: is already occupied' }
    $vhd = "$root\disposable-full-disk.vhdx"
    if (Test-Path -LiteralPath $vhd) { throw 'Fresh VHD required' }
    $before = @(Get-Disk | Select-Object -ExpandProperty UniqueId)
    $script = "$root\attach.txt"
    @("create vdisk file=`"$vhd`" maximum=64 type=expandable", "select vdisk file=`"$vhd`"", 'attach vdisk') | Set-Content -LiteralPath $script -Encoding ascii
    diskpart.exe /s $script | Out-File "$root\diskpart-attach.log"
    $disks = @(Get-Disk | Where-Object { $_.UniqueId -notin $before })
    if ($disks.Count -ne 1 -or $disks[0].Size -ne 64MB -or $disks[0].PartitionStyle -ne 'RAW') { throw 'New disposable disk identity or size mismatch' }
    $disks[0] | Initialize-Disk -PartitionStyle GPT -PassThru | New-Partition -UseMaximumSize -DriveLetter R | Format-Volume -FileSystem NTFS -NewFileSystemLabel ZoneStability -Confirm:$false | Out-Null
    Set-Content -LiteralPath 'R:\zone-stability-disposable-volume.marker' -Value $root
    icacls.exe 'R:\' /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
    @{ vhd = $vhd; diskNumber = $disks[0].Number; size = $disks[0].Size }
  }
  $volume | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'volume.json')
  Start-GuestPhase 'full-disk' 'R:\data'
  $diskResult = Collect-GuestPhase 'full-disk' 'R:\data'
  $suspendDirectory = "$guest\suspend"
  Start-GuestPhase 'suspend' $suspendDirectory
  $checkpoint = Wait-GuestFile "$suspendDirectory\checkpoint.json"
  $savedAt = [DateTime]::UtcNow
  Save-VM -VM $vm | Out-Null
  Remove-PSSession $session; $session = $null
  Write-Output 'VM saved; waiting 30 seconds beyond sleep deadline'
  Start-Sleep -Seconds 30
  Start-VM -VM $vm | Out-Null
  $session = New-PSSession -VMId $vm.Id -Credential $credential
  $suspendResult = Collect-GuestPhase 'suspend' $suspendDirectory
  Invoke-Command -Session $session -ArgumentList $guest -ScriptBlock { param($root) powercfg.exe /a | Out-File "$root\power-states.txt" }
  Copy-Item -LiteralPath "$guest\power-states.txt" -Destination $output -FromSession $session
  @{ ok = $true; vm = $VMName; guestDirectory = $guest; disk = $diskResult; suspend = $suspendResult; checkpoint = $checkpoint; savedAt = $savedAt.ToString('o'); resumedAt = [DateTime]::UtcNow.ToString('o'); boundary = 'VM save/restore; not Windows S3/S4' } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'summary.json') -Encoding utf8
} finally {
  if ($session) {
    Invoke-Command -Session $session -ArgumentList $tasks, $guest -ScriptBlock {
      param($tasks, $root)
      foreach ($task in $tasks) { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }
      Get-CimInstance Win32_Process | Where-Object ExecutablePath -EQ "$root\zone-player.exe" | ForEach-Object { taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
      if (Test-Path -LiteralPath "$root\disposable-full-disk.vhdx") {
        @("select vdisk file=`"$root\disposable-full-disk.vhdx`"", 'detach vdisk') | Set-Content -LiteralPath "$root\detach.txt" -Encoding ascii
        diskpart.exe /s "$root\detach.txt" | Out-File "$root\diskpart-detach.log"
      }
    }
    Remove-PSSession $session
  }
  if ($startedVM -and (Get-VM -Id $vm.Id).State -eq 'Running') { Stop-VM -VM $vm | Out-Null }
}
