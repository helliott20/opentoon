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

## Notes

- The app itself has **zero runtime dependencies** — it's plain HTML/CSS/JS.
  Electron is only the desktop shell + updater.
- macOS/Linux builds: change the `--win` flag in the `dist`/`publish` scripts to
  `--mac` or `--linux` (code-signing required for mac auto-updates).
