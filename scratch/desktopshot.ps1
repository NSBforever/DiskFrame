# Captures the real composited desktop, including native child windows.
#
# Chromium's own Page.captureScreenshot only captures what the renderer drew.
# mpv is embedded through --wid as a genuine native window and Windows is what
# z-orders it, so a DOM screenshot cannot show whether the control bar is
# actually over the video - which is the thing that went wrong before.
#
# DPI awareness first: without it Windows reports the scaled desktop size while
# CopyFromScreen reads physical pixels, so the capture is a zoomed crop of the
# top-left corner rather than the screen.
param([Parameter(Mandatory = $true)][string]$Out)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[Dpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "$Out $((Get-Item $Out).Length) bytes  $($b.Width)x$($b.Height)"
