# Releasing a version

Every step of a release, in order. The names used here come from `brand.js`; if the name there changes, the file names follow.

A release has one installer, `PrintBinder-Setup-<version>.exe`. Installs older than 2.1.0 were private copies and no longer exist, so nothing is published under an earlier name. Releases are published in the GitHub project named by `updateRepo` in `brand.js` and, for a library shared between computers, the installer is copied with `latest.json` into the library's `updates` folder.

## 0. The built-in browser means security releases

Since 2.2.0 the program has a window that shows other people's web pages (File > Find models online, `browser.js`). The browser engine comes with Electron, so a security fix to Chromium reaches users only through a new release of this program. When Electron publishes a release that fixes a security fault in Chromium or in Electron itself: update `electron` in `package.json` to the newest release of the same major version, run the tests, and publish a patch release without waiting for other work. Check for one before every release in any case.

Three things in `browser.js` are what keep that window apart from the rest of the program, and no change may weaken them: its pages get no preload and run sandboxed in a session of their own; requests to this computer, to private network addresses and to anything but http and https are refused; and a download is only ever saved, never opened.

Browsing must never make Windows Firewall ask about the program. Chromium opens network sockets for QUIC and for mDNS that do exactly that, so `main.js` switches both off (2.2.1). After an Electron update, check it still holds: copy `distwin-unpacked` to a folder it has never run from, start it, open a few sites in Find models (a video site and a video-call site among them), and confirm that `Get-NetUDPEndpoint` lists nothing for its processes and that no new firewall rule naming the program has appeared.

## 1. Before building

1. Set `"version"` in `package.json` (and in both places at the top of `package-lock.json`).
2. In `public/index.html`, find `WHATSNEW` and make sure the top entry has this version's number and notes.
3. Run the tests.
4. If the name, the maker line or the icon changed: `npm run art`.

## 2. Build

```
npm run dist
```

This writes the notices, builds the installer, and then leaves in `dist\`:

| File | What it is |
| --- | --- |
| `PrintBinder-Setup-<version>.exe` | The installer |
| `latest.json` | `{"version": "<version>", "file": "PrintBinder-Setup-<version>.exe"}` |

The last lines printed give the installer's name, size and checksum, and what `latest.json` names. If that last step did not run, do it by hand: `node scripts/release-files.js`. A copy of this version's installer under an earlier name, left in `dist\` by an older build, is removed by that step. Installers of other versions are listed and left alone; do not attach them.

The installer is not code-signed. Windows shows an "unknown publisher" warning when someone runs it for the first time (README, Installing).

## 3. Try it before publishing

Build the test variant (`npm run dist:test`, optionally with `PG_TEST_VERSION` set) and try a fresh install, an update and an uninstall. "PrintBinder Test" installs beside the real program and keeps its own settings. See `docs/RENAMING.md`, step 7, for the list.

## 4. The GitHub release

In the project named by `updateRepo` in `brand.js` (at present `JRIIDesigns/printbinder`):

1. Create a release with the tag `v<version>` (for example `v2.1.5`). The tag is how the program reads the version.
2. Put the release notes in the description. The program shows the first 900 characters in "Version x is available".
3. Attach the installer, `PrintBinder-Setup-<version>.exe`, and nothing else.
4. Publish it as the latest release (not a draft, not a pre-release): the program asks for "latest".

With the command-line program:

```
gh release create v<version> --repo <updateRepo> --title "PrintBinder <version>" --notes-file notes.md "dist/PrintBinder-Setup-<version>.exe"
```

## 5. The library's `updates` folder

A library shared between computers carries the installer with it, so the other computers can update even when they cannot reach the releases. Into the `updates` folder of the program's own folder inside the library, copy from `dist\`:

- `PrintBinder-Setup-<version>.exe`
- `latest.json`

Which folder that is depends on the library:

| Library | Folder |
| --- | --- |
| First used with PrintBinder | `<home folder>\PrintBinder\updates` |
| First used under the earlier name, Print Gallery | `<home folder>\Print Gallery\updates` |

Remove the previous version's installer from the folder once the new one is in.

## 6. After publishing

1. On an installed copy, choose Help > Check for updates. It should offer the new version, install it, reopen, and say "Updated to version …".
2. Commit, and tag the commit `v<version>`.

## If the releases ever move

Change `updateRepo` in `brand.js` (it is the only place), and keep publishing in the old project for as long as installs that ask it should be able to update.
