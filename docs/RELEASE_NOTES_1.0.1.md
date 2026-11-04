# DiskFrame 1.0.1 release notes

## If you were on the original build
**Install this over it.** Builds from before 1.0.0 filed every file of a drive whose letter had changed under its old letter. On a real 2 TB drive that was 61,448 of 102,460 files, and all of them showed as OFFLINE or blank tiles. 1.0.0 and later move them to the drive's current letter the first time you open it. Favourites, dates and thumbnails come along.

## Fixed
- **Folders that disappeared from a drive can now be cleared.**
  - **What went wrong:** when folders were moved, renamed or deleted on a drive, their files stayed in DiskFrame as broken tiles. Clicking "Check for changes" didn't help either: it refused to remove more than half a drive's files, to protect against a drive that briefly reads as empty.
  - **What happens now:** automatic checks still never remove that many on their own; a message points you to "Check for changes". A manual check lists the missing folders and asks first.
  - **The dialog:** "Keep them" is the default button. Only an explicit "Remove from DiskFrame" removes anything, and a copy of the catalogue is saved first.
  - **What gets removed:** only DiskFrame's list. Nothing on the drive is touched.
  - **Measured on a 2 TB drive** after cleaning up 61,341 rows from vanished folders: first tile in 0.78 s (was 2.6 s), and every visible tile has its picture.
- **macOS `._` sidecar files are no longer indexed.** A Mac writes one of these 4 KB metadata files beside every file it copies. They carry the photo or video extension but contain no picture, so each one showed up as an empty tile next to the real file. Existing rows are dropped on first launch (2,833 in one library); the files on the drive are untouched.
- **The Group by and sort menus open above the gallery.** They used to draw behind the tiles, which also took their clicks.
- **The Years view**
  - shows pictures: each card looks further for files that can actually show one;
  - shows four different pictures rather than copies of the same photo;
  - is grouped by decade.
- **The "Pinch to zoom" label is gone** from the toolbar.

## Not changed: real duplicate files
When the same photo appears twice next to itself, check its folder. In the library behind this report, every such pair was two real copies on the drive, in different folders and with different file IDs. For example, the same SD card was backed up under both `1) Family Pictures` and `4)SaiBaba Files`. DiskFrame shows each file on the drive exactly once. It does not hide copies, because a copy can be the one you want.
