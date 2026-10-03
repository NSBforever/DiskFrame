# Moves the DiskFrame window fully on screen, so a desktop capture can show the
# whole player including the bottom control bar.
param([int]$X = 0, [int]$Y = 0, [int]$W = 1280, [int]$H = 860)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$p = Get-Process diskframe, electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'no window'; exit 1 }
[Win]::SetWindowPos($p.MainWindowHandle, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0040) | Out-Null
[Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Write-Output "moved $($p.ProcessName) ($($p.Id)) to ${X},${Y} ${W}x${H}"
