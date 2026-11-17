# Renaming the program

The name, maker, publisher and addresses live in one file, `brand.js`.

The program has been renamed once: **Print Gallery became PrintBinder in version 2.1.0.** This file says how that was done, what an existing install keeps, and how to do another rename. The rule throughout: **nobody loses anything, and nothing is copied or moved.** What an install or a library already has stays where it is, under the name it has, and the renamed program goes on using it.

## 1. Change the name

In `brand.js`:

| Value | Change it? |
| --- | --- |
| `name`, `shortName` | Yes: the new name. Window title, dialogs, menus, installer, shortcuts, "Apps & features" and the settings folder of new installs all follow. It must be usable as a Windows folder name (no `\ / : * ? " < > |`). |
| `formerNames` | **Add the old name** to the list. This is what carries existing installs over (steps 3, 4 and 6). Never remove a name from it. |
| `dataFolder` | The folder a brand-new library gets. If it changes, **add the old value to `formerDataFolders`** (step 5). |
| `maker`, `description`, `publisher`, `licence`, `copyright` | As needed. |
| `website`, `feedbackEmail` | Each has a switch at the top of the file (`WEBSITE_IS_LIVE`, `FEEDBACK_MAILBOX_EXISTS`). While a switch is `false` the address is empty in the built program: no website link is shown, and Help > Give feedback is not there. |
| `appId` | **No.** Windows and the installer recognise an existing install by it. Keeping it is what lets the renamed installer update the old install in place instead of installing a second program beside it. |
| `updateRepo` | Only if the releases move to another GitHub project (`docs/RELEASING.md`). |

## 2. The places that cannot read `brand.js` (change by hand)

- `package.json`: `"productName"`, `"description"`, `"author"`. The built program does not use these (the build writes the values from `brand.js` into the program's own copy), but they should match. Leave `"name"` (`print-gallery`) as it is: it is never shown, and the installer keeps its own copy of the setup file in `%LOCALAPPDATA%\<name>-updater`.
- The pictures: `npm run art` redraws `icon.png`, `icon.ico`, `public/logo.png` and the three installer pictures in `build/`. The name and the maker line are written on the installer's side panel. `public/jrii.png` (the maker's logo) is not redrawn.
- `public/index.html`: the title and the header spell the name out for the moment before the server has answered. Everything else on the page asks for the name. The entry in `WHATSNEW` should say that the name changed and that everything is kept.
- `README.md` and `docs/`: the name in the text.
- `LICENSE`: the copyright line, if the owner changed. The setup wizard's licence page (`build/license.txt`) is a copy written at every build.

Names that are **not** changed, because they are real folders people already have on disk:

- `_Removed by Gallery`, the folder for removed files in every library.
- `Print Gallery`, the data folder of a library first used under that name (step 5), and `%APPDATA%\Print Gallery`, the settings folder of an install first made under that name (step 4). The guide (Help > Guide > Where things are kept) names the folder the library really has, and says why.
- `~\.print-gallery`, used only when the server is run by itself without the desktop window (tests).

## 3. What the renamed installer does to an existing install

Because `appId` is unchanged, the renamed installer finds the old install, removes the old program files and installs the new ones **into the same folder** (`%LOCALAPPDATA%\Programs\print-gallery` for anyone who installed 2.0.2 or earlier). The program file becomes `<New Name>.exe`; the old `.exe` is gone. "Apps & features" shows one entry, under the new name and publisher.

Shortcuts: the installer renames the desktop and Start-menu shortcuts it knows about, and `build/installer.nsh` (`customInstall`) then removes any shortcut still left under a former name, so there is never a second set. The list of former names reaches the installer through `build/make-config.js`.

A shortcut the user pinned to the taskbar by hand points at the old `.exe` and is not repaired by the installer; Windows shows it as broken and it has to be pinned again.

## 4. The settings folder of each computer

The settings of one computer are in a folder under `%APPDATA%`: `config.json` (which folder is the library, window size, theme, preferences), `claude-key.bin`, `openai-key.bin`, `gemini-key.bin` (saved AI keys), `slicers.json`, `locations.json`, `phone.json` (paired phones) and `update-pending.json`.

**The saved keys cannot be copied to another folder.** Windows locks them with a key that is itself kept in the settings folder (`Local State`). A key file copied elsewhere will not open.

So nothing is copied. At start, before anything else (`main.js`, right after `app.setName`):

- if `%APPDATA%\<a former name>` exists, it **stays the settings folder**, in place;
- only a computer that never had the program under a former name uses `%APPDATA%\<name>`.

The uninstaller's tick box "Also remove my settings and saved AI keys from this computer" removes both folders, and its wording names the one that is really there.

## 5. The program's own folder inside each library

Every library has a folder of the program's own, holding `data` (index, previews, descriptions, history, `app-version.json`) and `updates`. A library is often shared between computers through a cloud folder, and those computers are not all updated on the same day.

- A library that already has `Print Gallery\data` **keeps it**. Nothing is renamed, so a computer still running an old version goes on finding the same data.
- A library with neither folder gets `PrintBinder\data`.
- The choice is made once, at start (`libraryFolder` in `brand.js`, used by `server.js` and `main.js`): a name that has the index wins, the current name first.
- **Both names are the program's own, protected folder in every library**, whichever is in use: never listed in the gallery, never a place to move, copy, rename or unpack into, never watched, never offered as the name of a location (`ownTop` and `protectedRel` in `server.js`).

One thing to know: a Print Gallery install (2.0.2 or older) that opens a library made by PrintBinder does not find `PrintBinder\data` and starts its own empty `Print Gallery\data` beside it. PrintBinder still uses `PrintBinder\data`, so nothing is lost, but that old copy sees no previews or history until it is updated. Its "out of date, look only" check cannot help, because it looks in the folder it does not know.

## 6. Getting existing installs to take the renamed version

An installed copy only accepts an update whose setup file is named the way it expects. Print Gallery installs accepted `Print-Gallery-Setup-<version>.exe` and nothing else; PrintBinder accepts `PrintBinder-Setup-<version>.exe`, and a file named after a former name as well if it is ever offered one (`isSetup` in `brand.js`, from `formerNames`).

For the first renamed versions each release therefore carried the same installer under both names. That has ended: the installs made before 2.1.0 were private copies and no longer exist, so from 2.1.5 a release carries one installer, `PrintBinder-Setup-<version>.exe`, and `latest.json` in a library's `updates` folder names that file. `npm run dist` makes both. The exact steps are in `docs/RELEASING.md`.

After another rename, while installs under the old name are still in use, the release has to carry the old-named copy again for as long as they should be able to update: they will take nothing else.

Old installs start the setup file with `--updated --force-run`; the setup wizard understands both, so the update works from any earlier version: the progress page shows, nothing is asked, and the program opens again by itself.

## 7. Check before releasing

With the test build (`npm run dist:test`). It is called "<name> Test", installs beside the real program, and its former names get " Test" as well, so it never touches the real install, shortcuts or settings:

- a fresh install on a computer with no settings folder: the welcome shows, the settings go to `%APPDATA%\<name>`;
- an install made under the old name, updated by the renamed installer handed over by the old program itself: version, window title, one set of shortcuts under the new name, the old `.exe` gone, one entry in "Apps & features";
- after that update: the home folder is not asked for again, and a saved AI key, the slicers and paired phones are still there;
- a library last used under the old name opens with its previews and history, and no file outside its data folder has changed;
- an update from the renamed version to a newer one;
- uninstall with and without the settings tick box.
