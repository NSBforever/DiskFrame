<p align="center">
  <img src="assets/readme/banner.png" alt="DiskFrame: your drives, as a gallery. Photos and videos straight off any drive, nothing imported." width="100%">
</p>

<p align="center">
  <b><a href="#download">Download</a></b> ·
  <a href="#what-it-does">Features</a> ·
  <a href="#fast-on-big-drives">Performance</a> ·
  <a href="#how-its-built">How it's built</a> ·
  <a href="#made-by">Made by</a>
</p>

<p align="center">
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-f2f2f0?style=flat-square&logo=windows11&logoColor=white&labelColor=0a0a0c">
  <img alt="v1.0 coming soon" src="https://img.shields.io/badge/v1.0-coming%20soon-e11d2e?style=flat-square&labelColor=0a0a0c">
  <img alt="Electron 39" src="https://img.shields.io/badge/Electron-39-f2f2f0?style=flat-square&logo=electron&logoColor=9feaf9&labelColor=0a0a0c">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-f2f2f0?style=flat-square&logo=react&logoColor=61dafb&labelColor=0a0a0c">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-f2f2f0?style=flat-square&logo=typescript&logoColor=3178c6&labelColor=0a0a0c">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-NTFS%20reader-f2f2f0?style=flat-square&logo=rust&logoColor=white&labelColor=0a0a0c">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-catalogue-f2f2f0?style=flat-square&logo=sqlite&logoColor=74c0fc&labelColor=0a0a0c">
  <img alt="FFmpeg" src="https://img.shields.io/badge/FFmpeg-video-f2f2f0?style=flat-square&logo=ffmpeg&logoColor=5cb85c&labelColor=0a0a0c">
</p>

<p align="center">
  <img src="assets/readme/stats.png" alt="0.46 s from drive to first thumbnail · 67 ms scroll response · 100% read in place · 0 codec packs needed" width="100%">
</p>

> **Every phone dump I copied to a drive turned into folders of `IMG_4821.HEIC` I couldn't browse.** Windows Photos wants to import everything first, and it can't show iPhone HEIC photos or HEVC videos without a codec pack. So I built DiskFrame: plug in a drive, open it, and scroll through it like a phone gallery.

## Download

**v1.0 for Windows is in its final testing pass.** The installer will be published on the [Releases](https://github.com/NSBforever/DiskFrame/releases) page. Star or watch the repo to hear when it lands.

## What it does

| | |
|---|---|
| **💽 Open any drive** | External HDDs and SSDs (even asleep ones), SD cards, phone dumps and internal folders. Thumbnails for the screen you're looking at come first. |
| **🗓️ Timeline or grid** | Group by day, month, year or place, jump through years with the date scrubber, and resize tiles with Ctrl + scroll. |
| **📱 Phone formats, no extras** | iPhone HEIC photos and 4K HEVC video are decoded inside the app. Other formats (ProRes, MKV, AVI, WMV) fall back to a bundled mpv player. |
| **🗺️ Places** | Photos with GPS data appear on a map and a 3D globe. |
| **🔎 Search** | Fuzzy search across everything on the drive. |
| **⭐ Favourites and Trash** | Kept per drive. Trash removes a tile the moment you click, and counts, selection and the viewer follow along. |
| **🔄 Stays in sync** | DiskFrame watches the open drive, so files added, moved or deleted outside the app show up without a rescan. |
| **🎬 A viewer that feels native** | Photos and videos open from their tile as a shared-element transition, and close back into it. |

## Fast on big drives

Measured on a 40,000-file test drive on a Ryzen 7 laptop, before and after a profiling pass:

| | Before | Now |
|---|---:|---:|
| Open a drive to the first thumbnail | 6.9 s | **0.46 s** |
| Scroll input response (median) | 188 ms | **67 ms** |
| Longest main-thread stall while scrolling | 8.1 s | **87 ms** |

How it got there:
- thumbnails for the visible screen are scheduled first, and stale screens are dropped;
- catalogue reads, HEIC decoding and ffmpeg all run on worker threads;
- file-watcher events caused by DiskFrame's own reads are ignored.

## How it's built

- **Electron 39**, **React 19** and **TypeScript**, built with electron-vite. The gallery grid is virtualised with react-virtuoso.
- **SQLite** (better-sqlite3) holds the catalogue, keyed by volume and path. Reads are served from a library worker, so a drive letter that changes never mixes up two drives.
- **Thumbnails**:
  - **sharp** for photos;
  - **libheif** (WebAssembly) for HEIC, on its own worker;
  - **FFmpeg** for video frames, started from a worker thread.

  The thumbnail, transcode and HEIC caches each have a size budget.
- **Playback** goes through Chromium where it can, with a bundled **mpv** for everything else.
- An optional **Rust** module (napi-rs) reads the NTFS Master File Table directly, for very fast scans when DiskFrame runs as administrator.
- **Leaflet** and **react-globe.gl** for the places map and globe. EXIF is read with exifr.

## Status

v1.0 is being tested against real drives: an external USB disk, SD cards and phone dumps, and internal folders. Screenshots and the installer arrive with the release. Ideas and bug reports are welcome: [open an issue](https://github.com/NSBforever/DiskFrame/issues).

Third-party licences, including mpv (GPLv2+), are listed in [NOTICE](NOTICE).

## Made by

**Sai Baba Nagi Reddy (NSB)**: [LinkedIn](https://www.linkedin.com/in/sai-baba-nagi-reddy-02257836a/) · [Instagram](https://www.instagram.com/nsbforever_7/) · [GitHub](https://github.com/NSBforever)

<p align="center"><sub>Also by me: <a href="https://github.com/NSBforever/stashley-showcase"><b>Stashley</b></a>, a bookmark library that sorts itself.</sub></p>

<details>
<summary>Build from source</summary>

```bash
npm install
npm run dev        # run in development
npm run build:win  # Windows installer
```

</details>
