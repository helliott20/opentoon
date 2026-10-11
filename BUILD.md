# Building & Distributing OpenToon Studio

OpenToon runs two ways:

1. **Plain web app** — double-click `index.html`. No install, no build. Good for a
   quick look.
2. **Desktop app** — a real Windows program (`OpenToon Studio.exe`) built with
   Electron, with **automatic over-the-air (OTA) updates**. This is what you give
   to your friend.

---

## One-time setup

Install [Node.js](https://nodejs.org) (LTS), then in the project folder:

```
npm install
```

This pulls Electron, electron-builder and electron-updater (~300 MB, dev only).

---

## Running it for development

```
npm run dev
```

Launches the desktop app pointing at your local files, with **live reload** —
edit anything in `src/`, `styles/` or `index.html` and the window refreshes
automatically. DevTools open alongside.

`npm start` runs it the same way but without dev mode (no live reload / DevTools).

---

## Building the Windows installer

```
npm run dist
```

Produces `dist/OpenToon Studio Setup <version>.exe` — a normal installer with a
desktop shortcut. Hand that file to your friend; they run it once to install.

---

## OTA updates — push new versions to your friend automatically

The desktop app checks for updates on launch (and every 30 min) and installs them
on the next restart. To make that work:

### 1. Create a GitHub repo

Make a repo (it can be private) and push this project to it.

### 2. Point the app at it

In `package.json`, under `build.publish`, set your details:

```json
"publish": [
  { "provider": "github", "owner": "YOUR_GITHUB_USERNAME", "repo": "opentoon" }
]
```

### 3. Publish a release

Get a GitHub personal access token (scope: `repo`) and set it, then publish:

```
# PowerShell
$env:GH_TOKEN = "your_token_here"
npm version patch          # bumps the version number
npm run publish            # builds + uploads the release to GitHub
```

`npm run publish` builds the installer and uploads it (plus the `latest.yml`
update feed) to a GitHub Release.

### 4. Your friend gets it automatically

Once your friend has installed the app once, every future `npm run publish` you
do is picked up automatically — next time they open OpenToon it downloads the
update in the background and offers to restart.

---

## Releasing a new version — checklist

1. `npm test` — run the headless browser tests (all should pass).
2. `npm version patch` (or `minor` / `major`) — bumps `package.json`.
3. `npm run publish` — builds and uploads to GitHub Releases.

That's it. Installed copies update themselves.

## Installing it

- **You:** run `dist\OpenToon Studio Setup <version>.exe` (created by `npm run dist`
  / `npm run publish`).
- **Your friend:** send them
  https://github.com/helliott20/opentoon/releases/latest — they download and run
  `OpenToon Studio Setup ….exe`. Windows SmartScreen warns about an unsigned app
  the first time: **More info → Run anyway** (one-time).
- After installing once, updates are automatic — see OTA section above.

## Troubleshooting

**`npm run publish` fails extracting `winCodeSign` ("required privilege not held"):**
Windows blocks symlink creation for non-admins. Fix it once by turning on
**Settings → System → For developers → Developer Mode**, then re-run. (The build
cache is already primed on this machine, so it should not recur here.)

## Linux

Tested on Arch Linux with Hyprland (native Wayland and XWayland).

### Build

```
npm ci
npm run dist:linux
```

Produces `dist/OpenToon-Studio-<version>-x86_64.AppImage` (portable, needs no
install) and the unpacked app in `dist/linux-unpacked/`.

### Per-user install (no root)

```
tools/linux/user-install.sh install        # installs dist/linux-unpacked
```

Puts the app in `~/.local/opt/opentoon-studio/versions/<version>-<commit>/`
with `current` / `previous` symlinks, a launcher at `~/.local/bin/opentoon-studio`,
a desktop entry, icons, and the `.otoon` file type. Nothing outside your home
directory is touched and no FUSE is needed. Afterwards:

```
opentoon-studio-update status     # what is installed, what rollback would restore
opentoon-studio-update check      # is a newer release out? (read-only)
opentoon-studio-update update     # review, approve, build, test, install
opentoon-studio-update rollback   # switch back to the previous version
opentoon-studio-update uninstall  # projects and settings are kept
```

`update` fetches the release tag, shows the upstream commits and any changes to
dependencies / main-process / build scripts, and only continues after you type
the exact version (or pass `--approve <version>`). It then runs `npm ci`, the
test suite, the packaged-app GUI smoke test and installs; any failure leaves
the installed version untouched and points at a log under
`~/.local/opt/opentoon-studio/logs/`.

The launcher starts native Wayland when available. Set
`OPENTOON_OZONE_PLATFORM=x11` to force XWayland (e.g. if a tablet driver only
reports pressure there). Settings, recents and the crash-recovery autosave live
in `~/.config/opentoon/`.

### Updates on Linux need approval

Update policy is chosen per platform and can be overridden with
`OPENTOON_UPDATES=auto|manual|off`:

| Policy | Default on | Behaviour |
|--------|------------|-----------|
| `auto` | Windows | downloads in the background, installs silently on quit |
| `manual` | Linux, macOS | checks only; downloading and installing each need a click |
| `off` | — | never contacts GitHub |

With `manual`, the app checks GitHub Releases at launch and every 6 hours and
shows an *Update Available* card. **Download** appears only when the app can
replace itself without root (an AppImage, with `latest-linux.yml` attached to
the release); otherwise the card links to the release page. Failures (offline,
timeout, rate limit, missing release) are shown with their cause in
*Help → About → Check for Updates*.

From a terminal, `npm run check-update` (or `node tools/check-update.cjs
[--current X] [--json]`) does the same read-only check. Exit codes: `0` up to
date, `10` update available, `2` network failure, `3` GitHub rate limit (set
`GITHUB_TOKEN`), `4` missing / unusable release data.

### Publishing Linux builds

The release workflow currently builds Windows only. To attach a Linux build to
a release (which also enables the in-app Download button for AppImage users):

```
GH_TOKEN=... npx electron-builder --linux --publish always
```

### Tests on Linux

The headless tests need a Chromium-based browser. They find Chrome, Edge,
Chromium, Brave or Vivaldi on `PATH`, or use `OPENTOON_TEST_BROWSER=/path/to/browser`.

```
npm test                                         # unit + headless browser tests
node tests/electron-smoke.cjs                    # packaged app, real GUI session
node tests/electron-smoke.cjs dist/linux-unpacked/opentoon-studio --ozone-platform-hint=auto
```

The smoke test launches the packaged app with a throwaway config directory and
checks drawing, undo, playback, save/reopen, GIF/WebM/PNG export, the pen
window, the update policy and the unsaved-changes prompt.

## Notes

- The app itself has **zero runtime dependencies** — it's plain HTML/CSS/JS.
  Electron is only the desktop shell + updater.
- macOS builds: change the `--win` flag in the `dist`/`publish` scripts to
  `--mac` (code-signing required for mac auto-updates).
