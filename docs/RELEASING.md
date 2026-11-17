# Releasing a version

Every step of a release, in order. The names used here come from `brand.js`; if the name there changes, the file names follow.

## Why the installer has two names

An installed copy only accepts an update whose file is named the way that copy expects.

| Installed copy | Accepts |
| --- | --- |
| Print Gallery, up to 2.0.2 | `Print-Gallery-Setup-<version>.exe` only |
| PrintBinder, 2.1.0 and later | `PrintBinder-Setup-<version>.exe` and `Print-Gallery-Setup-<version>.exe` |

So every release carries the **same installer under both names**. An old Print Gallery install fetches the old-named copy and becomes PrintBinder in one step, with no clicks beyond "Update and restart". Keep shipping both names for as long as Print Gallery installs should be able to update. Dropping the old name strands them.

## 1. Before building

1. Set `"version"` in `package.json`.
2. In `public/index.html`, find `WHATSNEW` and make sure the top entry has this version's number and notes.
3. Run the tests.
4. If the name, the maker line or the icon changed: `npm run art`.

## 2. Build

```
npm run dist
```

This writes the notices, builds the installer, and then puts in `dist\`:

| File | What it is |
| --- | --- |
| `PrintBinder-Setup-<version>.exe` | The installer |
| `Print-Gallery-Setup-<version>.exe` | The same file, under the name old installs accept |
| `latest.json` | `{"version": "<version>", "file": "Print-Gallery-Setup-<version>.exe"}` |

The last lines printed say whether the two installers are the same file, with their size and checksum. If the copy step did not run, do it by hand: `node scripts/release-files.js`.

The installer is not code-signed. Windows shows an "unknown publisher" warning when someone runs it for the first time (README, Installing).

## 3. Try it before publishing

Build the test variant (`npm run dist:test`, optionally with `PG_TEST_VERSION` set) and try a fresh install, an update and an uninstall. "PrintBinder Test" installs beside the real program and keeps its own settings. See `docs/RENAMING.md`, step 7, for the list.

## 4. The GitHub release

In the project named by `updateRepo` in `brand.js` (at present `JRIIDesigns/printbinder`):

1. Create a release with the tag `v<version>` (for example `v2.1.0`). The tag is how the program reads the version.
2. Put the release notes in the description. The program shows the first 900 characters in "Version x is available".
3. Attach **both** installers: `PrintBinder-Setup-<version>.exe` and `Print-Gallery-Setup-<version>.exe`.
4. Publish it as the latest release (not a draft, not a pre-release): the program asks for "latest".

With the command-line program:

```
gh release create v<version> --repo <updateRepo> --title "PrintBinder <version>" --notes-file notes.md "dist/PrintBinder-Setup-<version>.exe" "dist/Print-Gallery-Setup-<version>.exe"
```

While that project is private, an install can only read it through the GitHub command-line program signed in on that computer. Everyone else updates through the library folder (step 5).

## 5. The library's `updates` folder

A library shared between computers carries the installer with it, so the other computers can update without signing in anywhere. Into the `updates` folder of the program's own folder inside the library, copy:

- `Print-Gallery-Setup-<version>.exe`
- `latest.json`

Which folder that is depends on the library:

| Library | Folder |
| --- | --- |
| First used with Print Gallery | `<home folder>\Print Gallery\updates` |
| First used with PrintBinder | `<home folder>\PrintBinder\updates` |

`latest.json` must name the old-style file (`Print-Gallery-Setup-…`) while Print Gallery installs still share the library: they ignore any other name. PrintBinder accepts it too. Remove the previous version's installer from the folder once the new one is in.

## 6. After publishing

1. On an installed copy, choose Help > Check for updates. It should offer the new version, install it, reopen, and say "Updated to version …".
2. Commit, and tag the commit `v<version>`.

## Installs that still ask the earlier project

Versions up to 2.1.0 look for updates in an earlier, private project and in the library's `updates` folder. Until every such install has updated to a version that asks `JRIIDesigns/printbinder`, publish each release in the earlier project as well, with both file names, and keep the `updates` folder current (step 5).

If the releases ever move again: change `updateRepo` in `brand.js` (it is the only place) and keep publishing in the old project for as long as older installs should be able to update.
