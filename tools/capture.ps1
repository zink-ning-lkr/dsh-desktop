# 按窗口屏幕坐标截取真实窗口画面(DSH Desktop 演示/验证用)
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File tools/capture.ps1 -BoundsFile bounds.json -OutDir .
param(
  [Parameter(Mandatory = $true)][string]$BoundsFile,
  [Parameter(Mandatory = $true)][string]$OutDir
)

Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name U -Namespace W
[W.U]::SetProcessDPIAware() | Out-Null

$j = Get-Content $BoundsFile -Raw | ConvertFrom-Json
$bmp = New-Object System.Drawing.Bitmap([int]$j.w, [int]$j.h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([int]$j.x, [int]$j.y, 0, 0, $bmp.Size)
$out = Join-Path $OutDir ("demo-" + $j.name + ".png")
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved: $out"
