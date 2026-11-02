# DiskFrame

Browse photos and videos straight off your drives (internal disks, USB drives, SD cards, phone dumps) without importing them into a library. DiskFrame indexes what is on a drive, generates thumbnails, and plays videos in place. It never copies, converts or moves your files.

Windows only.

## Install

Run `dist\diskframe-<version>-setup.exe` and follow the installer. You can choose the install folder. A portable build, `dist\diskframe <version>.exe`, runs without installing.

Your catalogue, thumbnails and settings live in `%APPDATA%\diskframe`. Uninstalling or upgrading does not remove that folder. Before any schema change, DiskFrame writes a copy of the catalogue to `%APPDATA%\diskframe\backups`.

## Using it

1. Pick a drive. Opening a drive only reads its existing index. It never starts a scan on its own.
2. On a drive that has not been indexed yet, choose **Scan now**. On `C:`, DiskFrame scans your user folder.
3. **Check for changes** re-reads the drive. A drive that is open is also watched for changes as they happen.

To diagnose a problem, start DiskFrame with `--safe-mode`. Safe mode turns subsystems off, logs to a file and never deletes anything. `--safe-allow=scan,thumbnails,...` turns individual subsystems back on.

## Develop

```bash
npm install
npm run dev
```

Checks:

```bash
npm test
npm run typecheck
npm run lint
```

## Build

```bash
npm run build:win
```

The build needs `resources\bin\win\mpv.exe`. mpv is about 117 MB and is not in git. Take it from an mpv Windows build (the one shipped in 1.0 is mpv v0.41.0, from https://mpv.io/installation/) or from an existing install at `%LOCALAPPDATA%\Programs\diskframe\resources\app.asar.unpacked\resources\bin\win\mpv.exe`.

`scripts/verify-pack.cjs` fails the build if mpv, ffmpeg, ffprobe, better-sqlite3 or sharp's native binding is missing from the packaged app.

Output goes to `dist\`: the NSIS installer, a portable exe, and `win-unpacked\`.
