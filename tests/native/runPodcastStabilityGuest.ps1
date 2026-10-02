param([string]$Executable, [string]$Directory, [string]$Sampler)
$ErrorActionPreference = 'Stop'
$env:ZONE_PODCAST_STABILITY_DIR = $Directory
$app = Start-Process -FilePath $Executable -WorkingDirectory (Split-Path $Executable) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Directory 'native.stdout.log') -RedirectStandardError (Join-Path $Directory 'native.stderr.log')
@{ pid = $app.Id; executable = $Executable; startedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Directory 'process.json') -Encoding UTF8
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -RootPid {1} -ExpectedExecutable "{2}" -OutputPath "{3}"' -f $Sampler, $app.Id, $Executable, (Join-Path $Directory 'resources.jsonl')
$monitor = Start-Process powershell.exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
try { $app.WaitForExit(); $app.ExitCode | Set-Content -LiteralPath (Join-Path $Directory 'exit-code.txt') }
finally { Stop-Process -Id $monitor.Id -ErrorAction SilentlyContinue }
