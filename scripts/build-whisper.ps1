param([switch]$DownloadSource, [string]$Archive)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pin = Get-Content -Raw -LiteralPath (Join-Path $root 'packaging/whisper-source.json') | ConvertFrom-Json
$work = Join-Path $root ('.tmp/whisper-build/' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $work | Out-Null
if (-not $Archive) { $Archive = Join-Path $work 'source.zip' }
if ($DownloadSource) {
  if (Test-Path -LiteralPath $Archive) { throw '源码压缩包已存在；请指定新路径或直接使用现有包。' }
  Invoke-WebRequest -Uri $pin.url -OutFile $Archive
}
if (-not (Test-Path -LiteralPath $Archive)) { throw '缺少固定版本源码。显式使用 -DownloadSource 下载，或用 -Archive 指定源码压缩包。' }
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw 'whisper.cpp 源码 SHA-256 不匹配。' }
$source = Join-Path $work "source/whisper.cpp-$($pin.version)"
if (-not (Test-Path -LiteralPath $source)) { Expand-Archive -LiteralPath $Archive -DestinationPath (Join-Path $work 'source') }
$cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cmake) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  $vs = & $vswhere -latest -products '*' -property installationPath
  $cmake = Join-Path $vs 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
}
if (-not (Test-Path -LiteralPath $cmake)) { throw '需要已安装的 Visual Studio C++ 工具链和 CMake；脚本不会安装软件。' }
$build = Join-Path $work 'build'
& $cmake -S (Join-Path $root 'native/whisper') -B $build -A x64 "-DWHISPER_SOURCE=$source"
if ($LASTEXITCODE -ne 0) { throw 'whisper.cpp 配置失败。' }
& $cmake --build $build --config Release --target zone-whisper --parallel 4
if ($LASTEXITCODE -ne 0) { throw 'whisper.cpp 构建失败。' }
$destination = Join-Path $root 'src-tauri/binaries/whisper'
New-Item -ItemType Directory -Force $destination | Out-Null
$exe = Join-Path $destination 'zone-whisper.exe'
Copy-Item -LiteralPath (Join-Path $build 'Release/zone-whisper.exe') -Destination $exe
Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination (Join-Path $destination 'LICENSE-whisper.txt')
@{version=$pin.version;commit=$pin.commit;sourceSha256=$pin.sha256;sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();protocol=1;cpu='x64 baseline; GPU disabled; static runtime'} | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $destination 'engine.json')
Write-Output "已构建 CPU 引擎：$exe"
