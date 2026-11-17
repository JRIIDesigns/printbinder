'use strict';
// Desktop shell: one window around the gallery. The home folder (the library everything is organised into) is chosen once per
// computer and remembered; a portable copy that sits inside the library's own program folder still finds it from where it
// sits. File > Choose home folder changes it.
const { app, BrowserWindow, Menu, dialog, shell, safeStorage, nativeTheme, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
// The program's name, publisher and addresses all come from brand.js — nothing below spells the name out.
const brand = require('./brand.js');
const NAME = brand.name;
app.setName(NAME);   // the settings folder is %APPDATA%\<name>, whether installed or run from source — except:
// THE SETTINGS FOLDER OF AN INSTALL MADE UNDER AN EARLIER NAME IS KEPT, IN PLACE. If %APPDATA%\<a former name> is there, it
// goes on being the settings folder: the home-folder choice, slicers, paired phones, other locations, window size — and the
// saved AI keys, which Windows locks with a key kept in that same folder ("Local State"), so copying the files elsewhere
// would leave them unreadable. Only a computer that never had the program under an earlier name gets %APPDATA%\<name>.
// This is done before the app is ready, and before anything asks where the settings are.
const settingsKept = (() => {
  if (app.commandLine.hasSwitch('user-data-dir')) return null;   // told where to keep them (a test): leave that alone
  const base = app.getPath('appData');
  if (fs.existsSync(path.join(base, NAME, 'config.json'))) return null;   // already settled under today's name
  for (const old of brand.formerNames || []) { if (old && old !== NAME && isDirNow(path.join(base, old))) return path.join(base, old); }
  return null;
})();
if (settingsKept) app.setPath('userData', settingsKept);
function isDirNow(d) { try { return fs.statSync(d).isDirectory(); } catch { return false; } }

const isDir = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
// The folders on this computer that the program must never rename, move, merge away or remove, even when one of them shows up
// inside a library (someone chose their user folder, or a whole drive, as their home library): the user folder and the folders
// Windows keeps in it — asked of Windows itself, because Downloads, Documents and the rest can be relocated (into OneDrive, for
// one) — the app-data folders, OneDrive, Program Files, Windows, the folder the program is installed in and its settings folder.
// A test may hand over its own list in GALLERY_PROTECTED_TEST (a JSON list), which is used instead.
function protectedFolders() {
  if (process.env.GALLERY_PROTECTED_TEST) { try { const j = JSON.parse(process.env.GALLERY_PROTECTED_TEST); if (Array.isArray(j)) return j.filter(x => typeof x === 'string'); } catch {} }
  const out = new Set(), add = p => { if (typeof p === 'string' && p.trim() && path.isAbsolute(p.trim())) out.add(path.resolve(p.trim())); };
  const get = n => { try { return app.getPath(n); } catch { return ''; } };
  const home = get('home');
  add(home);
  if (home) { add(path.dirname(home)); for (const n of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos']) add(path.join(home, n)); }   // their usual places, as well as wherever Windows has them now
  for (const n of ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos', 'appData', 'userData']) add(get(n));
  for (const k of ['USERPROFILE', 'LOCALAPPDATA', 'OneDrive', 'OneDriveConsumer', 'OneDriveCommercial', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'SystemRoot', 'PUBLIC']) add(process.env[k]);
  add(path.dirname(get('exe')));
  if (process.env.PORTABLE_EXECUTABLE_DIR) add(process.env.PORTABLE_EXECUTABLE_DIR);
  return [...out];
}
const readCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
const writeCfg = c => { fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2)); };

let win = null;
// Has this computer used the program before this start (under any of its names)? Then the page offers "What's new" after an
// update rather than the first-time welcome, whatever the browser side remembers.
const returning = !!findRoot();
// p when nothing is listening on 127.0.0.1:p right now, otherwise 0 ("any free port")
const portIfFree = p => new Promise(done => {
  if (!(p >= 1024 && p <= 65535)) return done(0);
  const t = require('net').createServer();
  t.once('error', () => done(0));
  t.listen(p, '127.0.0.1', () => t.close(() => done(p)));
});

// The home folder this computer already has, or null when it has to be asked for.
// An installed copy never takes its home folder from where the program sits. It used to: a program folder named like the
// program's own folder in a library ("PrintBinder") was taken for a copy sitting inside a library, so a fresh install into
// ...\Programs\PrintBinder made ...\Programs the home folder without asking (2.1.0 and 2.1.1). Only the single-file portable
// kind, which sets PORTABLE_EXECUTABLE_DIR, may still be found that way; and a remembered home folder that is the folder the
// program was installed into is that mistake, so it is asked for again.
function findRoot() {
  const cfg = readCfg(), portable = process.env.PORTABLE_EXECUTABLE_DIR;
  const exeDir = path.resolve(portable || path.dirname(app.getPath('exe')));
  // exactly that mistake and nothing wider: someone may really keep a library in a folder that also holds the program further down
  const tookProgramsFolder = d => !portable && path.resolve(d).toLowerCase() === path.dirname(exeDir).toLowerCase() && brand.dataFolders.some(n => path.basename(exeDir).toLowerCase() === n.toLowerCase());
  if (cfg.root && isDir(cfg.root) && !tookProgramsFolder(cfg.root)) return cfg.root;
  if (portable && brand.dataFolders.some(n => path.basename(exeDir).toLowerCase() === n.toLowerCase()) && isDir(path.dirname(exeDir))) return path.dirname(exeDir);
  return null;
}
// a folder that has been a library before, under today's name for the program's own folder or an earlier one
const hasGallery = dir => brand.dataFolders.some(n => { try { return fs.statSync(path.join(dir, n, 'data', 'index.json')).isFile(); } catch { return false; } });
// First start on this computer: say what the app does, then ask for the home folder.
async function firstRun() {
  for (;;) {
    const a = await dialog.showMessageBox({ type: 'info', title: 'Welcome to ' + NAME, buttons: ['Choose home folder…', 'Quit'], defaultId: 0, cancelId: 1, noLink: true,
      message: 'Choose your home folder',
      detail: NAME + ' shows every 3D model you have, with previews, and helps you bring them together into one tidy library.\n\nYour home folder is that library: the folder your 3D print files live in, or an empty folder to start one. It can be on this computer or inside a cloud folder such as Google Drive or Dropbox.\n\nNothing is moved, renamed or removed until you approve it.' });
    if (a.response !== 0) return null;
    const dir = await chooseRoot();
    if (!dir) continue;
    if (hasGallery(dir)) await dialog.showMessageBox({ type: 'info', title: NAME, buttons: ['Continue'], message: 'Found your library', detail: 'This folder has been used with ' + NAME + ' before, so its previews, descriptions and history are picked up as they are.\n\n' + dir });
    return dir;
  }
}
async function chooseRoot() {
  const r = await dialog.showOpenDialog({ title: 'Choose your home folder — where your 3D print files live', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
}
async function changeRoot() {
  const dir = await chooseRoot();
  if (!dir) return;
  writeCfg({ ...readCfg(), root: dir });
  app.relaunch(); app.exit(0);
}

// Light or dark: follows the Windows setting unless the owner picks one here (remembered per computer).
function setTheme(t) {
  nativeTheme.themeSource = t;
  writeCfg({ ...readCfg(), theme: t });
  if (win) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0b1924' : '#f2f5f7');
}
// ---------- About and updates (Help menu). An update is only ever fetched and installed after the owner says so. ----------
const REPO = brand.updateRepo;
let updater = null, updating = false, pending = null, menuRoot = null;   // pending: a newer version found by the quiet check at start
let srv = null;   // the local server behind the page, once it is running
// Test hook: GALLERY_UPDATE_FAKE names a JSON file describing a pretend newer version (update.js reads version, file and slow).
// Three more settings in it drive this window for a test: auto (true: start the update without being asked; "cancel": also press
// Cancel half-way), log (a file the steps are written to) and shot (a file name stem for pictures of the progress window).
// A second, smaller hook tries a REAL update without the pretend version: GALLERY_UPDATE_AUTO=1 starts Help > Check for updates
// by itself once the window is up, with the "version X is available" question already answered yes (the three real places are
// asked, a real installer is fetched and started); GALLERY_UPDATE_LOG names a file the steps are written to.
let fake = null;
try { if (process.env.GALLERY_UPDATE_FAKE) fake = JSON.parse(fs.readFileSync(process.env.GALLERY_UPDATE_FAKE, 'utf8')); } catch {}
const autoUpdate = (fake && fake.auto) || process.env.GALLERY_UPDATE_AUTO === '1', updLogFile = (fake && fake.log) || process.env.GALLERY_UPDATE_LOG || '';
const updLog = (...a) => { if (updLogFile) { try { fs.appendFileSync(updLogFile, a.join(' ') + '\n'); } catch {} } };
const wait = ms => new Promise(r => setTimeout(r, ms));
// A note left just before an installer is started, so that the next start can say whether the update went in.
const updFile = () => path.join(app.getPath('userData'), 'update-pending.json');
// The small window that shows an update arriving: a bar, how much has arrived, and Cancel. It has no access to anything: no
// preload, isolated and sandboxed, and it cannot go to any other page. Cancel is noticed here by the page changing its title.
function updateWindow(version, onCancel) {
  const dark = nativeTheme.shouldUseDarkColors, c = dark ? { bg: '#11222f', ink: '#e9eef3', dim: '#93a4b4', line: '#233849', tile: '#182d3c', btn: '#a6e22e' } : { bg: '#ffffff', ink: '#0b1924', dim: '#5a6877', line: '#d8dee5', tile: '#e7ecf1', btn: '#8fd42a' };
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Updating ${esc(NAME)}</title><style>
    html,body{height:100%;margin:0} body{box-sizing:border-box;border:1px solid ${c.line};background:${c.bg};color:${c.ink};font:14px/1.45 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;padding:18px 20px;display:flex;flex-direction:column;user-select:none;-webkit-app-region:drag;overflow:hidden}
    h3{margin:0 0 10px;font-size:16px} p{margin:8px 0 0;color:${c.dim};font-size:13px;min-height:1.4em}
    .track{height:8px;border-radius:5px;background:${c.tile};overflow:hidden} .track i{display:block;height:100%;width:0;background:linear-gradient(90deg,${c.btn},#5fbdf0);transition:width .25s}
    .track.unknown i{width:35%;animation:slide 1.4s ease-in-out infinite} @keyframes slide{0%{margin-left:-35%}100%{margin-left:100%}}
    .foot{margin-top:auto;display:flex;justify-content:flex-end} button{-webkit-app-region:no-drag;font:inherit;color:inherit;cursor:pointer;border:1px solid ${c.line};background:${c.bg};border-radius:8px;padding:5px 14px}
    button:hover{border-color:${c.btn}}</style></head><body>
    <h3 id="t">Fetching version ${esc(version)}…</h3><div class="track unknown" id="k"><i id="b"></i></div><p id="n">Starting…</p>
    <div class="foot"><button id="c" onclick="this.disabled=true;this.textContent='Stopping…';document.title='pg-cancel'">Cancel</button></div>
    <script>
      const mb = b => (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB', $ = id => document.getElementById(id);
      window.set = (done, total) => { $('k').className = total ? 'track' : 'track unknown'; if (total) $('b').style.width = Math.min(100, Math.round(100 * done / total)) + '%'; $('n').textContent = total ? mb(done) + ' of ' + mb(total) : done ? mb(done) + ' so far' : 'Starting…'; };
      window.say = (title, note) => { $('t').textContent = title; $('n').textContent = note; $('k').className = 'track unknown'; $('b').style.width = ''; $('c').style.display = 'none'; };
    </script></body></html>`;
  const w = new BrowserWindow({ parent: win || undefined, width: 470, height: 196, frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false,
    title: 'Updating ' + NAME, backgroundColor: c.bg, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  w.setMenu(null);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', e => e.preventDefault());
  w.on('page-title-updated', (e, title) => { e.preventDefault(); if (title === 'pg-cancel') onCancel(); });
  w.once('ready-to-show', () => { if (!w.isDestroyed()) w.show(); });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const js = code => w.isDestroyed() ? Promise.resolve() : w.webContents.executeJavaScript(code).catch(() => {});
  return { win: w, js, set: (done, total) => js('set(' + (+done || 0) + ',' + (+total || 0) + ')'), say: (title, note) => js('say(' + JSON.stringify(title) + ',' + JSON.stringify(note) + ')'), close: () => { if (!w.isDestroyed()) w.destroy(); } };
}
// On the start after an update: one line to say it went in — or, when this is still the old version, that it did not.
function afterUpdate() {
  let p = null;
  try { p = JSON.parse(fs.readFileSync(updFile(), 'utf8')); } catch { return false; }
  try { fs.unlinkSync(updFile()); } catch {}
  if (!p || !p.to || !updater) return false;
  const now = app.getVersion();
  if (now === p.to || updater.newer(now, p.from)) { updLog('after-update', 'updated', now); runJs('toast(' + JSON.stringify('Updated to version ' + now) + ')'); return true; }
  updLog('after-update', 'not-updated', now, 'wanted', p.to);
  dialog.showMessageBox(win, { type: 'warning', title: NAME, buttons: ['OK', 'Try again'], defaultId: 0, cancelId: 0, noLink: true,
    message: 'The update did not go in',
    detail: NAME + ' tried to update to version ' + p.to + ', but this is still version ' + now + '. Nothing in your library was changed.\n\nTry again, or download the installer from the Releases page and run it yourself.' })
    .then(a => { if (a.response === 1) checkUpdates(); });
  return true;
}
const runJs = code => win && win.webContents.executeJavaScript(code).catch(() => {});
// Asks the page to open one of its own windows (the guide, what's new, …). The page may be an older one that does not have it
// yet, so the function is looked for first; when it is not there, `otherwise` is done instead (or nothing).
const pageOpen = async (fn, otherwise) => { const done = win ? await win.webContents.executeJavaScript('typeof ' + fn + " === 'function' ? (" + fn + '(), true) : false').catch(() => false) : false; if (!done && otherwise) otherwise(); return done; };
// The licences of the libraries shipped inside the program (made by scripts/make-notices.js before every build).
const noticesFile = () => path.join(__dirname, 'THIRD-PARTY-NOTICES.txt');
const noticesText = () => { try { return fs.readFileSync(noticesFile(), 'utf8'); } catch { return ''; } };
const openNotices = () => pageOpen('openNotices', () => { if (fs.existsSync(noticesFile())) shell.openPath(noticesFile()); });
// Help > Give feedback, when the page has no form of its own: a new email to the address in brand.js, with the version filled in.
const mailFeedback = () => shell.openExternal('mailto:' + brand.feedbackEmail + '?subject=' + encodeURIComponent(NAME + ' ' + app.getVersion() + ' feedback') + '&body=' + encodeURIComponent('\n\n\n' + NAME + ' ' + app.getVersion() + ', Windows ' + require('os').release()));
// About: the name and version, the maker line beside the maker's own logo, the licence, and where things are kept.
// The website line is only there once brand.js has an address.
const licenceFile = () => path.join(__dirname, 'LICENSE');
const licenceText = () => { try { return fs.readFileSync(licenceFile(), 'utf8'); } catch { return ''; } };
const openLicence = () => pageOpen('openLicence', () => { if (fs.existsSync(licenceFile())) shell.openPath(licenceFile()); });
async function about(root) {
  let logo; try { logo = nativeImage.createFromPath(path.join(__dirname, 'public', 'jrii.png')); if (logo.isEmpty()) logo = undefined; } catch {}
  const a = await dialog.showMessageBox(win, { type: 'info', icon: logo, title: 'About ' + NAME, buttons: ['OK', 'Check for updates…', 'Licence', 'Third-party notices'], defaultId: 0, cancelId: 0, noLink: true,
    message: NAME + ' ' + app.getVersion(),
    detail: (brand.maker ? brand.maker + '\n' : '') + brand.description + '.\n\nLicence: ' + brand.licence + '. ' + brand.copyright + '.\nBuilt with open-source libraries; their licences are under Third-party notices.' + (brand.website ? '\n\n' + brand.website : '')
      + '\n\nHome folder: ' + root + '\nInstalled in: ' + path.dirname(app.getPath('exe')) + '\nSettings on this computer: ' + app.getPath('userData') });
  if (a.response === 1) checkUpdates();
  if (a.response === 2) openLicence();
  if (a.response === 3) openNotices();
}
// sure: the owner has already said "update" (the look-only notice), so the "version X is available" question is skipped
async function checkUpdates(sure) {
  sure = sure === true;
  if (updating || !updater) return;
  updating = true;
  const say = t => win && win.webContents.executeJavaScript('toast(' + JSON.stringify(t) + ')').catch(() => {});
  try {
    say('Checking for updates…');
    const c = await updater.check(app.getVersion());
    if (!c.reached) { await dialog.showMessageBox(win, { type: 'warning', title: NAME, buttons: ['OK'], message: 'Could not check for updates', detail: 'You have version ' + c.current + '.\n\nNeither GitHub nor the update folder in your library could be read. Check the internet connection and try again.' }); return; }
    if (!c.newer) { await dialog.showMessageBox(win, { type: 'info', title: NAME, buttons: ['OK'], message: NAME + ' is up to date', detail: 'You have version ' + c.current + ', the newest there is.' }); return; }
    const notes = String(c.notes || '').replace(/\r/g, '').trim().slice(0, 900);
    const a = sure ? { response: 0 } : await dialog.showMessageBox(win, { type: 'question', title: NAME, buttons: ['Update and restart', 'Later'], defaultId: 0, cancelId: 1, noLink: true,
      message: 'Version ' + c.latest + ' is available',
      detail: 'You have version ' + c.current + '.\n\nUpdating closes ' + NAME + ', installs the new version and opens it again. Names typed in Review but not yet approved are cleared, so approve those first.' + (notes ? '\n\nWhat is new:\n' + notes : '') });
    if (a.response !== 0) return;
    // The installer is fetched behind a small window with a progress bar and Cancel.
    const ctl = new AbortController(), uw = updateWindow(c.latest, () => ctl.abort());
    let exe, step = -1, shot = false;
    updLog('fetching', c.latest, 'from', c.pick.source);
    try {
      exe = await updater.fetchInstaller(c.pick, { signal: ctl.signal, onProgress: (done, total) => {
        uw.set(done, total);
        if (win) win.setProgressBar(total ? Math.min(1, done / total) : 2);
        const pct = total ? Math.floor(10 * done / total) : -1;
        if (pct !== step) { step = pct; updLog('progress', done, 'of', total); }
        if (fake && total && done / total >= 0.4) {
          if (fake.shot && !shot) { shot = true; uw.win.webContents.capturePage().then(i => fs.writeFileSync(fake.shot + '-fetching.png', i.toPNG())).catch(() => {}); }
          if (fake.auto === 'cancel' && !ctl.signal.aborted) uw.js("document.getElementById('c').click()");
        }
      } });
    } catch (e) {
      uw.close(); if (win) win.setProgressBar(-1);
      if (e.cancelled) { updLog('cancelled'); say('Update cancelled — nothing was changed.'); return; }
      throw e;
    }
    if (win) win.setProgressBar(-1);
    // From here the installer takes over. It is started without its "silent" switch (/S), so its own progress page shows
    // while it works. "--updated" tells it this is an update: the setup wizard then skips every page that asks or waits for
    // something (Welcome, Licence, Finish), waits for the app that is still closing, and opens the program again by itself
    // (build/installer.nsh). "--force-run" asks the same of the older one-click kind of installer, so either kind can be handed
    // over by any version of the app.
    fs.writeFileSync(updFile(), JSON.stringify({ from: app.getVersion(), to: c.latest, at: Date.now() }));
    await uw.say('Installing version ' + c.latest, NAME + ' will close and reopen by itself in about a minute.');
    uw.win.setAlwaysOnTop(true);
    updLog('installing', c.latest, path.basename(exe));
    if (fake && fake.shot) { await wait(400); await uw.win.webContents.capturePage().then(i => fs.writeFileSync(fake.shot + '-installing.png', i.toPNG())).catch(() => {}); }
    await wait(3000);   // long enough to be read before the window goes
    require('child_process').spawn(exe, ['--updated', '--force-run'], { detached: true, stdio: 'ignore' }).on('error', e => updLog('installer-start-failed', e.code || e.message)).unref();
    updLog('quit');
    app.quit();
  } catch (e) {
    if (win) win.setProgressBar(-1);
    dialog.showMessageBox(win, { type: 'error', title: NAME, buttons: ['OK'], message: 'The update did not go through', detail: 'Nothing was changed; you still have version ' + app.getVersion() + '.\n\n' + String(e && e.message || e).split('\n')[0] });
  } finally { updating = false; }
}
// What the page is showing (picture size, layout, sort), so the View menu carries the same ticks. The page reports it (preload.js).
let view = { size: 'm', layout: 'all', sort: 'name', rev: false };
const SIZES = [['xl', 'Extra large pictures'], ['l', 'Large pictures'], ['m', 'Medium pictures'], ['s', 'Small pictures'], ['d', 'Details list']];
const SORTS = [['name', 'Name'], ['new', 'Date modified'], ['added', 'Date added'], ['big', 'Size'], ['type', 'File type'], ['folder', 'Folder'], ['colour', 'Colour'], ['dim', 'Printed size'], ['parts', 'Number of parts'], ['designer', 'Designer'], ['desc', 'Described or not'], ['prob', 'Preview problem']];
function tickView() {
  const m = Menu.getApplicationMenu();
  if (!m) return;
  const on = (id, v) => { const it = m.getMenuItemById(id); if (it) it.checked = v; };
  if (SIZES.some(s => s[0] === view.size)) on('size-' + view.size, true);
  if (SORTS.some(s => s[0] === view.sort)) on('sort-' + view.sort, true);
  on(view.layout === 'tiles' ? 'layout-tiles' : 'layout-all', true);
  on('sort-rev', !!view.rev);
}
// Drag a file out of the window (to the desktop, an Explorer folder, a slicer). The page says which library files; where they
// are on this computer is worked out here, and only files that are on show in the gallery are ever handed to Windows.
// GALLERY_DRAG_TEST (a file name) is a test hook: what would be dragged is written there and no drag is started — a drag begun
// while no mouse button is held would drop the file wherever the pointer happens to be.
ipcMain.on('pg-drag', (e, list) => {
  if (!win || e.sender !== win.webContents || !Array.isArray(list) || !srv) return;
  const found = list.slice(0, 500).map(p => srv.fileOnShow(String(p))).filter(f => f && fs.existsSync(f.abs));
  const test = process.env.GALLERY_DRAG_TEST;
  let icon = null;   // what follows the pointer: the file's preview picture, or the app's own icon
  try { if (found.length && found[0].thumb) icon = nativeImage.createFromBuffer(fs.readFileSync(found[0].thumb)).resize({ width: 96 }); } catch {}
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 64 });
  if (test) { try { fs.appendFileSync(test, JSON.stringify({ asked: list.length, files: found.map(f => f.abs), icon: icon.isEmpty() ? null : icon.getSize() }) + '\n'); } catch {} return; }
  if (!found.length) return;
  try { e.sender.startDrag({ file: found[0].abs, files: found.map(f => f.abs), icon }); }
  catch (err) { srv.log('drag out failed', err.message); }
});
ipcMain.on('pg-view', (e, v) => {
  if (!win || e.sender !== win.webContents || !v || typeof v !== 'object') return;
  view = { size: String(v.size), layout: String(v.layout), sort: String(v.sort), rev: !!v.rev };
  tickView();
});
function buildMenu(root) {
  menuRoot = root;
  const theme = ['light', 'dark'].includes(readCfg().theme) ? readCfg().theme : 'system';
  const js = code => win ? win.webContents.executeJavaScript(code).catch(() => {}) : Promise.resolve();
  // The Edit menu and the keys beside its items. The keys are only shown here, never taken by the menu (registerAccelerator: false):
  // the page deals with them, so that Ctrl+C, Ctrl+V, Ctrl+X, Ctrl+Z and Ctrl+A keep their ordinary meaning in a text box.
  // Chosen with the mouse, an item asks the page first; when the cursor is in a text box the page answers 'text' and the
  // ordinary text command is carried out instead.
  const TEXT = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste', selectAll: 'selectAll' };
  const edit = cmd => async () => { const r = await js('PG.menu(' + JSON.stringify(cmd) + ')'); if (r === 'text' && TEXT[cmd] && win) win.webContents[TEXT[cmd]](); };
  const item = (label, accelerator, click, more) => ({ label, accelerator, registerAccelerator: false, click, ...more });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Rescan now', accelerator: 'F5', click: () => js('rescanNow()') },
      { label: 'Open library in Explorer', click: () => shell.openPath(root) },
      { label: 'Locations…', accelerator: 'CmdOrCtrl+L', click: () => js('openLocations()') },
      { label: 'Phone access…', click: () => js('openPhone()') },
      { label: 'Slicers…', click: () => js('openSlicers()') },
      { label: 'Choose home folder…', click: changeRoot },
      { label: 'AI assistant…', accelerator: 'CmdOrCtrl+K', click: () => js('toggleAI(true)') },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Edit', submenu: [
      item('Undo', 'CmdOrCtrl+Z', edit('undo')),
      item('Redo', 'CmdOrCtrl+Y', edit('redo')),
      { type: 'separator' },
      item('Cut', 'CmdOrCtrl+X', edit('cut')),
      item('Copy', 'CmdOrCtrl+C', edit('copy')),
      item('Paste', 'CmdOrCtrl+V', edit('paste')),
      { type: 'separator' },
      item('Select all', 'CmdOrCtrl+A', edit('selectAll')),
      { label: 'Invert selection', click: edit('invert') },
      { type: 'separator' },
      item('Find', 'CmdOrCtrl+F', edit('find')),
    ] },
    { label: 'View', submenu: [
      ...SIZES.map(([v, label], i) => item(label, 'CmdOrCtrl+Shift+' + (i + 1), () => js('setSize(' + JSON.stringify(v) + ')'), { id: 'size-' + v, type: 'radio', checked: view.size === v })),
      { type: 'separator' },
      { label: 'Sort by', submenu: [
        ...SORTS.map(([v, label]) => ({ id: 'sort-' + v, label, type: 'radio', checked: view.sort === v, click: () => js('setSort(' + JSON.stringify(v) + ', false)') })),
        { type: 'separator' },
        { id: 'sort-rev', label: 'Reverse order', type: 'checkbox', checked: !!view.rev, click: () => js('setSort(S.sort, !S.rev)') },
      ] },
      { type: 'separator' },
      { id: 'layout-tiles', label: 'Subfolders as folders to open', type: 'radio', checked: view.layout === 'tiles', click: () => js("setLayout('tiles')") },
      { id: 'layout-all', label: 'Subfolders’ files under headings', type: 'radio', checked: view.layout !== 'tiles', click: () => js("setLayout('all')") },
      { type: 'separator' },
      { label: 'Hidden folders…', click: () => js('openHidden()') },
      item('Refresh', 'F5', () => js('rescanNow()')),
      { type: 'separator' },
      { label: 'Theme', submenu: [
        { label: 'Follow Windows', type: 'radio', checked: theme === 'system', click: () => setTheme('system') },
        { label: 'Light', type: 'radio', checked: theme === 'light', click: () => setTheme('light') },
        { label: 'Dark', type: 'radio', checked: theme === 'dark', click: () => setTheme('dark') },
      ] },
      { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'reload' }, { role: 'toggleDevTools' },
    ] },
    // Help: the first group opens windows that belong to the page (asked for through pageOpen, which looks before it calls)
    { label: 'Help', submenu: [
      { label: 'Guide', click: () => pageOpen('openHelp') },
      { label: 'Keyboard shortcuts', click: () => pageOpen('openShortcuts') },
      { label: 'What’s new', click: () => pageOpen('openWhatsNew') },
      { label: 'Privacy', click: () => pageOpen('openPrivacy') },
      ...(brand.feedbackEmail ? [{ label: 'Give feedback…', click: () => pageOpen('openFeedback', mailFeedback) }] : []),   // only once there is an address to send it to
      { label: 'Licence', click: () => openLicence() },
      { label: 'Third-party notices', click: () => openNotices() },
      { type: 'separator' },
      pending ? { label: 'Install version ' + pending.latest + '…', click: () => checkUpdates() } : { label: 'Check for updates…', click: () => checkUpdates() },
      { type: 'separator' },
      { label: 'About ' + NAME, click: () => about(root) },
    ] },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    let root = findRoot();
    if (!root) {
      root = await firstRun();
      if (!root) return app.quit();
    }
    if (readCfg().root !== root) writeCfg({ ...readCfg(), root });   // remembered on this computer, wherever the program itself is installed
    process.env.GALLERY_ROOT = root;
    process.env.GALLERY_LOCFILE = path.join(app.getPath('userData'), 'locations.json');   // other locations are per computer
    process.env.GALLERY_PHONEFILE = path.join(app.getPath('userData'), 'phone.json');   // phone access: the switch and the paired devices, per computer
    process.env.GALLERY_SLICERFILE = path.join(app.getPath('userData'), 'slicers.json');   // which slicers are installed where: per computer
    process.env.GALLERY_PROTECTED = JSON.stringify(protectedFolders());   // folders Windows and other programs depend on: never renamed, moved or removed (server.js, keptWhy)
    // The page is served on this PC only, on a port of its own. The port is chosen freely the first time and then KEPT (in
    // config.json): what the page remembers for this device — the view, and that the welcome and the news have been seen — is
    // filed by the browser under the page's address, port included, so a new port at every start would forget it every time.
    // If the remembered port is taken by something else at this moment, any free one is used for this run.
    process.env.GALLERY_PORT = String(await portIfFree(+readCfg().port || 0));
    let port;
    try { srv = require('./server.js'); port = await srv.ready; }
    catch (e) { dialog.showErrorBox(NAME + ' could not start', 'Folder: ' + root + '\n\n' + (e && e.message)); return app.quit(); }
    if (!+readCfg().port) writeCfg({ ...readCfg(), port });
    srv.hooks.returning = () => returning;
    // what the page may know about who makes the program (brand.js), and the licences of the libraries inside it
    srv.hooks.brand = () => ({ name: brand.name, shortName: brand.shortName, maker: brand.maker, publisher: brand.publisher, licence: brand.licence, copyright: brand.copyright, feedbackEmail: brand.feedbackEmail, website: brand.website });
    srv.hooks.notices = () => noticesText();
    srv.hooks.licence = () => licenceText();
    // one line in the library's log saying which folders this start is using (never anything from inside them)
    srv.log(NAME + ' ' + app.getVersion() + ' | settings folder: ' + app.getPath('userData') + (settingsKept ? ' (kept from an earlier name)' : '') + ' | program folder in the library: ' + srv.APPDIR);
    srv.hooks.openPath = p => shell.openPath(p);
    srv.hooks.reveal = p => shell.showItemInFolder(p);
    srv.hooks.pickFolder = async () => { const r = await dialog.showOpenDialog(win, { title: 'Choose a folder to show in the gallery', properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; };
    srv.hooks.pickExe = async () => { const r = await dialog.showOpenDialog(win, { title: 'Choose your slicer’s program file', defaultPath: process.env.ProgramFiles, properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] }); return r.canceled ? null : r.filePaths[0]; };
    // Start-menu shortcuts: how slicers installed in unusual places are found
    srv.hooks.shortcuts = async () => {
      const out = [], walk = (dir, depth) => {
        let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (depth > 0) walk(p, depth - 1); }
          else if (/\.lnk$/i.test(e.name)) { try { const t = shell.readShortcutLink(p).target; if (t) out.push({ name: e.name.replace(/\.lnk$/i, ''), target: t }); } catch {} }
        }
      };
      walk(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 3);
      walk(path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 3);
      return out;
    };
    srv.hooks.update = () => { checkUpdates(!!srv.outdated); };
    srv.hooks.updateInfo = () => pending;
    srv.hooks.prefs = { get: () => readCfg().prefs || {}, set: p => writeCfg({ ...readCfg(), prefs: p }) };
    // the mic button: press Win+H for the owner, which opens Windows' own voice typing in the box that has the cursor
    srv.hooks.dictate = () => {
      const ps = "$t = Add-Type -PassThru -Namespace PG -Name Keys -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte v, byte s, uint f, System.UIntPtr e);'; $z = [System.UIntPtr]::Zero; $t::keybd_event(0x5B,0,0,$z); $t::keybd_event(0x48,0,0,$z); $t::keybd_event(0x48,0,2,$z); $t::keybd_event(0x5B,0,2,$z)";
      require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    };
    // The Claude API key lives on this computer only, encrypted by Windows for this user — never in the shared library folder.
    // One key per assistant (Claude, ChatGPT, Gemini), each in its own file. Claude's keeps the name it has always had.
    const keyFile = p => path.join(app.getPath('userData'), ({ anthropic: 'claude', openai: 'openai', google: 'gemini' }[p] || 'claude') + '-key.bin');
    const keyTrouble = new Set();
    srv.hooks.secret = {
      perProvider: true,
      get: (p = 'anthropic') => {
        let b;
        try { b = fs.readFileSync(keyFile(p)); } catch { return ''; }   // no key has been saved for this assistant
        try { const k = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString('utf8'); keyTrouble.delete(p); return k; }
        catch (e) {   // a saved key that Windows would not unlock: noted in the log (once, and never the key itself); it is asked for again the next time it is needed
          if (!keyTrouble.has(p)) { keyTrouble.add(p); srv.log('saved key not unlocked:', path.basename(keyFile(p)), '(' + b.length + ' bytes)', 'encryption available: ' + safeStorage.isEncryptionAvailable(), 'error: ' + String((e && (e.code || e.name)) || 'unknown')); }
          return '';
        }
      },
      set: (p, v) => { if (!v) { try { fs.unlinkSync(keyFile(p)); } catch {} return; } fs.writeFileSync(keyFile(p), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(v) : Buffer.from(v, 'utf8')); },
    };
    updater = require('./update.js')({ repo: REPO, libDir: path.join(root, srv.APPDIR), tmpDir: app.getPath('temp') });   // srv.APPDIR: the program's own folder in THIS library, whichever of its names it has
    const cfg = readCfg();
    if (['light', 'dark'].includes(cfg.theme)) nativeTheme.themeSource = cfg.theme;
    buildMenu(root);
    win = new BrowserWindow({
      width: (cfg.win && cfg.win.w) || 1500, height: (cfg.win && cfg.win.h) || 950, minWidth: 720, minHeight: 480,
      title: NAME, icon: path.join(__dirname, 'icon.png'), backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b1924' : '#f2f5f7', show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.js') },
    });
    if (cfg.win && cfg.win.max) win.maximize();
    win.once('ready-to-show', () => win.show());
    nativeTheme.on('updated', () => { if (win) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0b1924' : '#f2f5f7'); });
    win.on('page-title-updated', e => e.preventDefault());
    win.on('close', () => { try { const [w, h] = win.getNormalBounds ? [win.getNormalBounds().width, win.getNormalBounds().height] : win.getSize(); writeCfg({ ...readCfg(), win: { w, h, max: win.isMaximized() } }); } catch {} });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('http://127.0.0.1:' + port + '/')) e.preventDefault(); });
    // right-click in any text box: the usual Cut / Copy / Paste menu; on selected text elsewhere: Copy
    win.webContents.on('context-menu', (e, p) => {
      const f = p.editFlags || {}, sel = !!(p.selectionText && p.selectionText.trim());
      let items = null;
      if (p.isEditable) items = [
        { role: 'undo', enabled: !!f.canUndo }, { role: 'redo', enabled: !!f.canRedo }, { type: 'separator' },
        { role: 'cut', enabled: !!f.canCut }, { role: 'copy', enabled: !!f.canCopy }, { role: 'paste', enabled: !!f.canPaste }, { role: 'delete', enabled: !!f.canDelete },
        { type: 'separator' }, { role: 'selectAll', enabled: !!f.canSelectAll },
      ];
      else if (sel) items = [{ role: 'copy' }];
      if (items) Menu.buildFromTemplate(items).popup({ window: win });
    });
    win.loadURL('http://127.0.0.1:' + port + '/');
    win.webContents.once('did-finish-load', () => { const was = afterUpdate(); if (autoUpdate && !was) { updLog('auto-start'); checkUpdates(true); } });
    if (process.env.GALLERY_TEST_ABOUT === '1') win.once('show', () => setTimeout(() => about(root), 1500));   // test hook: Help > About opens by itself, to be looked at
    // An older copy than the one that last worked on this library: say so before anything else, and only look until updated.
    if (srv.outdated) win.once('show', async () => {
      const a = await dialog.showMessageBox(win, { type: 'warning', title: NAME, buttons: ['Update now', 'Look only'], defaultId: 0, cancelId: 1, noLink: true,
        message: 'This copy of ' + NAME + ' is out of date',
        detail: 'This library was last used with ' + NAME + ' ' + srv.outdated.theirs + '. This computer has ' + srv.outdated.mine + '.\n\nUntil it is updated it only looks: you can browse and view, but nothing can be moved, renamed, approved or sent to an AI.' });
      if (a.response === 0) checkUpdates(true);
    });
    // A quiet look for a newer version shortly after start. It only shows a notice; installing still waits for a press.
    setTimeout(async () => {
      try { const c = await updater.check(app.getVersion()); if (c.reached && c.newer) { pending = { latest: c.latest }; buildMenu(menuRoot); runJs('loadAbout()'); } } catch {}
    }, 8000);
  });
}
