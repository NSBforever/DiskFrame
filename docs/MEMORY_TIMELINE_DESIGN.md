# DiskFrame 1.4.0 Memory Timeline: architecture audit and design

Status: **approved 2026-11-18**: D1-D4 accepted as recommended (see the end).
Branch: `feat/memory-timeline-v1.4.0`. Audited at `44eeabf` on 2026-11-18.

## Progress

| Stage | State |
|---|---|
| 1 External-drive crash | Done (`44eeabf`) |
| 3 This design | Approved, D1-D4 accepted |
| 6 Timestamps: D1 local days, D4 provenance + EXIF offsets | Done (`0e89a04`, `6d578f1`) |
| 4-5 OAuth, credentials, sync, cache, Settings card | Done, verified against a local mock of Google. **Not yet run against real Google**: needs the owner's OAuth client. |
| 7 Event-to-file matching, user decisions | Done: `eventMatch.ts`, `calendarDay.ts`, `calendar-day` / `calendar-link` IPC. Busiest real day (5,386 files): 3.5 ms. |
| 8-9 Memory Timeline UI, date navigation | Done: header chips (Grid and Timeline, day grouping only), day panel with event cards, mini-timeline, Keep / Not from this event / Remove / Undo, Add to Event… from the context menu, open-in-viewer sequences. Verified in the app on generated fixtures. |

Implementation notes that differ from the plan below:
- On `410 Gone` the cache is **not** wiped first. A full resync removes what it did not see, but
  only once it completes. Wiping first lost every saved event when the resync then failed
  (seen in the app: 410 followed by 401).
- Against the loopback mock (`DF_GOOGLE_API_BASE`, loopback only) the app follows the sign-in
  redirect itself instead of opening the browser; real Google always uses the system browser.
- Matching refinements (stage 7), each making it suggest less: in the buffer the time fit falls
  from 1.0 to 0.5 (not to 0); timed events over 12 hours give context only, like all-day events;
  only files whose time is evidence (camera/recording time) are candidates or burst members, so a
  bulk copy can neither be suggested nor chain camera shots together. On the busiest real day
  5,376 of 5,386 files were such copies, and 10 were placed.
- UI (stages 8-9): "View all files" is the expanded event card - every associated file in a
  mini-timeline that opens the viewer with the event's files as its sequence - rather than a new
  library query filter; the map's "files at this place" panel set that precedent. The panel docks
  left of the date scrubber and below the viewer; Esc/arrow keys belong to the viewer while it is
  open.
- Build/runtime configuration: `DF_GOOGLE_CLIENT_ID` (and optional `DF_GOOGLE_CLIENT_SECRET`) at
  build time (release workflow reads repository secrets of the same names) or in the
  environment for development.

The figures below come from a read-only snapshot of the owner's catalogue
(206,499 indexed files, 5 volumes), not from synthetic data.

---

## 0. What the audit found that shapes the design

| Finding | Evidence | Consequence |
|---|---|---|
| Gallery days are **UTC days**. `groupKeyExpr('day')` is `substr(date, 1, 10)` over an ISO UTC string. | 15,148 of 206,499 files (7.3%) fall on a different day than their local capture day at UTC+5:30. | A calendar event on Nov 18 would sit beside the wrong day's photos. Fix this first (Stage 6). |
| **72% of dates are file modification times**, not capture times. | 148,707 rows have `date` within 2 s of `mtime`: 66k never checked (drive was offline), ~82k checked but carry no capture metadata (WhatsApp, screenshots, PNG, documents). | Matching must weigh timestamp confidence, or suggestions become noise. |
| No record of **where** a date came from. | `files` has `date`, `exif_checked`, no source column. | Add `date_source`; it can be backfilled from existing columns without reading files. |
| Photo time ignores the **EXIF offset**. | `readPhotoMeta` picks only `DateTimeOriginal`; exifr reads it as local time in the machine's current zone. | Travel photos shift by the zone difference. Read `OffsetTimeOriginal` when present. |
| Videos use QuickTime `creation_time` as UTC. | `getMovMetadata`. | Right for phones, wrong for some cameras that write local time labelled as UTC. Keep it, but rate it "medium". |
| 332 files dated 1970. | Snapshot query. | Existing data problem; excluded from matching by `isUsableCaptureDate`. |
| Renderer runs with `sandbox: false`, `webSecurity: false`, CSP with `unsafe-eval`, `connect-src https:`. | `createWindow`, `index.html`. | Tokens and Google calls must stay in the main process. Event text is untrusted and must render as text only. |
| Row ids are not stable across re-indexing or Explorer moves. | `INSERT OR REPLACE INTO files` and delete+insert in reconcile; in-app moves `UPDATE path`. | User decisions key on `(path, volume_id)` like `favourite_paths`, not on `files.id`. |

---

## 1. Existing modules to reuse

| Need | Reuse | Where |
|---|---|---|
| Local store | The single SQLite catalogue (better-sqlite3, WAL), its `CREATE TABLE IF NOT EXISTS` + additive `ALTER TABLE` migrations, and its pre-migration backup | `scanner.ts` (schema ~L229, migrations ~L358-640) |
| Per-file identity that outlives re-indexing | `favourite_paths` pattern: `(path, volume_id)` key, updated by in-app move and relink | `scanner.ts` L269, L1179-1240 |
| Settings storage | `delete_prefs` single-row table with typed getters/setters + `ipcMain.handle` pairs | `scanner.ts` L597-640, `index.ts` L1666 |
| Settings UI | `glass-panel settings-card` sections in the Settings page grid | `App.tsx` L1372-1440 |
| Capture time | `enrichExifBackfill` (resumable, idle-gated, volume-scoped), `readPhotoMeta`, `getMovMetadata`, `isUsableCaptureDate` | `scanner.ts` L1781, `photoGps.ts`, `validation.ts` |
| Background work that yields to the user | `whenIdle` gating used by the EXIF backfill and thumbnail queue | `scanner.ts`, `index.ts` |
| Paged library queries | `LibraryQuery` + pure SQL builders (`buildWhere`, `groupKeyExpr`), summary/page split | `libraryQuery.ts` |
| Filtered gallery | Add an optional filter to `LibraryQuery` (as `bbox` was for Places), so "View all files" gets grouping, ordering and paging for free | `libraryQuery.ts` |
| Timeline rendering | `timelineItems` already virtualizes `(header, preview row)` per group; events become one more item type | `App.tsx` L787 |
| Grid day headers | `PhotoGrid` sections, `HEADER_H = 52` | `PhotoGrid.tsx` |
| Viewer | `MediaViewer` opens any file row; no change needed to open associated files | `media-viewer/` |
| Opening external URLs safely | `shell.openExternal` limited to http(s) | `index.ts` L584 |
| Test-only endpoint override | Same pattern as `DF_UPDATE_FEED` for a mock Google API | `updater.ts` L62 |
| Tests | `node --test src/main/*.test.ts` over pure modules | `package.json` |

**No new framework and no new runtime dependency.** OAuth (PKCE, loopback), HTTP
(`net.fetch`), encryption (`safeStorage`) and the loopback server (`node:http`) are
all built into Electron/Node. Recurrence expansion is done by Google
(`singleEvents=true`), so no RRULE library is needed.

## 2. New modules

All main-process, each small and pure where possible, so `node --test` covers them.

| Module | Job |
|---|---|
| `googleAuth.ts` | PKCE (S256) + `state`, loopback listener on `127.0.0.1:<ephemeral>`, opens the system browser, exchanges the code, refreshes, revokes. Holds the only copy of tokens in memory. |
| `credentialStore.ts` | `safeStorage.encryptString` (DPAPI on Windows) to `userData/google-calendar.bin`. Read/write/delete. Never logs content. |
| `calendarSync.ts` | Full sync then incremental via `nextSyncToken`; `410 Gone` wipes that calendar's cache and re-syncs; paging; backoff; offline detection; timer for auto-sync. |
| `calendarStore.ts` | SQL for the calendar tables (upsert instances, delete cancelled, query by local day / range). |
| `eventNormalize.ts` (pure) | Google event JSON → row: all-day vs timed, `start.date`/`end.date` exclusive end, `dateTime` + offset → UTC ms, `recurringEventId`, `originalStartTime`, `status`. |
| `captureTime.ts` (pure) | Timestamp priority + confidence (section 7), shared by the scan, the backfill and matching. |
| `eventMatch.ts` (pure) | Candidate window SQL + scoring + session clustering + overlap resolution (section 7). |

Renderer: `CalendarSettings.tsx`, `EventStrip.tsx` (day header chips), `EventCard.tsx`
(expandable card, thumbnails, actions), `AssociationMenu` actions inside the existing
context menu.

## 3. Database changes

All additive. Old builds ignore unknown tables and columns, so downgrading to 1.3.0
keeps working. The existing pre-migration backup runs first. No index-format bump,
so **no rescan**.

```sql
-- Account state only. The token lives in google-calendar.bin, never here:
-- diskframe.db is copied into backups/, and a secret must not multiply.
CREATE TABLE IF NOT EXISTS calendar_accounts (
  id INTEGER PRIMARY KEY CHECK (id = 1),     -- one account for 1.4.0
  provider TEXT NOT NULL DEFAULT 'google',
  email TEXT,                                -- shown in Settings
  status TEXT NOT NULL,                      -- connected | expired | revoked | error
  connected_at TEXT, last_sync_at TEXT, last_error TEXT
);

-- Extensible to several calendars; 1.4.0 syncs only 'primary'.
CREATE TABLE IF NOT EXISTS calendar_calendars (
  id TEXT PRIMARY KEY,                       -- Google calendar id
  summary TEXT, time_zone TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sync_token TEXT                            -- deleted on disconnect
);

-- One row per INSTANCE (Google expands recurrences: singleEvents=true).
CREATE TABLE IF NOT EXISTS calendar_events (
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,                    -- instance id, stable across syncs
  recurring_event_id TEXT,                   -- set for instances of a series
  original_start_ms INTEGER,                 -- which occurrence a moved instance replaced
  summary TEXT, description TEXT, location TEXT,
  all_day INTEGER NOT NULL,
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,   -- UTC instants (all-day: see below)
  start_day TEXT NOT NULL, end_day TEXT NOT NULL,       -- local YYYY-MM-DD, end inclusive
  event_tz TEXT, updated TEXT,
  PRIMARY KEY (calendar_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_cal_events_days ON calendar_events (start_day, end_day);
CREATE INDEX IF NOT EXISTS idx_cal_events_range ON calendar_events (start_ms, end_ms);

-- Only USER decisions are stored. Automatic suggestions are computed on read,
-- so browsing writes nothing. Keyed like favourite_paths so a decision
-- survives re-indexing, and by Google's event id so it survives a 410 resync.
CREATE TABLE IF NOT EXISTS event_file_links (
  path TEXT NOT NULL, volume_id TEXT,
  calendar_id TEXT NOT NULL, event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('confirmed', 'rejected', 'manual')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (path, volume_id, calendar_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_links_event ON event_file_links (calendar_id, event_id);

-- Timestamp provenance on the existing table.
-- Done (D4). Scans write mtime, hence the default; NULL = unknown (legacy row).
ALTER TABLE files ADD COLUMN date_source TEXT DEFAULT 'mtime';
ALTER TABLE files ADD COLUMN date_offset_min INTEGER; -- known UTC offset, else NULL
-- No local_day column: measured unnecessary, see section 6.

-- Preferences, on the existing single-row table.
ALTER TABLE delete_prefs ADD COLUMN calendar_auto_sync INTEGER DEFAULT 1;
ALTER TABLE delete_prefs ADD COLUMN calendar_buffer_min INTEGER DEFAULT 30;
```

`date_source` backfill needs no file reads: rows whose `date` equals `mtime` get
`'mtime'`; checked rows that differ get `'exif'` (photos) or `'quicktime'` (videos).
Moves and relinks update `event_file_links` in the
same statements that already update `favourite_paths`.

**All-day events** are calendar dates, not instants. `start_day`/`end_day` hold them as
given (Google's end date is exclusive, so it's stored minus one day). `start_ms`/`end_ms`
are local midnight to midnight, recomputed if the machine's zone changes.

## 4. UI components to modify

| Component | Change |
|---|---|
| Settings (`App.tsx` settings grid) | New `CalendarSettings` card: Connect, account, status, Sync now, last sync, auto-sync switch, buffer slider, Disconnect. States: not configured in this build / disconnected / connecting / syncing / connected / offline / expired / error. |
| `PhotoGrid` day headers | Right side of the header: up to 2 compact chips `10:00 Team Meeting · 4`, then `+2`. Only for events with at least one associated or suggested file. Header height unchanged. |
| Timeline (`timelineItems`) | New `timeline-event` item between a day's header and its preview row. Collapsed: time, title, count, thumbnails. Expanded: location, full list, actions. Ended marker as a thin line in the same card. |
| Day view (group-by-day header click) | "Day context" line listing the day's events with times, including ones with no files, as quiet text, not cards. |
| `LibraryQuery` + gallery header | Optional `event` filter; header shows the event title with a clear (×) to leave it. |
| Grid / viewer context menu | Confirm / Remove from event / Add to event... / Undo. |
| `MetadataPanel` (Info) | **Done (D4).** Heading and a source line ("From the camera, taken at UTC+09:00", "File last modified - the file records no capture time"), fetched per file over `date-provenance` IPC; gallery pages keep carrying only what the grid draws. |

Nothing else is redesigned. Existing glass card, typography, spacing, icons
(lucide `CalendarDays`, `Link`, `Unlink`) and motion are reused.

## 5. Security

**OAuth (verified against Google's docs, 2026-11-18):**
- Installed-app flow: system browser + **loopback redirect** `http://127.0.0.1:<port>`
  (custom URI schemes and copy/paste OOB are no longer supported by Google).
- **PKCE S256** + random `state`. Listener binds `127.0.0.1` only, accepts one request
  on the expected path with the expected `state`, closes after it or after 5 minutes.
- Scope: **`calendar.events.owned.readonly`**, read-only events on calendars the user
  owns, which covers the primary calendar. Narrower than `calendar.readonly`. Adding
  shared calendars later means asking for `calendar.calendarlist.readonly` +
  `calendar.events.readonly` at that time (incremental authorization), not now.
  No write scope, ever.
- Google states desktop apps "are public clients and cannot keep secrets
  confidential"; `client_secret` is optional for the exchange and refresh. The client
  id is injected at build time into the **main** bundle (`DF_GOOGLE_CLIENT_ID`), never
  the renderer, never committed.

**Tokens:** refresh token encrypted with `safeStorage` (Windows DPAPI, bound to the
user account) in `google-calendar.bin`, outside `diskframe.db` and its backups. Access
token in memory only. Neither crosses IPC; the renderer sees only status strings.
Logs record status codes and event counts, never tokens, auth codes, titles or
descriptions.

**Untrusted input:** event title, description and location come from Google and can be
written by anyone who invites the user. With `webSecurity` off and a preload that can
move and delete files, an injection would be serious. They render as React text nodes
only (no `dangerouslySetInnerHTML`). Descriptions arrive as HTML and are reduced to plain
text in the main process. Links in them are not clickable in 1.4.0.

**Data leaving the machine:** only OAuth requests and `events.list` calls to Google.
Nothing about local files (names, paths, times, thumbnails, matches) is ever sent.
Matching is local SQL.

**Disconnect:** revoke at `oauth2.googleapis.com/revoke` (best effort, offline is fine),
delete `google-calendar.bin`, delete sync tokens and the account row. What happens to
cached events and the user's confirmations is decision **D2** below.

## 6. Performance risks

| Risk | Mitigation | Measure before shipping |
|---|---|---|
| Switching day grouping to local days changes the hottest query (`GROUP BY` over 100k rows). | **Done (D1), measured:** `strftime(..., 'localtime')` in the group key, no stored column. 62k-file volume, 6 alternating runs: summary 45 → 67 ms, ordered ids 76 → 108 ms, both on the library worker thread, once per query/catalogue version. A stored `local_day` column (triggers on every write + 200k-row backfill) was not worth ~30 ms. Upgrade path noted in code. | Done. |
| Event chips in day headers cost a query per visible day. | One query per visible range (`start_day <= ? AND end_day >= ?`), cached with the page cache. | Brisk-scroll frame times with 0 / 1k / 10k cached events. |
| Suggestion scoring on every render. | Computed in the main process per visible event, memoized by `(event, volume, data_version)`. | Long tasks in scroll trace. |
| Initial full sync of a large calendar. | Paged, off the main thread's critical path, `whenIdle`-gated, never blocks opening the gallery. | Sync of 10k-instance mock calendar. |
| `date_source` labels on 200k rows. | **Done (D4):** one UPDATE in the migration, no file reads. | Done. |
| Infinite recurrences produce many future instances. | Stored (cheap), pruned at query time to days that have files. | Row count on a mock calendar with daily recurring events. |

## 7. Timestamps and matching

**Capture time priority** (`captureTime.ts`), with `date_source` and a confidence:

| Source | `date_source` | Confidence |
|---|---|---|
| EXIF `DateTimeOriginal` + `OffsetTimeOriginal` | `exif-offset` | high |
| EXIF `DateTimeOriginal` without offset (interpreted in the machine's zone) | `exif` | medium-high |
| HEIC/QuickTime `creation_time` (UTC) | `quicktime` | medium-high |
| Earliest of file creation and modification time | `birthtime` or `mtime` (whichever won) | low |
| Unknown (legacy rows with no stored mtime; 36,087 in the real catalogue) | NULL | low |

The last row deviates from the brief on purpose. On Windows, copying a file
**preserves** its modification time and **resets** its creation time to the copy time,
so "creation time first" would date most copied photos by the day they were copied. The
earliest of the two is right in both the copy case and the edit case. Documents use
the filesystem date and are never suggested automatically; they can be linked by hand.

Existing photos read before D4 keep `exif` (no offset): re-reading ~60k headers off a
failing drive to find offsets is not worth it. Offsets are recorded for every new read.

**Matching** (local only, read-time, nothing written):
1. Candidates: files of the open volume with `date` in `[start − buffer, end + buffer]`
   (default buffer 30 min, setting 0-120), via the existing date index.
2. Score = time fit × source confidence. Inside the event: 1.0. In the buffer: falls
   linearly to 0 at the buffer edge. Times high 1.0, medium-high 0.85, low 0.3.
3. Sessions: files within 10 min of each other form a burst. A burst that overlaps the
   event lifts its members to the burst's best score, so a 10:25-10:40 shoot that starts
   inside a 10:00-10:30 meeting stays together.
4. Overlapping events: a file goes to the event with the best score, ties to the shorter
   event (more specific).
5. Shown as **suggested** at score ≥ 0.6; low-confidence files never reach it on time alone.
6. **All-day and multi-day all-day events** (birthdays, holidays, trips): no automatic
   file suggestions. They appear as day context only. The user can link files by hand.
   Timed multi-day events (a conference) use the same rules over their span.
7. User decisions override everything: `confirmed`/`manual` always shown, `rejected`
   never suggested again.

The UI marks suggestions (outlined) apart from confirmed links (solid). Nothing is ever
written to the files themselves.

## 8. Compatibility

- Additive schema only. No rescan, no index-format bump. 1.3.0 should still open a 1.4.0
  catalogue (it ignores unknown tables and columns); the migration test verifies this
  rather than assuming it.
- Calendar never gates the gallery: a missing client id, no network, an expired token or a
  Google outage only changes the Settings card status and hides event chips.
- Updater, map, viewer, transfers, drag and drop: untouched.
- The local-day grouping fix **moves 7.3% of files to their correct day**. That is a
  visible change existing users will notice; it goes in the release notes.
- Packaged builds without `DF_GOOGLE_CLIENT_ID` show "Calendar is not available in this
  build" instead of failing.

## 9. Testing strategy

- **Pure unit tests (`node --test`)**: `eventNormalize` (all-day exclusive end, timed with
  offsets, IST/US/EU zones, DST spring-forward and fall-back days, cancelled and moved
  instances), `captureTime` (each source, offset parsing, 1970/future rejection),
  `eventMatch` (inside/buffer/outside, sessions, overlaps, all-day, rejected links),
  PKCE/state generation, sync state machine against a fake fetch (paging, `nextSyncToken`,
  410 → wipe and full sync, 401 → refresh → retry once, revoked → `revoked` status,
  offline → keep cache).
- **Migration test** on a copy of a real catalogue: row counts, `date_source` and
  group counts per day before/after, 1.3.0 still opening it.
- **App tests on isolated profiles** (existing CDP harness): a local mock Google endpoint
  via `DF_GOOGLE_API_BASE`, like `DF_UPDATE_FEED`. Settings states, sync, chips, timeline
  cards, filtered gallery, association edits surviving a restart and a re-index.
- **Regression**: the existing suite plus scroll/viewer/map/transfer harness runs before
  and after, compared back to back.
- **Real Google**: only with the owner's own OAuth client and account, done by the owner
  or with them present. Not claimed as tested until it has been.

---

## What the owner needs to configure

1. A Google Cloud project with the **Google Calendar API** enabled.
2. OAuth consent screen: External, app name, support email, scope
   `.../auth/calendar.events.owned.readonly`.
3. An OAuth client of type **Desktop app**. Its client id goes into the build as
   `DF_GOOGLE_CLIENT_ID` (a GitHub Actions secret for release builds; a gitignored
   `.env.local` for dev). The desktop client secret is not confidential per Google, but it
   is still kept out of git.
4. Know the limits before publishing:
   - In **Testing** status, refresh tokens **expire after 7 days** (reconnect weekly), and only
     listed test users (max 100) can connect.
   - Calendar scopes count as sensitive. A published but **unverified** app shows Google's
     "unverified app" screen and is capped at **100 users for the project's lifetime**.
     Verification can take weeks to months.

## Decisions (accepted 2026-11-18, all as recommended)

- **D1. Local-day grouping fix.** Recommended: ship it in 1.4.0 (7.3% of files move to
  their correct day). Alternative: keep UTC days and only use local days for events.
- **D2. Disconnect privacy.** Recommended: disconnect deletes credentials, sync tokens and
  all cached events, but **keeps your confirmed/manual links** (they hold no Google data
  beyond an event id), so reconnecting restores them. Alternative: delete everything.
- **D3. Scope.** Recommended: `calendar.events.owned.readonly` (primary/owned only).
  Alternative: `calendar.events.readonly` now, so shared family calendars work later
  without asking again.
- **D4. Timestamp fallback.** Recommended: earliest of creation/modification time (above).
  Alternative: the brief's creation-then-modification order.
