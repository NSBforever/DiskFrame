# DiskFrame 1.1.0 release notes

## New: automatic updates
- **How it works:** DiskFrame checks GitHub for a newer release about 15 seconds after it starts, and every six hours while it runs.
- **Installing:** a new version downloads in the background and installs when you close the app. Or install it straight away from the "Restart now" banner.
- **What's sent:** the check only reads this repository's release information. Nothing about your files or drives is sent.
- **Turning it off:** use **Settings → Updates → Update automatically**. The change applies from the next launch.
- **Not covered:** the portable build doesn't update itself, and safe mode never checks.
- **Coming from 1.0.0 or 1.0.1:** install 1.1.0 once by hand. Later versions then arrive on their own.

## Also
- Building on your own PC never publishes a release: the build scripts pass `--publish never`.
