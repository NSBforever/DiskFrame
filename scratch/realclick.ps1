# A genuine Windows mouse click at a screen position.
#
# The control bar sits over mpv's native child window. Whether it is CLICKABLE
# there is a question about Windows hit-testing and the window's
# ignore-mouse-events flag, not about the DOM - a synthetic DOM click would
# pass even if the real pointer could never reach the button. This drives the
# actual system cursor, so what it proves is what a person would experience.
param([Parameter(Mandatory = $true)][int]$X, [Parameter(Mandatory = $true)][int]$Y)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(System.Drawing.Point p);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int max);
}
"@ -ReferencedAssemblies System.Drawing
# Who actually owns that pixel, before clicking it.
$pt = New-Object System.Drawing.Point($X, $Y)
$h = [Mouse]::WindowFromPoint($pt)
$sb = New-Object System.Text.StringBuilder 256
[Mouse]::GetClassName($h, $sb, 256) | Out-Null
Write-Output "window at ${X},${Y}: hwnd=$h class=$($sb.ToString())"

[Mouse]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 250
# A move first: the overlay only asks for mouse events while its bar is
# showing, and the bar reveals on pointer activity.
[Mouse]::mouse_event(0x0001, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 250
[Mouse]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # left down
Start-Sleep -Milliseconds 90
[Mouse]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # left up
Write-Output "clicked ${X},${Y}"
