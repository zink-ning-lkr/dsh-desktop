# 图标管线② 把母版重采样为精确尺寸的多档 PNG
# 第二步:把母版重采样为精确尺寸的成品
#   icon-src/<16..256>.png  黑鲸透明底(应用图标,供 gen-icon.js 组装 ico)
#   icon.png (256)          窗口图标(同黑鲸)
#   whale-white.png (256)   白鲸透明底(深色界面内用)
#   whale-black.png (256)   黑鲸透明底
param([string]$AssetsDir = "")

$ErrorActionPreference = 'Stop'
if (-not $AssetsDir) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $AssetsDir = (Resolve-Path (Join-Path $scriptDir '..\assets')).Path
}
Add-Type -AssemblyName System.Drawing

$src = Join-Path $AssetsDir 'icon-src'
$sizes = @(16, 24, 32, 48, 64, 128, 256)

function Resize-To([string]$inFile, [int]$size, [string]$outFile) {
  $srcImg = [System.Drawing.Image]::FromFile((Resolve-Path $inFile))
  try {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($srcImg, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
    $g.Dispose()
    $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally { $srcImg.Dispose() }
}

foreach ($s in $sizes) {
  Resize-To (Join-Path $src 'master-black.png') $s (Join-Path $src "$s.png")
}
Resize-To (Join-Path $src 'master-black.png') 256 (Join-Path $AssetsDir 'icon.png')
Resize-To (Join-Path $src 'master-white.png') 256 (Join-Path $AssetsDir 'whale-white.png')
Resize-To (Join-Path $src 'master-black.png') 256 (Join-Path $AssetsDir 'whale-black.png')

Remove-Item (Join-Path $src 'master-*.png') -Force
Write-Output "尺寸重采样完成: $($sizes -join '/')"
