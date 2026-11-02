# DiskFrame 1.0.0 release notes

Built from branch `release/v1.0`. The findings behind each change are in `docs/V1_AUDIT.md`.

## Fixed
- **Video playback through the built-in player path.** `<video>` on `media:` failed outright for 4K H.264 and HEVC clips, and seeking did not work. This affected:
  - safe mode;
  - any build without mpv;
  - the fallback taken when mpv fails.

  `media` is now a standard scheme, and its handler answers byte ranges. Clips now show their first frame in 8-46 ms, and a seek to 90% lands on target.
- **Files with `#` or `%` in their names** now show and play. They used to fail as broken tiles.
- **HEIC thumbnails** decode two at a time, with a separate slot for the photo you open: 12 thumbnails took 12.4 s and now take 6.4 s.
- **Opening a video** no longer waits about 325 ms for a window re-parenting step that always failed.
- **Favourites after a drive-letter change** no longer move onto a different file when the original could not move.
- **Upgrading a very old catalogue** keeps its thumbnail-failure columns. They used to disappear for the rest of that launch.
- **The globe view's earth texture** loads in packaged builds.

## Safety and reliability
- Only `http(s)` links open outside the app, and the window can no longer be navigated away from DiskFrame.
- "Open file" refuses anything that is not a catalogued media file, so it cannot launch a program.
- A crashed renderer reloads instead of leaving a blank window. A view that throws shows the error and a Reload button.
- If the pre-upgrade catalogue backup cannot be written (for example, because the disk is full), DiskFrame explains why and does not migrate.

## Packaging
- The build fails if mpv, ffmpeg, ffprobe, better-sqlite3 or sharp is missing from the package.
- The installer contains only the app. Earlier builds also shipped scratch scripts, test images and tool folders.
- sharp is upgraded to 0.35.5 for the libvips, libheif and librsvg advisories.

## Known limitations
See "Known limitations" in `docs/V1_AUDIT.md`.
