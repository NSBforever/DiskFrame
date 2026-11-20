# DiskFrame - post-1.5.0 product backlog

Status: **backlog only, not approved for development.** Collected from the product owner on 2026-11-19, after
DiskFrame 1.5.0 was published as the latest stable release and the owner's installed 1.4.1 updated to it through
the normal updater. Nothing here may be implemented, pushed, merged or published without the owner's approval of a
plan for the next version. Repository visibility is out of scope.

Sections 1-9 record the owner's requirements. "Planning notes" at the end are engineering observations to review
before planning; they are not requirements.

---

## 1. Downloads, user analytics and update tracking

Goal: understand how many people download and actively use DiskFrame.

Track:
- GitHub installer downloads per release
- approximate installations
- daily active installations
- monthly active installations
- returning installations
- application version distribution
- successful updates
- popular features
- application crashes (tracked separately)

Evaluate a privacy-conscious analytics provider. Requirements:
- no mandatory DiskFrame login
- explicit analytics consent
- a random installation identifier
- a privacy control in Settings
- never transmitted: file names, paths, GPS, photos, thumbnails, face information, Calendar details
- a dashboard for the developer

Clearly distinguish raw downloads from unique installations and from active users.

## 2. Complete update history inside DiskFrame

Users must be able to understand what changed between versions. A future Update History / What's New experience
showing:
- installed version
- latest available version
- previous published versions
- release date
- release notes
- new features
- bug fixes
- update status
- download and installation progress
- What's New after a successful update

Track update adoption accurately. Verify that existing installations receive new stable releases through the
updater without manual reinstalls.

## 3. Fix video player deletion

Bug: deleting a video while it is playing. Expected:
1. The user opens a video.
2. The user clicks Delete.
3. A proper confirmation dialog appears above the video player.
4. The user can choose whether to proceed.
5. Escape closes the confirmation dialog, not the video player behind it.
6. The video is deleted, or moved to the selected destination, only after confirmation.

Investigate event propagation, modal stacking, focus handling and keyboard shortcuts. Test the complete workflow in
the actual Windows application.

## 4. Configurable deletion behaviour

Today a file can be moved to DiskFrame Trash, emptied from DiskFrame Trash, and still remain in the Windows Recycle
Bin - three stages that confuse users.

Add a Settings preference **Deletion Behaviour** with two choices:

A. **Move to Windows Recycle Bin** (the safe default)
- recovery stays possible through the Windows Recycle Bin
- no unnecessary intermediate deletion steps
- users restore from, or empty, the Windows Recycle Bin later

B. **Permanently Delete**
- removes the file without sending it to the Windows Recycle Bin
- clearly warns that this is irreversible
- requires confirmation

Constraints:
- audit the existing DiskFrame Trash architecture first
- design a clear, predictable workflow that ends the three-stage confusion
- preserve existing trashed files during any migration
- do not silently change deletion behaviour for existing users

## 5. MP3 and audio file tiles

MP3 files show "No preview" today. Replace this with a dedicated audio tile:
- MP3 icon or badge
- an attractive audio-file visual
- embedded album art when available
- track name and artist when metadata exists
- duration when available
- other appropriate audio formats where feasible

Never show a false image preview for an audio file.

## 6. Manual albums inside Events

Albums, as in phone gallery apps, as part of Events:
- create an album and name it
- choose a cover photo
- add multiple photos and videos
- remove media
- rename the album
- change the cover
- browse album details
- delete an album without deleting the original files

Albums get their own visible filter or subsection inside Events. Users may select photos from several drives when
they explicitly choose them. Albums are manually curated: do not confuse them with discovered Places or Trips.
Albums and their associations persist across restarts and drive-letter changes.

## 7. Face recognition and People discovery (research only)

Investigate an optional local People feature: DiskFrame finds faces, groups likely matches, and the user names each
group; choosing a person shows their photos.

Research:
- face detection
- face alignment
- face embeddings
- similarity comparisons
- clustering
- user labelling
- merge and split operations
- ONNX inference
- hardware acceleration
- incremental face indexing
- face database design
- privacy and data deletion

Constraints:
- do not train a model from scratch by default
- research commercially licensed pretrained models
- do not use pretrained weights with non-commercial-only licences in a commercial release
- the feature is optional and explicitly enabled by the user
- processing is local only, with no photo uploads
- people are kept separate across different drive owners by default
- grouping is editable through manual merge and split

Prepare a benchmark plan on 500-1,000 representative photos before estimating full-library time. **Do not scan faces
or download model weights yet.**

## 8. DiskFrame Pro strategy (recommendation only)

Once the core experience is stable and analytics give useful data, propose a Free vs Pro model. Candidate Pro
capabilities:
- advanced face/person grouping
- AI-powered photo search
- similar-photo and duplicate detection
- advanced Places and Trips discovery
- smart organisation
- cloud backup
- cross-device synchronisation
- premium automation

The recommendation must cover:
- what stays free
- what has enough premium value
- what creates ongoing infrastructure cost
- subscription positioning
- monthly and annual pricing considerations

Do not implement billing, subscriptions or feature restrictions. Never gate basic access to the user's own files.

## 9. Proposed priority order

1. Analytics and update tracking
2. Video deletion bug and deletion behaviour setting
3. Audio and MP3 tiles
4. Manual albums inside Events
5. Face recognition research and prototype
6. Free vs Pro strategy

Proposed, not final: review dependencies and recommend changes before implementation.

---

## Planning notes (engineering observations for review, not requirements)

- **Downloads are already countable.** GitHub's API reports `download_count` per release asset. On 2026-11-19 the
  setup installers stood at 1.5.0: 3, 1.4.1: 7, 1.4.0: 5, 1.3.0: 12, 1.1.0: 4. In-app updates download the same
  installer (sometimes differentially), so these counts mix first installs with updates. That is exactly why
  section 1 asks to separate downloads from installations.
- **Analytics needs decisions before any code:**
  - a provider and where its data lives
  - a public privacy policy (also needed for Google OAuth verification)
  - a consent screen
  - whether crash reports use the same consent
- **Update History builds on what exists.** It can reuse the updater state and the GitHub releases list the updater
  already reads, and pairs naturally with "successful updates" tracking (sections 1 and 2).
- **Deletion: do section 4 before section 3.** Today DiskFrame Trash is soft deletion in the catalogue; emptying it
  sends files to the Windows Recycle Bin (src/main/recycleBin.ts), which is the three-stage flow. The deletion
  setting decides what the viewer's Delete does, so it should be designed first. The video-viewer fix then implements
  the confirmation over the player.
- **Albums largely exist already.** 1.5.0 already has user-made collections ("Collections" in Events): name, cover,
  add/remove (also across drives), rename, delete without touching files, persistent across restarts and letter
  changes. Albums may mostly be a presentation and naming change plus multi-select "Add to album", which would make
  section 6 smaller than it looks.
- **Face research is independent** and can run in parallel. The licence review of model weights comes first.
- **Pro strategy depends on analytics data** (section 1). It stays last.
- **Suggested order for review:**
  1. analytics + update tracking/history
  2. deletion setting, then the video-delete fix
  3. audio tiles
  4. albums
  5. face research, possibly in parallel from step 2
  6. Pro strategy
