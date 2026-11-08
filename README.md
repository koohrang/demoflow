# Demoflow

Record click-through product demos, polish them, and share them as an interactive page, a video or a GIF. Everything runs in one HTML file.

## Use it

Open **Demoflow.html** in Chrome or Edge. Nothing to install. Your demos are saved in that browser.

## Get updates automatically (GitHub)

1. Create a **public** repository on GitHub, for example `demoflow`.
2. Upload every file in this folder to it (drag them onto the repository page and commit).
3. In Demoflow, open **Settings → Updates** and paste this address, with your user name:
   `https://raw.githubusercontent.com/koohrang/demoflow/main/version.json`

From then on, Demoflow checks once a day (or when you click **Check for updates**). When a new version is
committed to the repository, it downloads it and asks you to restart. You keep the same file and all your demos.

**To publish a new version:** replace `Demoflow.html`, `index.html` and `version.json` in the repository with the new ones.

If an update ever fails to start, Demoflow goes back to the copy inside your file by itself.
To force that, open the file with `#safe` at the end of the address.

## Optional: run it from the web

Turn on **Settings → Pages** in the repository (branch `main`, folder `/`). Demoflow then runs at
`https://koohrang.github.io/demoflow/`, can be installed as an app from Chrome's address bar, and updates on every reload.
Demos saved there are separate from the ones in your local file: use **Backup → Back up all demos** and
**Restore from a backup** to move them.

## Files

| File | What it is |
| --- | --- |
| `Demoflow.html` | The app (the file you open) |
| `index.html` | The same app, for GitHub Pages |
| `version.json` | Version number, release notes and a checksum, read by the updater |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | Let the web version install as an app and work offline |
| `logo.svg` | The Demoflow logo |
