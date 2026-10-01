#!/usr/bin/env bash
# First-use verification on a small disposable tree, through the production
# discovery and thumbnail code, with an isolated catalogue and thumbnail cache.
#
# Nothing here touches the real database, the real thumbnail cache, or any real
# drive. Two environment overrides make that possible without changing product
# code for the sake of a test:
#
#   --user-data-dir   Chromium's own switch. The app's database, thumbs/,
#                     heic_cache/ and previews/ all live under app.getPath
#                     ('userData'), so this isolates the whole catalogue.
#                     The directory is named "diskframe" so that generated
#                     thumbnails still match isGeneratedAsset()'s
#                     "diskframe\thumbs\" segment - otherwise the test would
#                     re-create the old bug where the app indexed its own
#                     thumbnails as photos.
#   USERPROFILE       os.homedir() on Windows. runScan() scans C: from the home
#                     directory rather than the volume root, so this points the
#                     production scan path at the disposable tree while the
#                     volume identity for C: stays genuinely resolved. That is
#                     the whole production path - scanUtility, batched commits,
#                     watcher attach, thumbnails, progressive UI - over a
#                     bounded folder.
#
# A small tree validates behaviour. It does NOT establish performance on a real
# 2 TB or 10 TB drive; that remains unverified until the owner authorises it.
set -u

ROOT="C:\\Users\\nagir\\AppData\\Local\\Temp\\diskframe-firstuse"
ROOT_SH="/c/Users/nagir/AppData/Local/Temp/diskframe-firstuse"
APP="/c/Users/nagir/AppData/Local/Programs/diskframe/diskframe.exe"
ELECTRON="./node_modules/electron/dist/electron.exe"
PORT=9223
PHOTOS="${PHOTOS:-300}"
VIDEOS="${VIDEOS:-12}"

echo "=== reset disposable tree ($ROOT_SH) ==="
powershell -NoProfile -Command "Get-Process diskframe -ErrorAction SilentlyContinue | Stop-Process -Force" 2>/dev/null
sleep 2
rm -rf "$ROOT_SH"
mkdir -p "$ROOT_SH/media" "$ROOT_SH/diskframe"

echo "=== build fixture ==="
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" scratch/makefixture.js "$ROOT\\media" "$PHOTOS" "$VIDEOS" || exit 1

echo "=== launch isolated app ==="
LOG="$ROOT_SH/app.log"
USERPROFILE="$ROOT" HOME="$ROOT" \
  "$APP" --user-data-dir="$ROOT\\diskframe" --remote-debugging-port=$PORT > "$LOG" 2>&1 &
APP_PID=$!

for i in $(seq 1 40); do
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then break; fi
  sleep 1
done

echo "=== confirm isolation before anything else ==="
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" scratch/cdp.js $PORT "(async()=>{const m=await window.api.getRuntimeMode();return JSON.stringify({buildCommit:m.buildCommit,userData:m.userDataPath,isDefaultUserData:m.isDefaultUserData});})()"

echo "=== first-use suite ==="
EXPR="window.__fixtureDrive='C:'; $(cat scratch/firstuse.js)"
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" scratch/cdp.js $PORT "$EXPR"

echo "=== thumbnail priority (empty the isolated thumb cache first, so generation is real work) ==="
rm -rf "$ROOT_SH/diskframe/thumbs"/*
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" scratch/cdp.js $PORT "$(cat scratch/thumbpriority.js)"

echo "=== main-process log: watcher attach, stalls, scan ==="
grep -E "watcher|main-loop-worst-stall|open-drive|scanUtility|thumb:backfill:(start|complete)" "$LOG" | tail -25

echo "=== done. app left running on port $PORT (pid $APP_PID) ==="
