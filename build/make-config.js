'use strict';
// Makes the electron-builder settings from brand.js, so the installer's names can never disagree with the program's.
//   build/builder.js        the real program            (npm run dist)
//   build/test-variant.js   "<name> Test", which installs beside the real one for trying installs (npm run dist:test)
//
// The kind of installer: a setup WIZARD (oneClick: false) for the current Windows user only — no administrator prompt.
//   first install   Welcome > (Licence, once there is one) > progress > Finish with "Start <name>" ticked
//   update          the app starts the same file with  --updated --force-run : only the progress page shows, nothing is asked,
//                   and the program is opened again (see build/installer.nsh)
//   uninstall       Welcome > "Also remove my settings…" (unticked) > progress > Finish; the program only, never a library
//
// THE LICENCE PAGE: the wizard shows build/license.txt after Welcome, with "I Agree". That file is a copy of LICENSE at the top
// of the project, written again here at every build so the two can never differ: change LICENSE, not the copy.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');

// WHAT IS SHIPPED OF THE LIBRARIES: only the files the program loads, and each library's licence. The rest of a package (its
// source, other builds, tools, examples) would only make the download and the install bigger.
//   three             the page loads build/three.module.js (public/index.html, served by server.js under /vendor/three/). That
//                     file loads neighbours of its own; they are found here by reading its "import" lines, so a newer three.js
//                     that splits its build differently still gets every file it needs.
//   occt-import-js    STEP files: the reader and its .wasm (worker.js)
//   libheif-js        HEIC photos, through heic-decode (worker.js): the one-file build with the decoder inside it
//   qrcode-generator  the pairing code for a phone (phone.js)
// heic-decode is small and shipped whole. The build stops if a file named here is missing, or if what the program asks a
// library for is not among the files kept — so an update of a library that moves its files is noticed here, not by a user.
function libraryFiles() {
  const nm = path.join(root, 'node_modules');
  const threeBuild = () => {
    const dir = path.join(nm, 'three', 'build'), seen = new Set(), todo = ['three.module.js'];
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\b(?:from|import)\s*['"]\.\/([\w.-]+)['"]/g)) todo.push(m[1]);
    }
    return [...seen].sort().map(f => 'build/' + f);
  };
  const keep = {
    'three': ['package.json', 'LICENSE', ...threeBuild()],
    'occt-import-js': ['package.json', 'LICENSE.md', 'dist/occt-import-js.js', 'dist/occt-import-js.wasm', 'dist/license.occt-import-js.txt', 'dist/license.occt.txt'],
    'libheif-js': ['package.json', 'LICENSE', 'wasm-bundle.js', 'libheif-wasm/libheif-bundle.js', 'libheif-wasm/LICENSE'],
    'qrcode-generator': ['package.json', 'dist/qrcode.js'],
  };
  const asked = { 'occt-import-js': 'occt-import-js', 'libheif-js': 'libheif-js/wasm-bundle', 'qrcode-generator': 'qrcode-generator' };   // what the program (or heic-decode) requires
  const out = [];
  for (const [name, files] of Object.entries(keep)) {
    for (const f of files) if (!fs.existsSync(path.join(nm, name, f))) throw new Error('build: node_modules/' + name + '/' + f + ' is missing (run npm install; if the library moved its files, change the list in build/make-config.js)');
    if (asked[name]) {
      const entry = path.relative(path.join(nm, name), require.resolve(asked[name], { paths: [root] })).split(path.sep).join('/');
      if (!files.includes(entry)) throw new Error('build: ' + asked[name] + ' now loads ' + entry + ', which is not among the files shipped (change the list in build/make-config.js)');
    }
    out.push('!node_modules/' + name + '/**', ...files.map(f => 'node_modules/' + name + '/' + f));
  }
  return out;
}

module.exports = function makeConfig(brand, opt = {}) {
  const out = opt.output || 'dist';
  const pkgName = opt.packageName || require(path.join(root, 'package.json')).name;
  // What the wizard's wording needs to know, handed to build/installer.nsh as NSIS defines. Written into the output folder
  // (not into build/), so making a test build never changes a tracked file.
  const q = s => '"' + String(s).replace(/\$/g, '$$$$').replace(/"/g, '$\\"') + '"';
  const gen = path.join(root, out, '.installer-brand.nsh');
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  if (!brand.name || /[\/:*?"<>|]/.test(brand.name)) throw new Error('brand.js: the name is empty or has a character Windows does not allow in a folder name');
  const former = (brand.formerNames || []).filter(n => n && n !== brand.name && !/[\/:*?"<>|$]/.test(n));
  // a test variant must never share a name with the real program: its installer removes shortcuts and (when asked) settings by name
  if (opt.brandOverride) { const real = require(path.join(root, 'brand.js')), mine = [brand.name, ...former], theirs = [real.name, ...(real.formerNames || [])]; if (real !== brand && mine.some(n => theirs.includes(n))) throw new Error('build: the test variant shares the name "' + mine.find(n => theirs.includes(n)) + '" with the real program'); }
  const licence = path.join(root, 'LICENSE');
  if (fs.existsSync(licence)) fs.writeFileSync(path.join(__dirname, 'license.txt'), fs.readFileSync(licence, 'utf8').replace(/\r?\n/g, '\r\n'));
  fs.writeFileSync(gen, String.fromCharCode(0xFEFF) + [
    '; made by build/make-config.js from brand.js - do not edit',
    '!define PG_NAME ' + q(brand.name),
    '!define PG_MAKER ' + q(brand.maker || ''),
    '!define PG_DATA_FOLDER ' + q(brand.dataFolders.map(n => "'" + n + "'").join(' or ')),   // how the wording names the program's folder in a library
    // an install made under an earlier name: its shortcuts go, and its settings folder is the one the tick box removes
    '!macro pgRemoveFormerShortcuts', ...former.flatMap(n => ['  Delete "$DESKTOP\\' + n + '.lnk"', '  Delete "$SMPROGRAMS\\' + n + '.lnk"']), '!macroend',
    '!macro pgRemoveFormerSettings', ...former.map(n => '  RMDir /r "$APPDATA\\' + n + '"'), '!macroend',
    ...(former.length ? ['!define PG_FORMER_SETTINGS ' + q(former[0])] : []),
    '!define PG_SETTINGS_FOLDER ' + q(brand.name),          // %APPDATA%\<this>: main.js puts the settings there
    '!include ' + q(path.join(__dirname, 'installer.nsh')),
    ''].join('\r\n'));
  const res = f => path.join('build', f);
  return {
    appId: brand.appId,
    productName: brand.name,
    copyright: opt.copyright || brand.copyright || ('Copyright © ' + new Date().getFullYear() + ' ' + brand.publisherShown),
    asar: false,
    electronLanguages: ['en-US'],   // the program is in English only: the other 50-odd Chromium language files are left out
    // what goes into the built program's own package.json (the one in the source folder is left as it is)
    extraMetadata: {
      name: pkgName, productName: brand.name, description: brand.description, author: { name: brand.publisherShown },
      ...(brand.website ? { homepage: brand.website } : {}), ...(opt.version ? { version: opt.version } : {}), ...(opt.brandOverride ? { brandOverride: opt.brandOverride } : {}),
    },
    files: ['main.js', 'preload.js', 'brand.js', 'folders.js', 'server.js', 'ai.js', 'providers/**', 'phone.js', 'update.js', 'desk.js', 'worker.js', 'zip.js', 'public/**', 'icon.png', 'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', ...libraryFiles()],
    directories: { output: out, buildResources: 'build' },
    win: {
      target: ['nsis'],
      icon: 'icon.ico',
      signExecutable: false,          // no certificate yet. The exe still gets its icon, name, version and publisher written in
    },
    nsis: {
      oneClick: false,                // the setup wizard
      perMachine: false,              // for this Windows user only: installs under %LOCALAPPDATA%\Programs, no administrator prompt
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      artifactName: brand.setupPrefix + '${version}.${ext}',
      shortcutName: brand.name,
      uninstallDisplayName: brand.name,   // "Apps & features" shows the version in its own column
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      runAfterFinish: true,
      deleteAppDataOnUninstall: false,    // settings are only removed when the tick box in the uninstaller is ticked
      installerHeader: res('installerHeader.bmp'),
      installerSidebar: res('installerSidebar.bmp'),
      uninstallerSidebar: res('uninstallerSidebar.bmp'),
      include: gen,
      ...(opt.nsis || {}),
    },
  };
};
