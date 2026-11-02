# DiskFrame V1.0 audit

Date: 2026-11-03. Branch: `release/v1.0`, cut from `master` at `1e2f569`.

Product scope comes from `docs/designs/diskframe-finished-personal-build.md` (`/office-hours`, 2026-10-25). DiskFrame is a personal Windows tool with three jobs: browse big drives fast, view photos and play videos, and find things.

## How this was established

- **Baseline on the tree as found:** typecheck passed. Tests: 244 of 245 passed. Lint: 305 errors and 7,908 prettier warnings in `src`.
- **Video path:** measured with a minimal Electron 39.8.3 harness that registers the `media:` scheme with the same privileges and the same handler code as `src/main/index.ts`. It fetched real files from the owner's Downloads (copied into a scratch fixture):

  | File | Format |
  |---|---|
  | `0909.mp4` | 4K H.264 |
  | `IMG_0170.MOV` | 4K HEVC |
  | `1 audio.mp4` | audio only |
  | `clip #2 100%.mp4` | copy of `0909.mp4` with a hostile name |
  | three iPhone HEICs | photos |

- **HEIC cost:** measured with the same libheif-js and sharp calls `heicWorker.ts` makes, run in Node.
- **Everything else:** read in the source. Each finding names its file. Nothing below is inferred without reading the code, and anything not confirmed is labelled as needing verification.

Not available in this session: the USB HDD and the SD card. Only `C:` was connected, with 5.8 GB free. The perf fixture's media under `C:\dfperf` is also gone.

## Findings

Severity legend: CRITICAL / HIGH / MEDIUM / LOW / ENHANCEMENT.

### C1 - The `media:` handler cannot feed a `<video>`: native playback and seeking are broken (CRITICAL)
- **Where:** `src/main/index.ts`, `protocol.handle('media', ...)`.
- **Root cause:** it returns `net.fetch('file:///' + path)` and drops the request's `Range` header. Chromium's media pipeline needs byte-range responses (206 with `Content-Range`). With a full 200 body it errors on any file large enough to need a range read.
- **Measured:**

  | File | Result |
  |---|---|
  | `0909.mp4` | `PIPELINE_ERROR_READ: FFmpegDemuxer: data source error` |
  | `IMG_0170.MOV` | the same error |
  | `1 audio.mp4` | loads, but `seekable` is empty and seeking to 90% lands at 0 s |
  | any file, `Range: bytes=0-99` | 200 with the whole file |

  Forwarding the request headers to `net.fetch` is not enough either: the body is sliced, but the status stays 200 with no `Content-Range`, and the video still fails.
- **Impact:** every path that plays a video in Chromium:
  - safe mode, where mpv is refused and an H.264 `.mp4` is sent to `media:` as `mode: 'native'`;
  - any build without `mpv.exe` (see C2);
  - the mpv-error fallback.

  In those cases H.264 MP4s do not play at all, and other formats only play through the ffmpeg re-encode stream, which cannot seek.
- **Fix:** serve `media:` files with a real range implementation: parse `Range`, answer 206 with `Content-Range`, `Accept-Ranges` and `Content-Length`, stream the slice with `fs.createReadStream`, and answer 416 when the range is out of bounds. The parser goes in its own module with unit tests. The path-safety and volume-identity checks stay in front, unchanged.
- **Regression risk:** images also go through `media:`. Without a `Range` header the response must stay a plain 200.
- **Verify:** the harness again: all videos reach `loadeddata`, seeking to 90% lands near the target, and the HEIC/JPEG fetch is unchanged.

### C2 - A build can ship without mpv, silently (CRITICAL for release)
- **Where:** `resources/bin/win/` is empty in this checkout. `mpv.exe` is gitignored. `electron-builder.yml` has no check.
- **Root cause:** the binary only ever existed on disk. The installed build at `%LOCALAPPDATA%\Programs\diskframe` has it; the repo does not.
- **Impact:** a `npm run build:win` from this checkout packages no mpv. Every video then falls to C1's broken path.
- **Fix:**
  - restore `mpv.exe` from the installed build (gitignored, so local only);
  - make `build:win` fail when `mpv.exe` or the ffmpeg/ffprobe binaries are missing from the packaged output (an electron-builder `afterPack` check);
  - document where mpv comes from.
- **Verify:** the build fails with the binary moved away and passes with it present. The packaged `app.asar.unpacked` contains all three.

### H1 - Files whose names contain `#` or `%` cannot be shown or played (HIGH)
- **Where:** about ten hand-built `'media:///' + path` URLs: `ImageLoader.tsx`, `MediaViewer.tsx`, `PhotoGrid.tsx`, `MapPage.tsx`, `GlobeView.tsx`, `MetadataPanel.tsx`, `App.tsx`, and `index.ts` (`get-video-play-info`).
- **Root cause:** the path is not URL-encoded:
  - `#` starts a fragment, so the handler sees a truncated path;
  - `%` makes `decodeURIComponent` throw, so the request gets a 400.

  The handler's own `'file:///' + path` has the same problem.
- **Measured:** `clip #2 100%.mp4`: `Failed to fetch`.
- **Fix:** one renderer helper that encodes each path segment, used by every builder. Main uses the same encoding and `pathToFileURL`.
- **Verify:** the harness file `clip #2 100%.mp4` plays.

### H2 - HEIC thumbnails decode strictly one at a time (HIGH, performance)
- **Where:** `src/main/heicPool.ts`, `WORKERS = 1`.
- **Measured:** 1.4 s, 2.2 s and 4.0 s per iPhone HEIC (2231x3977 to 4284x5712), almost all of it in libheif's wasm decode.
- **Effect:** the thumbnail pump runs two generation slots, but both queue on the single HEIC worker. A screen of 30 HEIC tiles therefore takes roughly 30 x 2.5 s, about 75 s, on an 8-core CPU.
- **The doc's preferred fix is unavailable:** two of the three files carry a `thmb` reference, but libheif-js's binding reports 0 thumbnails for the primary handle. The embedded thumbnail cannot be reached without patching or replacing libheif-js.
- **Fix:** let thumbnails use two workers (matching the pump's two slots), and keep a third slot for the viewer's urgent full-size decode, so the photo the user opened never waits behind thumbnails. Memory cost: about 340 MB RSS per busy worker, and idle workers already exit after 20 s.
- **Verify:** time the same batch of decodes through 1 worker and through 2.

### M1 - Any URL a page opens goes to `shell.openExternal` unchecked (MEDIUM, security)
- **Where:** `src/main/index.ts`, `setWindowOpenHandler`.
- **Root cause:** `details.url` is passed through whatever its scheme: `file:`, `ms-settings:`, custom protocol handlers.
- **Mitigating:** the renderer is local, React-escaped content. Its only `target="_blank"` links are the GitHub link and Google Maps.
- **Risk:** it runs with `webSecurity: false`, so any injected content gets OS-level launch for free.
- **Fix:** open only `https:` and `http:`. Deny everything else.

### M2 - The main window can be navigated away from the app (MEDIUM, security/reliability)
- **Where:** `src/main/index.ts`. There is no `will-navigate` handler.
- **Fix:** block every navigation away from the app's own page. Allowed links still open through M1's checked path.
- **Verify:** dropping a file on the window must not replace the app (QA).

### M3 - `open-file` IPC opens any local path, executables included (MEDIUM, security)
- **Where:** `src/main/index.ts`, `ipcMain.on('open-file')`, which calls `shell.openPath`.
- **Detail:** the preload still exposes `openFile`, but the renderer never calls it.
- **Fix:** refuse anything that is not a catalogued media type, so the IPC can never launch a program.

### M4 - A legacy catalogue loses two columns when its table is rebuilt (MEDIUM, data integrity)
- **Where:** `src/main/scanner.ts`, the `path TEXT UNIQUE` rebuild into `files_new`.
- **Root cause:** `thumb_fail_count` and `thumb_fail_sig` are added just above the rebuild, but its explicit column list leaves them out.
- **Impact:** after upgrading a very old catalogue, every statement that names them throws until the next launch re-adds them. The data lost is only failure counters; no user data.
- **Fix:** add the two failure-counter columns after the rebuild. Only failure counters are affected, so nothing has to be carried across the rebuild.
- **Verify:** start the app against a catalogue that still has the old schema, then check the columns and the thumbnail pass.

### M5 - The renderer has no crash recovery (MEDIUM, reliability)
- **Where:** there is no React error boundary in `src/renderer`, and no `render-process-gone` or `unhandledRejection` handling in `src/main/index.ts`.
- **Impact:** a render exception in any component blanks the whole window with no message and no way out but restarting.
- **Fix:** add a root error boundary that shows the error with a reload button, reload the window when the renderer process dies, and log unhandled main-process rejections.

### M6 - A failed pre-migration backup crashes startup with no explanation (MEDIUM)
- **Where:** `src/main/scanner.ts`, `backupBeforeMigration`. It rethrows at module load.
- **Context:** refusing to migrate without a backup is correct. But the user sees Electron's generic main-process error. Startup with a full disk is a realistic case: C: had 5.8 GB free, and the catalogue is 206 MB.
- **Fix:** keep refusing, and show a dialog that says why (disk space, backup folder), then quit cleanly.

### M7 - Electron 39 is inside three advisory ranges (MEDIUM, decision)
- **Advisories:** `npm audit` reports three Electron advisories (GHSA-h3v5-h239-pg29 macOS-only, GHSA-997q-gvvc-jwmx `openExternal` permission attribution, GHSA-jr5w-w6x2-84p9 eMudhra certificates). They are fixed only in Electron 42.11.16 or later, a three-major jump. `extract-zip` (high) is pulled in by Electron's install script only.
- **Decision for the owner:** the upgrade moves the Chromium, Node ABI and better-sqlite3 rebuild together. It needs its own verification pass.

### L1 - Release metadata is template boilerplate (LOW, release)
- **Where:** `package.json` (`description`, `author: example.com`, `homepage`) and `electron-builder.yml` (`appId: com.electron.app`, `publish.url: https://example.com/auto-updates`, `maintainer: electronjs.org`, mac camera and microphone usage strings). `README.md` is the electron-vite template.
- **Risk:** changing `appId` changes the Windows AppUserModelID and the NSIS registry key. Done blindly, an upgrade install would not replace the old one, so it is a decision.
- **Fix:** fix the descriptive fields. Keep `appId`, so the install upgrades in place, unless the owner wants a clean break.

### L2 - Lint debt (LOW)
- **Counts:** 305 errors in `src`, mostly `explicit-function-return-type` (93), `react/prop-types` (89, which do not apply to TypeScript props) and `no-explicit-any` (66). There are also 7,908 prettier warnings.
- **Action:** not reformatted wholesale; that would bury the real diff. New and touched code adds no findings.

### L3 - Month names are stored in the system locale (LOW)
- **Where:** `scanner.ts`, `toLocaleString('default', { month: 'long' })` is written into `files.month`.
- **Impact:** a change of Windows display language mixes month names in one catalogue.
- **Action:** recorded only; not changed for V1.

### Fixed during the audit
- **`driveLetter.ts` (MEDIUM):** a favourite followed a file that could not move, because its new path was already taken by another file. It now stays with its own file. `driveLetter.test.ts` was the one failing test.

### ENHANCEMENTS (not V1 blockers)
- Reach HEIC embedded thumbnails, by patching libheif-js or using a different decoder.
- Drop `webSecurity: false`. Thumbnails would need to move from `file:` to `media:`, which needs a perf re-measure first.
- Move `src/renderer` off `unsafe-eval` in the CSP.

### Needs verification on hardware not available here
- A sleeping USB HDD and an SD card: open, scroll and play.
- HDR HEVC rendering compared with mpv on this laptop's panel.
- Upgrade-installing over the existing `%LOCALAPPDATA%\Programs\diskframe`. The installer is built and checked here; installing it is left to the owner.

## Roadmap

Ordered by dependency. Each step is a separate commit on `release/v1.0`.

1. **Critical fixes:**
   - C1: range-capable `media:` handler, with parser tests;
   - H1: encoded `media:` URLs at every builder;
   - C2: restore mpv, plus a packaging check.

   C1 and H1 share the handler, so they land together. Low risk, verified by the harness.
2. **Core function: native-first video.** Once C1 holds, the doc's premise 2 becomes possible. The viewer tries `<video>` on `media:` for codecs Chromium decodes (H.264, HEVC, VP9, AV1) and falls back to mpv otherwise. This changes playback behaviour, so it lands only after C1 is measured. Medium risk: the viewer's mpv path is intricate.
3. **Performance:** H2, parallel HEIC thumbnails with the viewer's reserved slot.
4. **Data integrity:** M4, the column rebuild; M6, the backup-failure dialog.
5. **Security and reliability:** M1, M2, M3 and M5.
6. **Testing:** unit tests for the range parser and URL encoding; the harness kept in `scratch/` as an acceptance check; full `npm test`, typecheck and build.
7. **Packaging:** L1 metadata, `build:win`, then check the installer's contents. M7 (Electron) waits for a decision.
