# Releasing DiskFrame

Installed copies update themselves from this repository's GitHub Releases, so a
release is more than an installer: it is four files that have to agree with
each other. The pipeline builds them, checks them, and stops at a **draft** so
a person tries the build before anyone receives it.

## What every release must contain

| File | Why |
|---|---|
| `diskframe-X.Y.Z-setup.exe` | The installer. Also what an installed copy downloads to update. |
| `diskframe-X.Y.Z-setup.exe.blockmap` | Lets an update download only the changed parts. |
| `latest.yml` | Version, file name, size and SHA-512 of the installer. Installed copies read this to learn that a release exists, and discard a download that does not match it. |
| `diskframe X.Y.Z.exe` | The portable build (GitHub shows it as `diskframe.X.Y.Z.exe`). It can announce an update but not install one. |

Without `latest.yml` and the blockmap, installed copies never see the release.
`node scripts/verify-release.cjs` checks all of this; the workflow runs it
before uploading and again on the published assets.

## One-time setup

1. **mpv for the build machine.** `mpv.exe` (117 MB) is not in git. The release
   workflow takes it from a pre-release of this repository named `build-deps`
   and refuses any file whose SHA-256 is not the one in `scripts/mpv.sha256`.
   Upload it once, from a checkout that has the tested binary:

   ```bash
   gh release create build-deps resources/bin/win/mpv.exe --prerelease --title "Build dependencies" --notes "mpv.exe used to build DiskFrame. Not an app release."
   ```

   It must be a **pre-release**: a normal release here would become "latest",
   and installed copies would look for a `latest.yml` it does not have.
   To change mpv: replace the asset and commit the new checksum
   (`sha256sum resources/bin/win/mpv.exe`).

2. **Code signing (optional, not set up).** No certificate exists yet, so
   builds are unsigned and Windows SmartScreen warns on first run. To sign,
   add two repository secrets and nothing else changes:
   - `CSC_LINK`: the code-signing certificate as a base64-encoded `.pfx`
   - `CSC_KEY_PASSWORD`: its password

   Once releases are signed, set `verifyUpdateCodeSignature: true` in
   `electron-builder.yml` and add `publisherName` so an update is also checked
   against the publisher. An EV or cloud-HSM certificate (which most CAs now
   issue) cannot be exported as a `.pfx`; that needs the CA's signing tool in
   the workflow instead.

## Cutting a release

1. Bump `version` in `package.json`, write `docs/RELEASE_NOTES_X.Y.Z.md`,
   update the README download link and badge, commit, push `master`.
   CI (`.github/workflows/ci.yml`) runs typecheck, tests and a build, and reports lint.
   Lint is advisory for now: `src/` still has about 320 older lint errors
   (missing return types, `any`, prop-types), so it prints them without failing
   the run. Make the step blocking once they are cleared.
2. Tag that commit and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "DiskFrame X.Y.Z"
   ```

   ```bash
   git push origin vX.Y.Z
   ```

3. `.github/workflows/release.yml` then: checks the tag equals the version in
   `package.json`; runs typecheck and tests; fetches and verifies mpv;
   runs `npm run build:win` (whose `afterPack` hook fails if mpv, ffmpeg,
   ffprobe, better-sqlite3 or sharp is missing from the package); runs
   `verify-release.cjs`; and creates a **draft** release with the four files
   and the release notes.
4. **Try the draft.** Download its installer, install over the previous
   version, open a drive, play a video. Then press **Publish** on the draft.
5. Publishing triggers the `published` job, which downloads the public assets
   and verifies them once more. Installed copies notice the release within six
   hours, or at their next start.

If the workflow fails, nothing was published: fix, delete the tag
(`git push --delete origin vX.Y.Z`), and tag again.

## Releasing from this PC instead

The same steps by hand, for when Actions is unavailable:

```bash
npm run build:win
```

```bash
node scripts/verify-release.cjs
```

then `gh release create vX.Y.Z --draft` with the four files from `dist/`.
`build:win` passes `--publish never`; building never uploads anything.

## Testing updates without publishing

`DF_UPDATE_FEED=<url>` points the updater at any folder that serves a
`latest.yml`, instead of GitHub. `scratch/perf/updfeed.js` serves one for a
pretend version (optionally with a wrong checksum, or slowly), and
`scratch/perf/_upd.js` drives the notice through it. In an unpackaged run a
download is verified but never installed. With a packaged build, force-kill it
afterwards rather than closing it (closing installs the download) and delete
`%LOCALAPPDATA%\diskframe-updater\pending`.

## How updates behave for users

Settings → Updates offers three modes, stored in the catalogue:

- **Download and install automatically** (default): checks about 15 seconds
  after start and every six hours, downloads in the background, installs when
  the app closes or on "Restart and Install".
- **Tell me when one is available**: the same checks, but the download starts
  only on "Download Update".
- **Do not check**: only the "Check for Updates" button checks.

The notice is never shown over a file transfer or an open photo/video, and an
install is refused while a transfer is running. A failed background check is
silent; a failed download says why and offers "Try Again". The states and the
rules for showing them are in `src/main/updateState.ts` and are unit-tested.
