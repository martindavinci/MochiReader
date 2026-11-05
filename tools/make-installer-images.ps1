# SPDX-License-Identifier: GPL-3.0-or-later
# Draws the pictures of the installer from the mascot: the column of its first and last page, and the banner of the others.
# NSIS takes only uncompressed BMP files of these sizes. Run it again if the mascot changes, and commit what it makes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$mascot = [System.Drawing.Image]::FromFile((Join-Path $root 'app\assets\mochi-256.png'))
$out = Join-Path $root 'src-tauri\installer'
New-Item -ItemType Directory -Force $out | Out-Null
# The paper of the app, in its light theme: an installer does not follow the theme.
$paper = [System.Drawing.Color]::FromArgb(0xFB, 0xFA, 0xF7)

function Save-Picture($Name, $Width, $Height, $Size, $X, $Y) {
  $picture = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $canvas = [System.Drawing.Graphics]::FromImage($picture)
  $canvas.InterpolationMode = 'HighQualityBicubic'
  $canvas.SmoothingMode = 'HighQuality'
  $canvas.PixelOffsetMode = 'HighQuality'
  $canvas.Clear($paper)
  $canvas.DrawImage($mascot, $X, $Y, $Size, $Size)
  $canvas.Dispose()
  $picture.Save((Join-Path $out $Name), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $picture.Dispose()
}

Save-Picture 'sidebar.bmp' 164 314 112 26 60
Save-Picture 'header.bmp' 150 57 45 99 6
$mascot.Dispose()
