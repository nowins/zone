param([int]$RootPid, [string]$ExpectedExecutable, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
while ($true) {
  $inventory = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath)
  $root = $inventory | Where-Object ProcessId -EQ $RootPid
  if (-not $root -or $root.ExecutablePath -ne $ExpectedExecutable) { break }
  $ids = [Collections.Generic.HashSet[int]]::new()
  $ids.Add($RootPid) | Out-Null
  do {
    $added = $false
    foreach ($entry in $inventory) {
      if ($ids.Contains([int]$entry.ParentProcessId) -and $ids.Add([int]$entry.ProcessId)) { $added = $true }
    }
  } while ($added)
  $rows = @()
  foreach ($processId in $ids) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) {
      $rows += @{ pid = $process.Id; name = $process.ProcessName; privateBytes = $process.PrivateMemorySize64;
        workingSetBytes = $process.WorkingSet64; handles = $process.HandleCount; cpuSeconds = $process.TotalProcessorTime.TotalSeconds }
    }
  }
  @{ at = [DateTime]::UtcNow.ToString('o'); processes = $rows } |
    ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath $OutputPath -Encoding UTF8
  Start-Sleep -Seconds 10
}
