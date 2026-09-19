# Regenerate desktop and MSIX assets from the shared icon source.
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
  $generatedDir = Join-Path $projectRoot ".tmp/zone-icons"
  npx tauri icon --output $generatedDir
  if ($LASTEXITCODE -ne 0) { throw "Tauri icon generation failed." }
  # Keep unused mobile assets in the ignored staging directory.
  Get-ChildItem -LiteralPath $generatedDir -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $projectRoot "src-tauri/icons")
  }

  $assetsDir = Join-Path $PSScriptRoot "Assets"
  foreach ($name in @("Square44x44Logo.png", "Square150x150Logo.png", "Square310x310Logo.png", "StoreLogo.png")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "src-tauri/icons/$name") -Destination (Join-Path $assetsDir $name)
  }

  Add-Type -AssemblyName System.Drawing
  $source = [System.Drawing.Image]::FromFile((Join-Path $projectRoot "app-icon.png"))
  try {
    foreach ($asset in @(
      @{ Name = "Wide310x150Logo.png"; Width = 310; Height = 150; IconSize = 150 },
      @{ Name = "SplashScreen.png"; Width = 620; Height = 300; IconSize = 240 }
    )) {
      $bitmap = [System.Drawing.Bitmap]::new($asset.Width, $asset.Height)
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
          $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml("#1B1A19"))
          $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
          $x = [int](($asset.Width - $asset.IconSize) / 2)
          $y = [int](($asset.Height - $asset.IconSize) / 2)
          $graphics.DrawImage($source, $x, $y, $asset.IconSize, $asset.IconSize)
        } finally { $graphics.Dispose() }
        $bitmap.Save((Join-Path $assetsDir $asset.Name), [System.Drawing.Imaging.ImageFormat]::Png)
      } finally { $bitmap.Dispose() }
    }
  } finally { $source.Dispose() }
} finally { Pop-Location }
