'use strict';
// THE ONE PLACE FOR THE PROGRAM'S NAME. Everything that shows or uses the name, the publisher or an address reads it from here:
//   main.js       window titles, dialogs, menus, the settings folder (%APPDATA%\<name>), what the page is told (hooks.brand)
//   server.js     the program's own folder inside each library, and the name when no window tells it
//   update.js     what an installer file is called, and which GitHub project is asked for a newer one
//   build/make-config.js   the installer: product name, exe name, shortcuts, "Apps & features" entry, publisher, setup file name
//   build/installer.nsh    the wording of the setup wizard and the uninstaller (through defines written by make-config.js)
//
// TO RENAME THE PROGRAM: change `name` (and `shortName`) below, then follow docs/RENAMING.md — it lists what must be carried
// over for people who already have it installed. Nothing else in this file needs to change for a rename.
//
// What still has to be changed BY HAND for a rename, because these places cannot read brand.js:
//   package.json        "productName"  the built program does NOT use it (the installer writes the name from here into the
//                                      program's own copy); it only labels the source folder. Change it to match.
//                       "description"  same
//                       "author"       same (the built program's publisher comes from `publisher` below)
//                       "name"         LEAVE AS IT IS ("print-gallery"). It is never shown, and the installer keeps its own
//                                      copy of the setup file in %LOCALAPPDATA%\<this>-updater.
//   the pictures        npm run art    draws icon.png, icon.ico, public/logo.png and the three installer pictures in build/
//                                      again: the name and the maker line are written on the side panel
//   public/index.html   the name where the page spells it out before the server has answered (the title and the header)
//   README.md, docs/    the name in the text
// "version" stays in package.json, as before. The electron-builder settings are no longer in package.json: its "build" entry
// only points at build/builder.js, which works everything out from this file.
// ---- THE TWO ADDRESSES ARE SWITCHED OFF until they exist. While a switch is false the address is EMPTY in the built program:
// no website link is shown anywhere, and Help > Give feedback is not there at all. To turn one on, change its one line to true
// and build again. Nothing else needs changing.
const WEBSITE_IS_LIVE = false;          // true once https://jriidesigns.com/printbinder is on the internet
const FEEDBACK_MAILBOX_EXISTS = true;   // true once the mailbox info@printbinder.com has been created and is read

const brand = {
  name: 'PrintBinder',              // the full name: window title, installer, shortcuts, settings folder (new installs)
  shortName: 'PrintBinder',         // where space is tight (the taskbar, short messages)
  maker: 'by JRII Designs',         // the line under the name: About, the installer's side panel, the header's tooltip
  description: 'Browse and organise a 3D printing library',
  publisher: 'JRII Designs',        // shown as the publisher (the installer, "Apps & features", About)
  licence: 'MIT',
  // JRII Designs is the trade name of Benjamin Mallah II, the author and copyright holder of this program.
  // That is recorded here and nowhere the program shows: the lines people see say JRII Designs only.
  copyright: 'Copyright (c) 2026 JRII Designs',   // the same line is in LICENSE: keep them alike
  website: WEBSITE_IS_LIVE ? 'https://jriidesigns.com/printbinder' : '',
  feedbackEmail: FEEDBACK_MAILBOX_EXISTS ? 'info@printbinder.com' : '',
  // ---- identity. These tie a new installer to an existing install; changing them makes Windows see a different program.
  appId: 'local.printgallery',      // KEPT from "Print Gallery", so the PrintBinder installer updates an old install in place
  updateRepo: 'JRIIDesigns/printbinder',   // THE ONE PLACE for the GitHub project whose releases are looked at for a newer
                                    // version. Change it here when the releases move to the public project (docs/RELEASING.md)
  // ---- what the program was called before. Nobody who installed it under an earlier name may lose anything:
  formerNames: ['Print Gallery'],   //  * %APPDATA%\<former name>, when it exists, stays the settings folder (main.js): the saved AI
                                    //    keys are locked with a key kept in that very folder, so it is used in place, never copied
                                    //  * an installer file named after a former name is still accepted as an update (isSetup)
                                    //  * shortcuts left over under a former name are removed by the installer (build/installer.nsh)
  dataFolder: 'PrintBinder',        // the program's own folder inside a NEW library: <home>\PrintBinder\data and ...\updates
  formerDataFolders: ['Print Gallery'],   // a library that already has one of these keeps it (libraryFolder below). Both names are
                                    // the program's own, protected folder in every library, whichever one is in use
};
// A test build may carry other values in its own package.json (see build/test-variant.js); the real program never has this field.
try { Object.assign(brand, require('./package.json').brandOverride || {}); } catch {}

// Worked out from the names, so they can never disagree with them:
function finish(b) {
  const prefix = n => String(n).trim().replace(/[^A-Za-z0-9]+/g, '-') + '-Setup-';
  b.slug = b.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');   // printbinder
  b.setupPrefix = prefix(b.name);                                                            // PrintBinder-Setup-
  b.formerSetupPrefixes = (b.formerNames || []).map(prefix);                                 // Print-Gallery-Setup-
  b.setupName = version => b.setupPrefix + version + '.exe';
  // every name one release's installer is published under: its own, and one per former name for the installs that only know that
  b.setupNames = version => [b.setupPrefix, ...b.formerSetupPrefixes].map(p => p + version + '.exe');
  b.isSetup = file => { const n = String(file || ''); return [b.setupPrefix, ...b.formerSetupPrefixes].some(p => n.startsWith(p) && /^[\d.]+\.exe$/i.test(n.slice(p.length))); };
  b.publisherShown = b.publisher || b.name;
  b.dataFolders = [b.dataFolder, ...(b.formerDataFolders || [])];   // every name the program's own folder in a library may have
  // Which of those names THIS library uses. Looked at once, at start: a library that already has the program's data keeps the
  // folder it has (the current name first, should both ever be there); an empty or brand-new library gets the current name.
  b.libraryFolder = root => {
    const fs = require('fs'), path = require('path');
    const has = (...p) => { try { return !!fs.statSync(path.join(root, ...p)); } catch { return false; } };
    return b.dataFolders.find(n => has(n, 'data', 'index.json')) || b.dataFolders.find(n => has(n, 'data')) || b.dataFolders.find(n => has(n, 'updates')) || b.dataFolder;
  };
  b.variant = over => finish(Object.assign({}, b, over));   // the same brand with some values changed (the test build)
  return b;
}
module.exports = finish(brand);
