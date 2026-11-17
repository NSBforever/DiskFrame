## DiskFrame 1.3.0

Everything since 1.1.0. Versions 1.2.1 and 1.2.2 were prepared but never published, so their changes arrive here.

### Smoother everywhere
- **Gallery scrolling no longer flickers.** Thumbnails you scroll past and back to stay on screen instead of blinking blank while they reload.
- **The map zooms smoothly** with the mouse wheel in small steps instead of jumping a whole level per notch. Pins stay put instead of being rebuilt after every zoom or pan.
- **Opening a video shows only the DiskFrame player.** An older player interface used to flash for a moment first.
- **Video controls come back when you move the mouse**, and the **Info** button opens every time. Before, after the controls first faded, they could not be clicked again until you reopened the video.

### Video player
- The top shows only the file name. Every control is in one bar at the bottom: play, volume and time on the left; previous, next, favourite, Info, speed, subtitles, settings (speed, audio track, subtitles), more, full screen and close on the right. The controls fade when the mouse rests.
- **The Windows taskbar no longer appears over a full-screen video**, including with Info open.
- **F** makes the window truly full screen while the viewer is open. Closing the viewer puts the window back as it was.
- New shortcuts: **Ctrl+Left / Right** for the previous / next video, and **Shift+Left / Right** to jump 10 seconds. **Left / Right** still jump 5 seconds.

### Selecting and moving files
- **Drag to select:** click empty space in the gallery and drag a rectangle across photos and videos. Hold **Ctrl** to add to the selection. The gallery scrolls when you drag to its edge, and clicking empty space clears the selection.
- **Drag files out** to Explorer or another app: the drag shows the file's own thumbnail, with a count when you drag several.
- **Drop files or folders from Explorer** onto DiskFrame to add them to your library. DiskFrame says how many were added, how many were already there and which were not supported; nothing is ever added twice.
- The **Transfer** window opens centred above everything. The month label no longer covers it.

### Every common video format
DiskFrame finds, previews and plays **MPG, MPEG, VOB, MTS, M2TS, TS, 3GP, 3G2, FLV, OGV and ASF**, alongside MP4, M4V, MOV, AVI, MKV, WMV and WebM, in any letter case. `.ts` and `.mts` count as video only when they really are video streams, so TypeScript code folders stay out. Your existing library picks the new formats up by itself: the first time you open each drive, DiskFrame looks through it once in the background. A video that cannot be played says why, and is never hidden because its preview failed.

### Map
- Clicking a place opens its photos and videos. Photos taken west of Greenwich or south of the equator are placed correctly. The map says when it is filtered, with **Show all**.

### Updates
- The update notice and **Settings → Updates** show what is new before you install. **Update Now** downloads in the background. Every download is checked against the release's SHA-512 checksum before it can be installed; a broken or interrupted download is discarded and can be retried from Settings. Your library, thumbnails, favourites and settings are kept.

### Updating
- **From 1.1.0 or later:** DiskFrame offers this update by itself.
- **From 1.0.0 or 1.0.1:** download `diskframe-1.3.0-setup.exe` below and run it once; your library and settings are kept, and later versions arrive automatically.

Windows 10/11, 64-bit. The installer is not code-signed yet, so Windows SmartScreen may show "Windows protected your PC" the first time: choose **More info → Run anyway**. The in-app update verifies the download's checksum either way.
