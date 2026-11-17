## DiskFrame 1.2.1

### A cleaner video player
- **The Windows taskbar no longer appears over a full-screen video.** It came up whenever the video area was smaller than the screen, for example with Info open.
- The top of the player shows only the file name. Every control is in one bar at the bottom: play, volume and time on the left; previous, next, favourite, Info, speed, subtitles, settings (speed, audio track, subtitles), more, full screen and close on the right.
- The timeline shows the time under the pointer. Controls fade after three seconds and come back when you move the mouse.
- **F** makes the window truly full screen while the viewer is open, and closing the viewer puts the window back as it was.
- New shortcuts: **Ctrl+Left / Right** for the previous / next video, and **Shift+Left / Right** to jump 10 seconds. **Left / Right** still jump 5 seconds.

### Selecting files
- **Drag to select:** click on empty space in the gallery and drag a rectangle across photos and videos. Hold **Ctrl** to add to what is already selected; the gallery scrolls when you drag to its top or bottom edge. Click empty space to clear the selection. (Grid view.)
- The **Transfer** window now opens in the middle of the screen above everything else. The month label no longer covers its heading.
- The gallery no longer jumps a little when the first file is selected.

### Every common video format
DiskFrame now finds, previews and plays **MPG, MPEG, VOB, MTS, M2TS, TS, 3GP, 3G2, FLV, OGV and ASF**, alongside MP4, M4V, MOV, AVI, MKV, WMV and WebM. Extensions are matched in any case (`.MPG` and `.mpg` alike).

- Videos from camcorders (`.MTS`/`.M2TS`), DVDs (`.VOB`), older cameras (`.MPG`) and phones (`.3GP`) now appear in the gallery, the Videos section and on the map when they carry a location.
- `.ts` and `.mts` files are only treated as video when they really are transport streams, so folders of TypeScript code stay out of your gallery.
- **Your existing library picks them up on its own:** the first time you open each drive on this version, DiskFrame looks through it once in the background.
- A video that cannot be played now says why: damaged, missing, on a disconnected drive, or not readable by your account. A video is never hidden because its preview could not be made.

### Updates
- The update notice and **Settings → Updates** show what is new in the release before you install it.
- **Update Now** downloads the update in the background. It is checked against the release's SHA-512 checksum before it can be installed, and installs when you close DiskFrame or press **Restart and Install**. Your library, thumbnails and settings are kept.
- A failed download can be retried from Settings.

### Map and design
- Clicking a place on the map opens its photos and videos; neighbouring places no longer stack on top of each other.
- Photos taken west of Greenwich or south of the equator are placed correctly (they used to appear mirrored into the opposite hemisphere). Existing photos are corrected the next time their drive is opened.
- The map says when it is showing only one section or a search, with **Show all**.
- New glass navigation dock, two-column Settings, a single Fit / 100% toggle in the photo viewer, and the video Info panel no longer hides behind the video.

### Updating
- **From 1.1.0 or later:** DiskFrame offers this update by itself.
- **From 1.0.0 or 1.0.1:** those versions cannot update themselves. Download `diskframe-1.2.1-setup.exe` below and run it once; your library and settings are kept, and every later version arrives automatically.

Windows 10/11, 64-bit. The installer is not code-signed yet, so Windows SmartScreen may ask you to confirm the first time.
