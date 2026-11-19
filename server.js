'use strict';
// PrintBinder — the local web page and review list for a 3D printing library.
// Safety rules baked in:
//   * Listens on this PC only (127.0.0.1). Phone access, when the owner switches it on, adds a second listener for paired
//     devices on the home network (phone.js).
//   * Scanning and previewing only READ files.
//   * The only code that moves a file is applySuggestion()/undo(), reached only by an approve/undo click.
//   * "Remove" never deletes: it moves the file into "<root>/_Removed by Gallery" so it can be undone.
//   * The optional Claude features (ai.js) can only describe previews and ADD suggestions; they go through the same approve step.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');
const os = require('os');
const zip = require('./zip.js');

const folders = require('./folders.js');   // is a chosen folder too broad to be a home folder or a location?
const brand = require('./brand.js');   // the program's name, and the names of its own folder inside a library
const ROOT = process.env.GALLERY_ROOT;   // the home library: chosen per computer by the desktop shell
if (!ROOT) throw new Error('No home folder was given (GALLERY_ROOT).');
// The program's own folder inside the library: holds the shared index, previews, descriptions and history (and "updates").
// It has had two names. A library keeps the one it already has ("Print Gallery" for every library made before the program was
// renamed); a library with neither gets today's name. Chosen once, here, at start — see libraryFolder in brand.js.
// Whichever is in use, BOTH names (APPDIRS) are the program's own at the top of a library: never listed, never a place to
// move, copy, rename or unpack into, and never watched.
const APPDIRS = brand.dataFolders, APPDIR = brand.libraryFolder(ROOT);
const ownTop = name => { const t = String(name || '').split(/[\\/]/)[0].toLowerCase(); return t === TRASH.toLowerCase() || APPDIRS.some(n => n.toLowerCase() === t); };   // a top-level name that belongs to the program
let PORT = process.env.GALLERY_PORT !== undefined ? +process.env.GALLERY_PORT : 3838;
const DATA = process.env.GALLERY_DATA || path.join(ROOT, APPDIR, 'data');
const hooks = {};   // the desktop shell plugs in openPath / reveal
const THUMBS = path.join(DATA, 'thumbs');
const TRASH = '_Removed by Gallery';
fs.mkdirSync(THUMBS, { recursive: true });

const MODEL = new Set(['stl', '3mf', 'obj', 'step', 'stp']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'heic', 'heif']);
const VIDEO = new Set(['mp4', 'mov', 'webm', 'm4v']);
const HEIC = new Set(['heic', 'heif']);
const SKIP_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
const DUP_SKIP = new Set(['json', 'txt', 'mtl', 'md', 'ini', 'cfg', 'info']);
const OPENABLE = new Set([...MODEL, ...IMAGE, ...VIDEO, 'pdf', 'f3d', 'blend', 'gcode', 'zip', 'xlsx', 'txt', 'md', '3dm', 'skp']);
const MIME = {
  html: 'text/html; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  m4v: 'video/mp4', pdf: 'application/pdf',
};

const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const extOf = p => { const m = /\.([^./\\]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; };
const baseOf = p => p.slice(p.lastIndexOf('/') + 1);
const dirOf = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
// ---------- locations: the home library and, later, other folders shown alongside it ----------
// A path inside the home library is written as it always was ("My Designs/part.stl"). A path in another location starts
// with ":<location name>/". A colon cannot appear in a Windows file name, so the two can never be confused, and nothing
// already stored about home files (previews, descriptions, history) has to change.
const LOCS = [{ name: path.basename(ROOT) || ROOT, root: ROOT, home: true }];
// Other locations are remembered on this computer only (a Downloads folder means something different on every PC).
const LOCFILE = process.env.GALLERY_LOCFILE || path.join(process.env.GALLERY_LOCAL || path.join(require('os').homedir(), '.print-gallery'), 'locations.json');
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (inner, outer) => { const r = path.relative(path.resolve(outer), path.resolve(inner)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const saveLocs = () => { try { fs.mkdirSync(path.dirname(LOCFILE), { recursive: true }); fs.writeFileSync(LOCFILE, JSON.stringify(LOCS.filter(l => !l.home && !l.usb).map(l => ({ name: l.name, root: l.root, home: ROOT })), null, 2)); } catch (e) { log('locations save', e.message); } };
try {
  for (const l of JSON.parse(fs.readFileSync(LOCFILE, 'utf8'))) {
    if (!l || typeof l.name !== 'string' || typeof l.root !== 'string' || /[\\/:*?"<>|]/.test(l.name)) continue;
    if (l.home && !sameDir(l.home, ROOT)) continue;   // listed for a different home folder
    if (within(l.root, ROOT) || within(ROOT, l.root) || LOCS.some(x => x.name.toLowerCase() === l.name.toLowerCase())) continue;
    LOCS.push({ name: l.name, root: path.resolve(l.root) });
  }
} catch {}
const isLocRoot = rel => rel[0] === ':' && !rel.includes('/');
const isTop = rel => rel === '' || isLocRoot(rel);
function locOf(rel) {
  if (rel[0] !== ':') return { loc: LOCS[0], sub: rel };
  const i = rel.indexOf('/'), name = (i < 0 ? rel : rel.slice(0, i)).slice(1).toLowerCase();
  const loc = LOCS.find(l => !l.home && l.name.toLowerCase() === name);
  return loc ? { loc, sub: i < 0 ? '' : rel.slice(i + 1) } : null;
}
const absOf = rel => { const r = locOf(rel); if (!r) throw new Error('That location is not connected.'); return r.sub ? path.join(r.loc.root, ...r.sub.split('/')) : r.loc.root; };
// ---------- folders that are left alone ----------
// Some folders are not the program's to rename, move, merge away or remove, because Windows or the owner's other programs expect
// to find them where they are: the user folder and its Desktop, Documents, Downloads, Music, Pictures and Videos (wherever
// Windows has them — they can be relocated, into OneDrive for one), the app-data folders, OneDrive, Program Files, Windows
// itself, the folder this program is installed in and its settings folder. The desktop shell works the list out from Windows and
// hands it over in GALLERY_PROTECTED (a JSON list, or paths separated by ";"); without it — a test — the list is worked out
// here from the environment. Always on the list as well: any drive's top folder, the home library's own folder, every other
// location's own folder, and inside each of those the removed-files folder and the program's own folder.
// The rule (keptWhy): an action that would rename, move, merge away or remove folder F is refused when F IS one of these or
// CONTAINS one. Everything INSIDE such a folder stays fully usable: files and ordinary subfolders can be moved out, things can
// be moved in, and new folders made there. Paths are compared without regard to capitals, as Windows does, both as written and
// as Windows resolves them (short 8.3 names, links).
const keptKey = p => path.resolve(String(p)).toLowerCase();
const keptSep = k => k.endsWith(path.sep) ? k : k + path.sep;
const keptKeys = p => { const a = keptKey(p), out = [a]; try { const r = fs.realpathSync.native(path.resolve(String(p))).toLowerCase(); if (r !== a) out.push(r); } catch {} return out; };
function keptDefaults() {
  const e = process.env, home = os.homedir(), out = [];
  if (home) out.push(home, path.dirname(home), ...['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'].map(n => path.join(home, n)));
  for (const k of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'OneDrive', 'OneDriveConsumer', 'OneDriveCommercial', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'SystemRoot', 'PUBLIC']) if (e[k]) out.push(e[k]);
  out.push(__dirname, e.GALLERY_LOCAL || path.join(home || '.', '.print-gallery'));
  return out;
}
const KEPT_GIVEN = (() => {   // the list as the desktop shell handed it over, or null
  let list = null;
  const raw = process.env.GALLERY_PROTECTED;
  if (typeof raw === 'string' && raw.trim()) {
    try { const j = JSON.parse(raw); if (Array.isArray(j)) list = j; } catch {}
    if (!list) list = raw.split(';');
  }
  return list;
})();
const KEPT_LIST = KEPT_GIVEN || keptDefaults();
const KEPT = (() => {
  const list = KEPT_LIST;
  const seen = new Set(), out = [];
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim() || p.includes('\0') || !path.isAbsolute(p.trim())) continue;
    const keys = keptKeys(p.trim()).filter(k => !seen.has(k));
    if (!keys.length) continue;
    keys.forEach(k => seen.add(k));
    out.push({ kind: 'windows', name: path.basename(path.resolve(p.trim())) || path.resolve(p.trim()), keys });
  }
  return out;
})();
const keptRoots = new Map();   // a location's folder -> its keys, looked up once
function keptList() {
  const out = KEPT.slice();
  const add = (kind, abs) => { let keys = keptRoots.get(abs); if (!keys) { keys = keptKeys(abs); if (keptRoots.size < 500) keptRoots.set(abs, keys); } out.push({ kind, name: path.basename(abs) || abs, keys }); };
  for (const l of LOCS) {
    add(l.home ? 'home' : 'loc', l.root);
    for (const n of [TRASH, ...APPDIRS]) add('own', path.join(l.root, n));
  }
  return out;
}
// null when the folder may be renamed, moved or removed; otherwise what it is: { self: it is one itself (false: it holds one), kind, name }
function keptHit(abs) {
  const keys = keptKeys(abs), list = keptList();
  for (const k of keys) if (keptSep(path.parse(k).root) === keptSep(k)) return { self: true, kind: 'drive', name: k.toUpperCase() };
  for (const k of keys) for (const p of list) if (p.keys.includes(k)) return { self: true, kind: p.kind, name: p.name };
  for (const k of keys) { const ks = keptSep(k); for (const p of list) if (p.keys.some(x => x.startsWith(ks))) return { self: false, kind: p.kind, name: p.name }; }
  return null;
}
// The same, as the sentence the owner is shown ('' when the folder is free to change).
function keptWhy(abs) {
  let h = null;
  try { h = keptHit(abs); } catch (e) { log('folder check', e.message); return 'That folder could not be checked, so it was left alone.'; }
  if (!h) return '';
  const app = brandOf().name, me = path.basename(path.resolve(abs)) || path.resolve(abs), q = n => '\u201c' + n + '\u201d';
  const what = { windows: 'a folder Windows and your other programs use', drive: 'a whole drive', home: 'your home library folder', loc: 'one of the places ' + app + ' shows', own: 'a folder ' + app + ' keeps for itself' }[h.kind];
  return (h.self ? q(me) + ' is ' + what : q(me) + ' holds ' + (h.kind === 'home' || h.kind === 'drive' ? what : q(h.name) + ', ' + what)) + ', so ' + app + ' leaves its name and place alone. The files inside it can still be moved.';
}
// ---------- folders that are too broad to choose (folders.js) ----------
// The same list, sorted into kinds: a whole drive, a whole user folder, AppData, Program Files, Windows and the program's own
// folders cannot be added as a location at all; Documents, Desktop, Pictures, Music, Videos and a cloud drive's top folder can,
// after a question. The desktop shell says which folder is which in GALLERY_FOLDER_KINDS ({ folder: kind }, asked of Windows).
// With a list but no kinds, the kinds are told from the names. With neither — a test, or the server started by hand — both come
// from the environment, and the temp folder is not counted as part of AppData (that is where tests keep their made-up libraries).
const CHOICE = (() => {
  let kinds = null;
  try { const j = JSON.parse(process.env.GALLERY_FOLDER_KINDS || ''); if (j && typeof j === 'object' && !Array.isArray(j)) kinds = j; } catch {}
  const bare = !KEPT_GIVEN && !kinds;
  if (bare) kinds = { ...folders.hintsFromEnv(process.env, os.homedir()), [__dirname]: 'own', [process.env.GALLERY_LOCAL || path.join(os.homedir() || '.', '.print-gallery')]: 'own' };
  return folders.build(KEPT_LIST, kinds || {}, { except: bare ? [os.tmpdir()] : [] });
})();
const choiceOf = (dir, use, more) => folders.check(dir, use, CHOICE, brandOf().name, more);
// An install from before this rule may already have such a folder as its home folder or as a location. It keeps working; the
// window says so once, with a way to choose another home folder or to take the location off the list. Nothing is done by itself.
function broadNotes() {
  const out = [], app = brandOf().name;
  const one = (l, use) => {
    try {
      const c = folders.classify(l.root, use, CHOICE);
      if (c.level === 'refuse') out.push({ use, name: l.home ? '' : l.name, path: c.path, kind: c.kind, ...folders.noticeText(c, app, l.name) });
    } catch (e) { log('folder check', e.message); }
  };
  for (const l of LOCS) if (l.home) one(l, 'home'); else if (!l.usb) one(l, 'location');
  return out;
}
const keptRel = rel => { try { return keptWhy(absOf(rel)); } catch { return ''; } };
// For the window: which of the listed folders are left alone, so it does not offer what would be refused. Worked out from the
// list itself, with no look at the disk for each folder (the refusal above is the real guard).
let keptCache = null;
function keptDirs(sc) {
  if (!sc) return [];
  const stamp = LOCS.map(l => l.root).join('|');
  if (keptCache && keptCache.of === sc.dirs && keptCache.stamp === stamp) return keptCache.v;
  const set = new Set();
  for (const l of LOCS) {
    const pre = l.home ? '' : ':' + l.name.toLowerCase() + '/';
    for (const rk of keptRoots.get(l.root) || keptKeys(l.root)) {
      const rs = keptSep(rk);
      for (const p of KEPT) for (const k of p.keys) {
        if (!k.startsWith(rs)) continue;
        const parts = k.slice(rs.length).split(path.sep).filter(Boolean);
        for (let i = 1; i <= parts.length; i++) set.add(pre + parts.slice(0, i).join('/'));
      }
    }
  }
  const v = set.size ? sc.dirs.filter(d => set.has(d.toLowerCase())) : [];
  keptCache = { of: sc.dirs, stamp, v };
  return v;
}
const kindOf = ext => MODEL.has(ext) ? 'm' : (IMAGE.has(ext) || VIDEO.has(ext)) ? 'i' : 'o';
const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- which version of the app last worked on this library ----------
// The shared data folder remembers the newest version that has used it. An older copy that opens the library afterwards only
// looks: it writes nothing to the shared data and refuses every change until it has been updated.
const VERSION = process.env.GALLERY_FAKE_VERSION || require('./package.json').version;
const vnum = v => String(v || '').split('.').map(n => parseInt(n, 10) || 0);
const vcmp = (a, b, n = 3) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < n; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; return 0; };
let lastUsed = null;
try { lastUsed = JSON.parse(fs.readFileSync(path.join(DATA, 'app-version.json'), 'utf8')); } catch {}
const OUTDATED = !!(lastUsed && lastUsed.version && vcmp(lastUsed.version, VERSION, 2) > 0);   // judged on the first two numbers: a small fix release does not lock other computers out
if (!OUTDATED && (!lastUsed || vcmp(VERSION, lastUsed.version) > 0)) { try { fs.writeFileSync(path.join(DATA, 'app-version.json'), JSON.stringify({ version: VERSION, at: Date.now(), computer: require('os').hostname() })); } catch {} }
const RO_OK = /^\/api\/(prefs$|phone\/|reveal$|open$|dictate$|slicers\/|update\/start$|usb\/dismiss$)/;   // what a look-only copy may still do: nothing that touches the library

function log(...a) {
  if (OUTDATED) return;
  const line = new Date().toISOString() + ' ' + a.join(' ') + '\n';
  try {
    const f = path.join(DATA, 'server.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 2e6) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, line);
  } catch {}
}
process.on('uncaughtException', e => log('uncaught', e.stack || e));
process.on('unhandledRejection', e => log('unhandled', (e && e.stack) || e));

// ---------- persistent state ----------
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { if (OUTDATED) return; const p = path.join(DATA, f); fs.writeFileSync(p + '.tmp', JSON.stringify(v)); fs.renameSync(p + '.tmp', p); };
const state = readJSON('state.json', { dismissed: [], history: [] });
const saveState = () => writeJSON('state.json', state);
// another computer may have written the shared file since we last looked
const refreshState = () => { const d = readJSON('state.json', null); if (d) { state.dismissed = d.dismissed || []; state.history = d.history || []; } };
// ---------- hidden folders: the owner's list of folders the gallery leaves out (shared, so every computer and the phone agree) ----------
// Hiding touches no file. A hidden folder and everything under it is left out of what the window, the Review list and the AI
// features are given; the scan itself still sees it, so nothing is forgotten and unhiding brings it straight back.
let hidden = [], hidAt = 0, hidRev = '', viewCache = null;
function loadHidden(force) {   // another computer may have changed the list: look again every few seconds
  if (!force && Date.now() - hidAt < 4000) return;
  hidAt = Date.now();
  const d = readJSON('hidden.json', null);
  const list = d && Array.isArray(d.dirs) ? d.dirs.filter(x => typeof x === 'string' && x && !x.includes('\0')) : [];
  if (list.join('\n') !== hidRev) { hidden = list; hidRev = list.join('\n'); viewCache = null; }
}
function saveHidden() { writeJSON('hidden.json', { dirs: hidden }); hidRev = hidden.join('\n'); hidAt = Date.now(); viewCache = null; }
const hiddenIn = p => { if (!hidden.length || typeof p !== 'string') return false; const l = p.toLowerCase(); return hidden.some(h => { const x = h.toLowerCase(); return l === x || l.startsWith(x + '/'); }); };
// The scan as the owner sees it: without the hidden folders. With nothing hidden it is the scan itself.
function visible(sc) {
  if (!sc) return sc;
  loadHidden();
  if (!hidden.length) return sc;
  if (viewCache && viewCache.of === sc && viewCache.rev === hidRev) return viewCache.v;
  const hs = hidden.map(h => h.toLowerCase()), memo = new Map(), all = new Set(sc.dirs.map(d => d.toLowerCase()));
  const hid = d => { let r = memo.get(d); if (r === undefined) { const l = d.toLowerCase(); r = hs.some(x => l === x || l.startsWith(x + '/')); memo.set(d, r); } return r; };
  const v = { ...sc, files: sc.files.filter(f => !hid(dirOf(f.p))), dirs: sc.dirs.filter(d => !hid(d)), sig: sha(sc.sig + '#hidden#' + hidRev), hiddenN: hs.filter(x => all.has(x)).length };
  viewCache = { of: sc, rev: hidRev, v };
  return v;
}
// a folder that was renamed or moved keeps its place on the list (and so does a hidden folder inside it)
function hiddenFollow(from, to) {
  loadHidden();
  if (!hidden.length) return;
  const f = from.toLowerCase();
  let changed = false;
  hidden = hidden.map(h => { const l = h.toLowerCase(); if (l === f) { changed = true; return to; } if (l.startsWith(f + '/')) { changed = true; return to + h.slice(from.length); } return h; });
  if (changed) { hidden = [...new Set(hidden)]; saveHidden(); }
}
function hiddenList() {
  loadHidden(true);
  const sc = lastScan || { files: [], dirs: [] }, all = new Set(sc.dirs.map(d => d.toLowerCase()));
  return hidden.map(h => { const l = h.toLowerCase(); return { p: h, missing: !all.has(l), files: sc.files.filter(f => f.p.toLowerCase().startsWith(l + '/')).length }; });
}
function setHidden(body) {
  loadHidden(true);
  const hide = body.hide !== false, was = hidden.length;
  if (!hide && body.all === true) hidden = [];
  else for (const raw of (Array.isArray(body.dirs) ? body.dirs : []).map(String).slice(0, 500)) {
    if (!hide) { hidden = hidden.filter(h => h.toLowerCase() !== raw.toLowerCase()); continue; }   // by its listed name, so a folder that is not there right now can still be taken off the list
    const rel = safeRel(raw), dir = rel && lastScan && lastScan.dirs.find(d => d.toLowerCase() === rel.toLowerCase());
    if (!dir || isLocRoot(dir) || protectedRel(dir)) throw new Error('That is not a folder that can be hidden.');
    if (!hidden.some(h => h.toLowerCase() === dir.toLowerCase())) hidden.push(dir);
  }
  saveHidden();
  log(hide ? 'hidden' : 'unhidden', JSON.stringify(hide ? body.dirs : body.all === true ? 'all (' + was + ')' : body.dirs));
}

// ---------- when each file was first seen ("date added"), kept in the shared data from version 2.0.1 on ----------
// Keyed like a preview (name, size, saved date), so a file keeps its date when it is moved; a rename and an edit in place carry it
// over. Files that were already here when this began have 0: the window falls back to their modified date.
let SEEN = readJSON('seen.json', null), seenTimer = null;
if (!SEEN || typeof SEEN !== 'object' || !SEEN.t || typeof SEEN.t !== 'object') SEEN = null;
const seenKey = f => (f.dk || (f.dk = f.key || thumbKey(f))).slice(0, 12);
const seenAttach = files => { for (const f of files) { const v = SEEN && SEEN.t[seenKey(f)]; if (v) f.a = v * 1000; else delete f.a; } };
function saveSeen() {
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => {
    try {
      const disk = readJSON('seen.json', null);   // another computer may have noted files meanwhile: the earlier time wins
      if (disk && disk.t && typeof disk.t === 'object') {
        for (const [k, v] of Object.entries(disk.t)) { const mine = SEEN.t[k]; if (mine === undefined || (typeof v === 'number' && v < mine)) SEEN.t[k] = v; }
        if (disk.since < SEEN.since) SEEN.since = disk.since;
      }
      writeJSON('seen.json', SEEN);
    } catch (e) { log('seen save', e.message); }
  }, 3000);
}
function stampSeen(files, prev) {
  if (OUTDATED) return seenAttach(files);
  const first = !SEEN, now = Math.round(Date.now() / 1000);   // kept in seconds
  if (first) SEEN = { v: 1, since: Date.now(), t: {} };
  const was = prev ? new Map(prev.files.map(f => [f.p, f])) : null;
  if (was) for (const f of files) { const o = was.get(f.p); if (o && (o.s !== f.s || o.m !== f.m)) sourceFollows(thumbKey(o), thumbKey(f)); }   // saved again in place (a slicer, say): where it was downloaded from stays with it
  let changed = first;
  for (const f of files) {
    const k = seenKey(f);
    if (SEEN.t[k] !== undefined) continue;
    const o = was && was.get(f.p), ov = o ? SEEN.t[seenKey(o)] : undefined;   // saved again in place: it keeps the date it had
    SEEN.t[k] = first ? 0 : ov !== undefined ? ov : now;
    changed = true;
  }
  const keys = Object.keys(SEEN.t);
  if (keys.length > files.length * 3 + 5000) { const live = new Set(files.map(seenKey)); for (const k of keys) if (!live.has(k)) delete SEEN.t[k]; changed = true; }
  if (changed) saveSeen();
  seenAttach(files);
}
const hashes = readJSON('hashes.json', {});   // "path|size|mtime" -> { q: quick hash, h: full hash, z: zip looks ok }
let hashTimer = null;
const saveHashes = () => { clearTimeout(hashTimer); hashTimer = setTimeout(() => writeJSON('hashes.json', hashes), 3000); };

// ---------- preview cache ----------
const thumbs = new Map(); // key -> 'ok' | 'err'
const errs = new Map();   // key -> { kind, msg }
for (const f of fs.readdirSync(THUMBS)) {
  if (f.endsWith('.img')) thumbs.set(f.slice(0, -4), 'ok');
  else if (f.endsWith('.err')) {
    const k = f.slice(0, -4);
    thumbs.set(k, 'err');
    try { errs.set(k, JSON.parse(fs.readFileSync(path.join(THUMBS, f), 'utf8'))); } catch { errs.set(k, { kind: 'unsupported', msg: '' }); }
  }
}
const thumbKey = f => sha(baseOf(f.p) + '|' + f.s + '|' + Math.floor(f.m / 1000)).slice(0, 24);

const queue = [];
const queued = new Set();
// previews of models inside zips are rendered from a temporary copy, kept only while it is being drawn
const ZTMP = path.join(os.tmpdir(), 'print-gallery-zip-' + process.pid);
process.on('exit', () => { try { fs.rmSync(ZTMP, { recursive: true, force: true }); } catch {} });
let current = null, worker = null, seq = 0;
const events = [];

function ensureWorker() {
  if (worker) return;
  const w = worker = new Worker(path.join(__dirname, 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 6144 } });
  w.on('message', m => finish(m));
  w.on('error', e => log('worker error', e && e.message));
  w.on('exit', () => {
    if (worker === w) worker = null;
    if (current && current.w === w) finish({ key: current.key, ok: false, kind: 'unsupported', msg: 'preview renderer gave up on this file (too large or too complex)' });
  });
}
function pump() {
  if (OUTDATED) { queue.length = 0; queued.clear(); return; }   // a look-only copy makes no new previews
  if (current || !queue.length) return;
  const job = current = queue.shift();
  if (job.zip && !job.abs) {   // a model inside a zip: a copy is unpacked into this computer's temporary folder for the renderer, and removed again afterwards
    const tmp = path.join(ZTMP, job.key + '.' + job.ext);
    fsp.mkdir(ZTMP, { recursive: true }).then(() => zip.extract(job.zip.abs, job.zip.ent, tmp)).then(
      () => { job.abs = job.tmp = tmp; if (current === job) post(job); },
      e => { if (current === job) finish({ key: job.key, ok: false, kind: e.zip ? 'corrupt' : 'io', msg: e.message }); });
    return;
  }
  post(job);
}
function post(job) {
  ensureWorker();
  job.w = worker;
  job.timer = setTimeout(() => { log('timeout', job.abs); job.w.terminate(); }, 240000);
  worker.postMessage({ key: job.key, abs: job.abs, ext: job.ext, out: path.join(THUMBS, job.key + '.img'), ...(job.redo ? { cmp: true, ...(job.redo === 'tone' ? { mode: 'retone' } : {}) } : {}) });
}
function finish(m) {
  if (!current || current.key !== m.key) return;
  clearTimeout(current.timer);
  if (current.tmp) fsp.unlink(current.tmp).catch(() => {});
  queued.delete(m.key);
  if (current.redo) {   // an older preview brought up to date: the picture it had stays if this did not work, and the page is told only when it changed
    current = null;
    if (m.ok && !m.same) { redone.keys[m.key] = REDO_V; events.push({ seq: ++seq, key: m.key, t: 'ok', tv: REDO_V }); }
    if (--redoLeft <= 0) { redone.v = REDO_V; log('older previews are up to date'); }
    saveRedone();
    return pump();
  }
  current = null;
  if (m.ok) thumbs.set(m.key, 'ok');
  else {
    log('no preview', m.kind, m.msg);
    if (m.kind !== 'io') {   // I/O hiccups (e.g. Drive still syncing) are retried on the next scan
      thumbs.set(m.key, 'err');
      errs.set(m.key, { kind: m.kind, msg: m.msg });
      try { fs.writeFileSync(path.join(THUMBS, m.key + '.err'), JSON.stringify({ kind: m.kind, msg: m.msg })); } catch {}
    }
  }
  events.push({ seq: ++seq, key: m.key, t: m.ok ? 'ok' : 'err' });
  if (events.length > 6000) events.splice(0, 2000);
  pump();
}

// ---------- 3D viewer geometry: its own worker, so viewing never waits behind preview rendering ----------
let meshWorker = null, meshChain = Promise.resolve(), meshSeq = 0;
const meshWait = new Map();
function meshJob(abs, ext) {
  const run = () => new Promise((res, rej) => {
    if (!meshWorker) {
      const w = meshWorker = new Worker(path.join(__dirname, 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 6144 } });
      w.on('message', m => { const p = meshWait.get(m.key); if (!p) return; meshWait.delete(m.key); clearTimeout(p.timer); m.ok ? p.res(m.mesh) : p.rej(new Error(m.msg)); });
      w.on('error', e => log('mesh worker', e && e.message));
      w.on('exit', () => { if (meshWorker === w) meshWorker = null; for (const p of meshWait.values()) { clearTimeout(p.timer); p.rej(new Error('This model is too large or complex to show in 3D.')); } meshWait.clear(); });
    }
    const key = 'm' + (++meshSeq), w = meshWorker;
    meshWait.set(key, { res, rej, timer: setTimeout(() => w.terminate(), 180000) });
    w.postMessage({ key, mode: 'mesh', abs, ext });
  });
  const p = meshChain.then(run, run);
  meshChain = p.catch(() => {});
  return p;
}

// ---------- slicer facts (printer, material, print time): read once per file, kept in the shared index ----------
const META_EXT = new Set(['3mf', 'gcode', 'bgcode', 'gco']);   // files a slicer wrote its settings into
const SIZE_EXT = new Set(['3mf', 'stl', 'obj', 'step', 'stp']);                // files whose real size can be measured
const META_V = 3;                                              // raise to have every file read again
const metaWant = f => { const e = extOf(f.p); return (META_EXT.has(e) || SIZE_EXT.has(e)) && f.s > 0; };
// META_F marks facts read by the newer reader (2.1.1: every part listed, "was called" only for a file made from one other file).
// It is kept apart from META_V so that an older copy of the program sharing this library still finds its records complete. Only the
// records that could be wrong are read again — a 3MF whose part list was cut at twelve, or that has a "was called" — and only their
// names: the size, which is the slow part, is kept as measured.
const META_F = 2;
const metaStale = m => !m.f && !!(m.og || (m.pn && m.pn.length >= 12));
const metaDone = m => !!m && m.v === META_V && !metaStale(m);
const meta = readJSON('meta.json', {});   // preview-style key -> { pr, pf, mt, pt }  ({} when the file records nothing)
let metaRev = 0, metaTimer = null, metaBusy = false;
const saveMeta = () => { clearTimeout(metaTimer); metaTimer = setTimeout(() => { try { writeJSON('meta.json', meta); } catch (e) { log('meta save', e.message); } }, 3000); };
// ---------- where a download came from (Find models online) ----------
// When a file is downloaded in the Find models window, the page it came from is noted: its address, and what the page says the
// model is (title, designer, description, tags). It is kept in the shared data, keyed like a preview, and goes with the file
// when it is renamed and to the files taken out of a zip. It only ever fills gaps: what a file says about itself comes first.
// Every word of it was written by a stranger's web page, so it is cut to size here and treated as a claim wherever it is used.
const sources = readJSON('sources.json', {});   // preview-style key -> { u, s, ti, by, ab, tg, at }
let srcTimer = null;
const saveSources = () => { clearTimeout(srcTimer); srcTimer = setTimeout(() => { try { writeJSON('sources.json', sources); } catch (e) { log('sources save', e.message); } }, 1200); };
const srcText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function cleanSource(i) {
  if (!i || typeof i !== 'object') return null;
  let u; try { u = new URL(String(i.u || '')); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.hash = ''; u.username = ''; u.password = '';
  if (u.href.length > 600) return null;
  const o = { u: u.href, s: u.hostname.replace(/^www\./, '').slice(0, 100), at: Date.now() };
  const n = srcText(i.n, 200); if (n) o.n = n;
  if (i.z === 1) o.z = 1;
  // the licence the page states: a Creative Commons address says exactly which one; anything else is kept as the page words it
  let lu = null; try { lu = new URL(String(i.lu || '')); } catch {}
  if (lu && (lu.protocol === 'https:' || lu.protocol === 'http:') && lu.href.length <= 300) {
    const cc = /(^|\.)creativecommons\.org$/i.test(lu.hostname) && (/^\/licenses\/([a-z-]+)\/(\d\.\d)/i.exec(lu.pathname) || /^\/publicdomain\/(zero|mark)\/(\d\.\d)/i.exec(lu.pathname));
    if (cc) { o.lc = /zero/i.test(cc[1]) ? 'CC0 ' + cc[2] + ' (public domain)' : /mark/i.test(cc[1]) ? 'Public Domain Mark ' + cc[2] : 'CC ' + cc[1].toUpperCase() + ' ' + cc[2]; o.lu = lu.href; }
    else { const lt = srcText(i.lt, 80); if (lt) { o.lc = lt; o.lu = lu.href; } }
  } else { const lt = srcText(i.lt, 80); if (lt && /licen[cs]e|creative commons|public domain|\bcc[ -]?(by|0)\b|all rights reserved/i.test(lt)) o.lc = lt; }
  if (i.tq === 1 || i.tq === true) o.tq = 1;   // the page gave its title as a title to be shown elsewhere (not just whatever was in the window's title bar)
  const ti = srcText(i.ti, 200), by = srcText(i.by, 100), ab = srcText(i.ab, 1500);
  if (ti) o.ti = ti; if (by) o.by = by; if (ab && ab.toLowerCase() !== ti.toLowerCase()) o.ab = ab;
  const tg = [...new Set((Array.isArray(i.tg) ? i.tg : []).map(t => srcText(t, 40).toLowerCase()).filter(Boolean))].slice(0, 12);
  if (tg.length) o.tg = tg;
  return o;
}
function noteSource(abs, info) {
  if (OUTDATED) return false;
  try { const st = fs.statSync(abs), c = cleanSource(info); if (!c || !st.isFile()) return false;
    if (!c.n) c.n = srcText(path.basename(abs), 200);   // the name the site gave it, before any "(2)" was added here
    sources[thumbKey({ p: abs.split(path.sep).join('/'), s: st.size, m: Math.round(st.mtimeMs) })] = c; srcRev++; saveSources(); return true; }
  catch (e) { log('source not noted', e.message); return false; }
}
const sourceFollows = (a, b, part) => { if (a !== b && sources[a] && !sources[b]) { sources[b] = part ? { ...sources[a], z: 1 } : sources[a]; srcRev++; saveSources(); } };   // part: one file out of a zip, not the download itself   // a rename, a save in place, or a file taken out of a zip
// A file made from a downloaded one has no page of its own, but it is the same model:
//   - a slicer project records the name of the file it was made from ("Was called"); when exactly one downloaded file had that name,
//     the project takes that file's page;
//   - a file saved beside a downloaded one under the same name with another ending (benchy.stl, benchy.3mf) takes its page too.
// These are matches by name, so they can be wrong; they only fill gaps, like any page details, and are marked (si) where shown.
let srcRev = 0, srcIdx = null;
const srcStem = n => lc(String(n || '').replace(/\.[^./\\]+$/, '').trim());
function sourceIndex() {
  const sc = lastScan;
  if (srcIdx && srcIdx.sc === sc && srcIdx.rev === srcRev) return srcIdx;
  const byStem = new Map(), byPlace = new Map(), put = (map, key, k) => { if (!key) return; const had = map.get(key); map.set(key, had === undefined || sources[had] === sources[k] ? k : null); };   // null: more than one model answers to it
  for (const [k, v] of Object.entries(sources)) put(byStem, srcStem(v.n), k);
  if (sc) for (const f of sc.files) { const k = thumbKey(f); if (!sources[k]) continue; put(byStem, srcStem(baseOf(f.p)), k); put(byPlace, lc(dirOf(f.p)) + '|' + srcStem(baseOf(f.p)), k); }
  return (srcIdx = { sc, rev: srcRev, byStem, byPlace });
}
function sourceFrom(f, m) {
  const ix = sourceIndex();
  for (const name of (m && m.og) || []) { const k = ix.byStem.get(srcStem(name)) || ix.byStem.get(lc(String(name).trim())); if (k && sources[k]) return sources[k]; }
  const k = ix.byPlace.get(lc(dirOf(f.p)) + '|' + srcStem(baseOf(f.p)));
  return k && sources[k] ? sources[k] : null;
}
// The same model page, whichever of its tabs was showing: the same site, and one address is the other with something added.
const samePage = (a, b) => { try { const x = new URL(a), y = new URL(b); if (x.hostname.replace(/^www\./, '') !== y.hostname.replace(/^www\./, '')) return false;
  const p = x.pathname.replace(/\/+$/, ''), q = y.pathname.replace(/\/+$/, ''); if (p === q) return p.length > 1 || x.search === y.search;
  const [s, l] = p.length < q.length ? [p, q] : [q, p]; return l.startsWith(s + '/') && (s.split('/').length > 2 || /[\d:]/.test(s)); } catch { return false; } };
function sourcesAt(url) {
  const sc = visible(lastScan), out = []; if (!sc) return out;
  const hit = new Set(Object.entries(sources).filter(([, v]) => samePage(v.u, url)).map(([k]) => k)); if (!hit.size) return out;
  for (const f of sc.files) { if (out.length >= 50) break; if (hit.has(thumbKey(f))) out.push({ p: f.p, name: baseOf(f.p) }); }
  return out;
}
// (8) New 3D files in a Downloads folder shown as another location: the ones first seen in the last two weeks. The page offers to
// move them into the library's unsorted folder; nothing is moved unless that button is pressed.
const unsortedRel = () => {
  const sc = lastScan, is = n => norm(n) === 'unsorted', home = sc ? sc.dirs.filter(d => d[0] !== ':') : [];
  return home.find(d => !d.includes('/') && is(d)) || home.find(d => d.split('/').length === 2 && !/^[._$]/.test(d) && is(baseOf(d))) || 'Unsorted';
};
function inbox() {
  const sc = visible(lastScan), out = { files: [], loc: '', dest: unsortedRel() }; if (!sc) return out;
  const dl = LOCS.filter(l => !l.home && !l.usb && /^downloads?$/i.test(path.basename(String(l.root || '')))); if (!dl.length) return out;
  const since = Date.now() - 14 * 86400000;
  for (const l of dl) for (const f of sc.files) {
    if (!f.p.startsWith(':' + l.name + '/') || !(f.a > since) || !(f.m > since - 16 * 86400000) || out.files.length >= 200) continue;   // newly seen, and not an old file in a folder that was only just added
    const ext = extOf(f.p), z = ext === 'zip' ? zipOf(f) : null;
    if (MODEL.has(ext) || (z && z.zm > 0)) { out.files.push({ p: f.p, key: thumbKey(f) }); out.loc = l.name; }
  }
  return out;
}
const metaOf = f => {
  const k = thumbKey(f), m0 = metaWant(f) ? meta[k] : null, m = m0 && (m0.pr || m0.mt || m0.pt || m0.ti || m0.ab || m0.pn || m0.og || m0.sz) ? m0 : null, own = sources[k], src = own || sourceFrom(f, m);
  if (!m && !src) return null;
  const o = m ? { pr: m.pr || undefined, pf: m.pf && m.pf !== m.pr ? m.pf : undefined, mt: m.mt || undefined, pt: m.pt || undefined,
    ti: m.ti || undefined, by: m.by || undefined, ab: m.ab || undefined, pn: m.pn || undefined, pm: m.pm || undefined, og: m.og || undefined, sz: m.sz || undefined, n: m.n > 1 ? m.n : undefined } : {};
  if (src) {   // the page fills what the file does not say, and never replaces what it does
    o.sp = src.u; o.sw = src.s || undefined; if (!own) o.si = 1; if (src.z) o.sz1 = 1;   // si: taken from the file this one was made from
    if (!o.ti && src.ti) { o.ti = src.ti; o.tw = 1; if (src.tq) o.tq = 1; }
    if (!o.by && src.by) { o.by = src.by; o.bw = 1; }
    if (!o.ab && src.ab) { o.ab = src.ab; o.aw = 1; }
    if (src.tg) o.stg = src.tg;
    if (src.lc) { o.lic = src.lc; if (src.lu) o.licu = src.lu; }
  }
  return o;
};
const metaReady = () => !metaBusy && !!lastScan && !lastScan.files.some(f => metaWant(f) && !metaDone(meta[thumbKey(f)]));
async function metaPump() {
  if (metaBusy || !lastScan) return;
  const todo = lastScan.files.filter(f => metaWant(f) && !metaDone(meta[thumbKey(f)]));
  if (!todo.length) return redoPreviews();
  metaBusy = true;
  const w = new Worker(path.join(__dirname, 'worker.js'));
  let wait = null, again = false;
  w.on('message', m => { if (wait && m.key === wait.key) { const p = wait; wait = null; clearTimeout(p.t); p.res(m); } });
  w.on('error', e => log('meta worker', e && e.message));
  w.on('exit', () => { if (wait) { const p = wait; wait = null; clearTimeout(p.t); p.res({ ok: false, io: true, dead: true }); } });
  try {
    let n = 0;
    for (const f of todo) {
      const k = thumbKey(f);
      if (metaDone(meta[k])) continue;
      const e = extOf(f.p), old = meta[k], namesOnly = !!old && old.v === META_V;   // a record that only needs its names read again keeps its measured size
      const r = await new Promise(res => { wait = { key: k, res, t: setTimeout(() => { wait = null; res({ ok: false, slow: true }); }, 180000) }; w.postMessage({ mode: 'meta', key: k, abs: absOf(f.p), ext: e, slicer: META_EXT.has(e), size: !namesOnly && SIZE_EXT.has(e) && f.s < 400e6 }); });
      if (r.dead) break;
      if (r.ok) meta[k] = { ...(namesOnly && old.sz ? { sz: old.sz, n: old.n } : {}), ...(r.meta || {}), v: META_V, f: META_F };
      else if (!r.io) meta[k] = { ...(meta[k] || {}), v: META_V, f: META_F };   // I/O hiccups are retried on the next scan; a file too slow to measure keeps what was known
      if (++n % 40 === 0) { metaRev++; saveMeta(); }
      if (r.slow) { again = true; break; }   // the worker is still chewing on that file: start a fresh one for the rest
    }
    metaRev++; saveMeta();
    log('file facts read for', n, 'files');
  } finally { metaBusy = false; w.terminate(); if (again) setTimeout(() => metaPump().catch(e => log('meta', e.message)), 500); else if (metaReady()) redoPreviews(); }
}

// ---------- previews made by an earlier version ----------
// 2.1.1 draws two kinds of 3MF differently: a project saved with several plates (every object, not plate 1 alone) and a model in
// very dark material (lifted to charcoal). Pictures already in the cache are brought up to date ONCE per library, and only these:
//   - a 3MF that holds more than one object is drawn again from the file (the renderer decides whether anything changes);
//   - every other 3MF is not opened at all: its saved picture is looked at, and rewritten only if it is very dark.
// STL, OBJ, STEP and photo previews are never touched, and nothing in the library itself is ever written. A picture's address
// never changes (the page keeps previews for good), so the ones that did change are remembered here and asked for by a new address.
const REDO_V = 2;
const redone = readJSON('thumbs-redone.json', null) || { v: 0, keys: {} };
if (!redone.keys || typeof redone.keys !== 'object') redone.keys = {};
if (!thumbs.size && redone.v < REDO_V) { redone.v = REDO_V; try { writeJSON('thumbs-redone.json', redone); } catch {} }   // a library with no previews yet has nothing old in it
let redoLeft = 0, redoRan = false, redoTimer = null;
const saveRedone = () => { clearTimeout(redoTimer); redoTimer = setTimeout(() => { try { writeJSON('thumbs-redone.json', redone); } catch (e) { log('redone save', e.message); } }, 2000); };
function redoPreviews() {
  if (redoRan || OUTDATED || redone.v >= REDO_V || !lastScan) return;
  redoRan = true;
  const jobs = [], seen = new Set();
  for (const f of lastScan.files) {
    if (!f.key || seen.has(f.key) || extOf(f.p) !== '3mf' || thumbs.get(f.key) !== 'ok' || queued.has(f.key)) continue;
    seen.add(f.key);
    jobs.push({ key: f.key, abs: absOf(f.p), ext: '3mf', size: f.s, redo: (meta[f.key] || {}).n > 1 ? 'draw' : 'tone' });
  }
  if (!jobs.length) { redone.v = REDO_V; return saveRedone(); }
  log('older previews to bring up to date:', jobs.filter(j => j.redo === 'draw').length, 'drawn again,', jobs.filter(j => j.redo === 'tone').length, 'checked for darkness');
  redoLeft = jobs.length;
  for (const j of jobs) queued.add(j.key);
  queue.push(...jobs);
  pump();
}

// ---------- scan ----------
let lastScan = null, scanP = null, scanGen = 0;
// How the scan in hand is getting on: every folder read and every file looked at counts as progress, so the window can tell a
// big library that is slowly being read from a drive that has stopped answering (a cloud drive whose app is not running).
const scanStat = { on: false, seen: 0, at: 0 };
const SCAN_STUCK = 20000;   // this long with no progress at all, and a scan may be given up on when a fresh one is asked for
const scan = () => {
  if (scanP) return scanP;
  const gen = ++scanGen;
  Object.assign(scanStat, { on: true, seen: 0, at: Date.now() });
  const p = doScan(gen).finally(() => { if (scanP === p) scanP = null; if (gen === scanGen) scanStat.on = false; });
  return scanP = p;
};
// again: the owner pressed Rescan on the "still checking" notice. A scan that has stopped making progress is then left behind
// (whatever it may still answer is thrown away) and a new one is started; one that is getting on is waited for as usual.
const freshScan = async again => {
  if (scanP) {
    if (again === true && scanStat.on && Date.now() - scanStat.at >= SCAN_STUCK) { log('scan: no answer for', Math.round((Date.now() - scanStat.at) / 1000) + 's, starting again'); scanP = null; }
    else await scanP.catch(() => {});
  }
  return scan();
};
const tag = f => { const ext = extOf(f.p); f.k = kindOf(ext); if (MODEL.has(ext) || HEIC.has(ext)) f.key = thumbKey(f); return ext; };
const sigOf = (files, dirs) => sha(files.map(f => f.p + '|' + f.s + '|' + f.m).join('\n') + '\n#' + dirs.join('\n'));
{ // start from the saved index so the window fills instantly; a real scan follows and only changes are applied
  const ix = readJSON('index.json', null);
  if (ix && Array.isArray(ix.files) && Array.isArray(ix.dirs)) { ix.files.forEach(tag); seenAttach(ix.files); lastScan = { files: ix.files, dirs: ix.dirs, at: ix.at, ms: 0, sig: 'saved:' + ix.sig }; }
  // "saved:": the saved index holds the home library only, but its signature was worked out over everything, other locations
  // included. Kept as it was, the first real scan after a start came out with the same signature whenever nothing had changed,
  // so a window that had already filled from the saved index was never told to fetch again, and every other location showed
  // as empty until Rescan. Marked, the first real scan always counts as a change.
}

// ---------- holding folders left behind by an unpack that was cut short (a crash, the power going) ----------
// Unpacking a zip works in a folder named ".pgunzip-" and ten letters and digits, beside where the files are going, and removes it
// when it finishes. One still there an hour later belongs to nothing that is running. The first scan after the app starts notes
// them and moves each into that library's removed folder — never deleted, and nothing else is ever touched: the name must
// match exactly, and it must be a real folder (not a link) inside the library.
const STRAY = /^\.pgunzip-[0-9a-f]{10}$/, STRAY_AGE = 60 * 60 * 1000;
let swept = false;
async function sweepStrays(rels) {
  let n = 0;
  for (const rel of rels) {
    try {
      const lr = locOf(rel);
      if (!lr || lr.loc.usb || !STRAY.test(baseOf(rel)) || safeRel(rel) !== rel) continue;
      const abs = absOf(rel), st = await fsp.lstat(abs);
      if (!st.isDirectory() || st.isSymbolicLink() || keptWhy(abs)) continue;
      let newest = st.mtimeMs;
      for (const e of await fsp.readdir(abs)) { const s = await fsp.lstat(path.join(abs, e)).catch(() => null); if (s && s.mtimeMs > newest) newest = s.mtimeMs; }
      if (Date.now() - newest < STRAY_AGE) continue;   // it may be another computer's unpack, still going
      const pre = lr.loc.home ? '' : ':' + lr.loc.name + '/', to = absOf(pre + TRASH + '/Unfinished unpack ' + baseOf(rel).slice(9) + (await exists(absOf(pre + TRASH + '/Unfinished unpack ' + baseOf(rel).slice(9))) ? ' (' + Date.now() + ')' : ''));
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await renamePatiently(abs, to);
      n++; log('swept an unfinished unpack', JSON.stringify(rel), '->', JSON.stringify(path.basename(to)));
    } catch (e) { log('sweep', JSON.stringify(rel), e.code || e.message); }
  }
  return n;
}

// test hook: GALLERY_TEST_SCAN = "stall:<ms>" makes the first scan after start wait that long before it reads anything (a drive
// that does not answer); "slow:<ms>" makes it wait that long after every folder it reads (a big library, getting on slowly)
const TEST_SCAN = /^(stall|slow):(\d+)$/.exec(process.env.GALLERY_TEST_SCAN || '');
async function doScan(gen) {
  const t0 = Date.now();
  const files = [], dirs = [], strays = [];
  const mine = () => gen === scanGen, step = () => { if (mine()) { scanStat.seen++; scanStat.at = Date.now(); } };
  if (TEST_SCAN && gen === 1 && TEST_SCAN[1] === 'stall') await new Promise(r => setTimeout(r, +TEST_SCAN[2]));
  async function rec(rel) {
    let ents;
    try { ents = await fsp.readdir(rel ? absOf(rel) : ROOT, { withFileTypes: true }); }
    catch (e) { if (!rel) throw e; return; }
    step();
    if (TEST_SCAN && gen === 1 && TEST_SCAN[1] === 'slow') await new Promise(r => setTimeout(r, +TEST_SCAN[2]));
    const subs = [];
    await Promise.all(ents.map(async e => {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (STRAY.test(e.name)) strays.push(r);   // a holding folder an unpack left behind: see sweepStrays
        if ((isTop(rel) && ownTop(e.name)) || e.name.startsWith('.') || e.name === '__MACOSX') return;
        subs.push(r);
      } else if (e.isFile()) {
        if (SKIP_NAMES.has(e.name.toLowerCase()) || e.name.startsWith('~$') || e.name.startsWith('._') || e.name.endsWith('.pgpart')) return;   // .pgpart: a copy still being written
        const st = await fsp.stat(absOf(r)).catch(() => null);
        if (st) files.push({ p: r, s: st.size, m: Math.round(st.mtimeMs) });
        step();
      }
    }));
    subs.sort();
    for (const s of subs) { dirs.push(s); await rec(s); }
  }
  await rec('');
  for (const l of LOCS) {
    if (l.home) continue;
    // a location that cannot be read right now (drive unplugged, cloud app not running) is skipped, never treated as emptied
    try { await fsp.readdir(l.root); l.offline = false; } catch { l.offline = true; continue; }
    const top = ':' + l.name;
    dirs.push(top);
    await rec(top);
  }
  if (!mine()) return lastScan;   // given up on while it was stuck: a newer scan has the say now
  files.sort((a, b) => a.p < b.p ? -1 : a.p > b.p ? 1 : 0);
  if (!swept && !OUTDATED) { swept = true; if (strays.length) sweepStrays(strays).catch(e => log('sweep', e.message)); }   // once, at start; a look-only copy changes nothing

  const fresh = [];
  for (const f of files) {
    const ext = tag(f);
    if (f.key) {
      if (!thumbs.has(f.key) && fs.existsSync(path.join(THUMBS, f.key + '.img'))) thumbs.set(f.key, 'ok');   // made on another computer
      if (!thumbs.has(f.key) && !queued.has(f.key)) {
        queued.add(f.key);
        fresh.push({ key: f.key, abs: absOf(f.p), ext, size: f.s });
      }
    }
  }
  fresh.sort((a, b) => a.size - b.size);   // quick ones first so the page fills in fast
  queue.push(...fresh);
  pump();

  stampSeen(files, lastScan);
  const sig = sigOf(files, dirs), changed = !lastScan || lastScan.sig !== sig;
  lastScan = { files, dirs, at: Date.now(), ms: Date.now() - t0, sig };
  if (changed || !bgRan) {
    bgRan = true;
    try { writeJSON('index.json', { at: lastScan.at, sig, dirs: dirs.filter(d => d[0] !== ':'), files: files.filter(f => f.p[0] !== ':').map(f => ({ p: f.p, s: f.s, m: f.m })) }); } catch (e) { log('index save', e.message); }   // the shared index holds the home library only
    background(lastScan);
  }
  metaPump().catch(e => log('meta', e.message));
  return lastScan;
}

const thumbState = f => f.key ? (thumbs.get(f.key) === 'ok' ? 'ok' : thumbs.get(f.key) === 'err' ? 'err' : 'wait') : undefined;
const pendingCount = () => queue.length + (current ? 1 : 0);

// ---------- background checks: duplicate hashing + zip sanity ----------
let bgGen = 0, bgRan = false, bg = { active: false, done: 0, total: 0 };
const fk = f => f.p + '|' + f.s + '|' + Math.floor(f.m / 1000);
const hc = f => hashes[fk(f)] || (hashes[fk(f)] = {});
// two files known to be the same, byte for byte: from the hashes the duplicate check has already worked out (nothing is read here)
const sameBytes = (a, b) => { const x = hashes[fk(a)], y = hashes[fk(b)]; return !!(x && y && x.h && x.h === y.h && a.s === b.s); };

async function quickHash(abs, size) {
  const fh = await fsp.open(abs, 'r');
  try {
    const len = Math.min(size, 65536), b = Buffer.alloc(len);
    await fh.read(b, 0, len, 0);
    return sha(b);
  } finally { await fh.close(); }
}
const fullHash = abs => new Promise((res, rej) => {
  const h = crypto.createHash('sha1');
  fs.createReadStream(abs).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
});
async function zipLooksOk(abs, size) {
  if (size < 22) return false;
  const fh = await fsp.open(abs, 'r');
  try {
    const len = Math.min(size, 65557), b = Buffer.alloc(len);
    await fh.read(b, 0, len, size - len);
    for (let i = len - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) return true;
    return false;
  } finally { await fh.close(); }
}

async function background(sc) {
  const my = ++bgGen;
  try {
    const live = new Set(sc.files.map(fk));
    for (const k of Object.keys(hashes)) if (!live.has(k)) delete hashes[k];

    const bySize = new Map();
    for (const f of sc.files) {
      if (f.s < 1024 || DUP_SKIP.has(extOf(f.p))) continue;
      (bySize.get(f.s) || bySize.set(f.s, []).get(f.s)).push(f);
    }
    const groups = [...bySize.values()].filter(g => g.length > 1);
    const zips = sc.files.filter(f => extOf(f.p) === 'zip' && f.s > 0 && (hc(f).z === undefined || hc(f).zc === undefined));
    bg = { active: true, done: 0, total: groups.reduce((a, g) => a + g.length, 0) + zips.length };

    for (const f of zips) {
      if (my !== bgGen) return;
      try { if (hc(f).z === undefined) hc(f).z = await zipLooksOk(absOf(f.p), f.s); } catch {}
      if (hc(f).zc === undefined) {   // how many files, and how many 3D models, the zip holds: shown on its card
        try { const fl = (await zip.list(absOf(f.p))).entries.filter(e => !e.dir && !zipJunk(e)); hc(f).zc = { n: fl.length, m: fl.filter(e => MODEL.has(extOf(e.name))).length, ...(fl.some(e => e.enc) ? { e: 1 } : {}) }; }
        catch (e) { if (e.zip) hc(f).zc = { n: 0, m: 0, b: 1 }; }   // a zip that cannot be read; an I/O hiccup is tried again on the next scan
        metaRev++;
      }
      bg.done++;
    }
    if (zips.length) saveHashes();
    for (const g of groups) {
      for (const f of g) {
        if (my !== bgGen) return;
        const c = hc(f);
        if (!c.q) { try { c.q = await quickHash(absOf(f.p), f.s); } catch { c.q = null; } }
      }
      const byQ = new Map();
      for (const f of g) { const q = hc(f).q; if (q) (byQ.get(q) || byQ.set(q, []).get(q)).push(f); }
      for (const sub of byQ.values()) {
        if (sub.length < 2) continue;
        for (const f of sub) {
          if (my !== bgGen) return;
          const c = hc(f);
          if (!c.h) { try { c.h = f.s <= 65536 ? c.q : await fullHash(absOf(f.p)); } catch {} }
        }
      }
      bg.done += g.length;
      saveHashes();
    }
    saveHashes();
  } catch (e) { log('background', e.stack || e); }
  finally { if (my === bgGen) bg.active = false; }
}

// ---------- review list (suggestions only — nothing here touches a file) ----------
// The built-in suggestions know nothing about any one person's folders. They work from the folders the library has:
//   * a folder is a possible home for a loose file when the file's name says the folder's name ("wall hook 3.stl" and a folder
//     called "Hooks"), or holds a word that belongs to the folder's theme ("santa" and a folder with "christmas" in its name);
//   * a holding folder is one whose name says its contents are waiting to be sorted (Unsorted, Inbox, To sort …): the files
//     in it are offered a home, and a loose top-folder model with no obvious home is offered a place in it;
//   * a pictures folder is one named for pictures or reference material, or one that already holds almost nothing else.
// A library with no folder that fits gets no suggestion at all.
const KEYWORDS = [   // [what a folder's name must contain, the words in a file's name that point to it]
  [['halloween', 'spooky'], ['halloween', 'ghost', 'spider', 'skull', 'pumpkin', 'witch', 'specter', 'zombie', 'spooky']],
  [['christmas', 'xmas'], ['christmas', 'xmas', 'santa', 'snowman', 'reindeer', 'ornament']],
  [['easter'], ['easter', 'bunny']],
  [['valentine', 'valetine'], ['valentine']],   // the second spelling is a common slip in a folder's name
  [['keychain', 'keyring'], ['keychain', 'keyring']],
  [['fidget'], ['fidget']],
  [['dragon'], ['dragon', 'lizard', 'gecko']],
  [['phone'], ['iphone', 'phonestand', 'phoneholder']],
  [['organizer', 'organiser'], ['organizer', 'organiser', 'storagebox', 'gridfinity']],
  [['miniature', 'minis'], ['miniature', '28mm', '32mm']],
  [['planter'], ['planter', 'flowerpot', 'plantpot']],
];
const HOLDING = /^(unsorted|notsorted|tosort|tobesorted|sortme|sortlater|inbox|incoming|unfiled|uncategori[sz]ed|new(files|stuff|models|downloads)?|loose(files)?)$/;
// Where new files arrive. A top folder with such a name is three things: (1) a place files wait — a model sitting directly in it is
// offered a move to the folder its name matches, exactly as in "Unsorted"; (2) the second choice, when nothing is called "unsorted",
// for parking a loose top-folder model that matches nothing; (3) a shelf — never itself the folder a file's name is matched to,
// so nothing that already sits in a proper folder is ever sent to it. (Its own subfolders can still be homes.)
const PARKING = /^((3d|stl|model|print|recent|latest)?downloads?|downloaded(models|files|stuff|stls?)?)$/;
const VAGUE = /^(models?|files?|prints?|3dprints?|stls?|stuff|things?|items?|misc|miscellaneous|others?|various|general|random|mixed|assorted|temp|tmp|parts?|objects?|downloads?|new|old|backups?|archive|tests?)$/;   // a name that says nothing about what is inside is never matched against a file's name
const OWNWORK = /^(my|own|original)\b|\b(designs?|projects?|originals?)$/i;   // the owner's own work: a file that has just arrived is more likely a download
const PICWORDS = new Set(['picture', 'image', 'photo', 'pic', 'reference', 'ref', 'render', 'screenshot', 'media', 'video', 'and', 'my']);
const VIDWORDS = /^(media|videos?|clips?|movies?|timelapses?)$/;
const SMALLWORDS = new Set(['and', 'the', 'of', 'for', 'to', 'in', 'a', 'my', 'with']);
const isHolding = name => HOLDING.test(norm(name));
const wordsOf = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const stemOf = w => w.length > 4 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 4 && /(ch|sh|x|ss)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;

// Worked out once per scan (and again when the hidden list changes): Review asks for the list every few seconds.
let moveCache = null;
function builtinMoves(sc) {
  if (moveCache && moveCache.of === sc && moveCache.rev === metaRev + '/' + srcRev) return moveCache.list;
  const list = [];
  const have = new Set(sc.files.map(f => f.p.toLowerCase()));
  // what the library's own folders say about where things go
  const home = sc.dirs.filter(d => d[0] !== ':'), under = (d, par) => d.startsWith(par + '/');
  const models = new Map(), pics = new Map(), total = new Map();   // per folder: models directly inside; pictures and all files inside it or below
  for (const f of sc.files) {
    if (f.p[0] === ':') continue;
    const d = dirOf(f.p);
    if (f.k === 'm') models.set(d, (models.get(d) || 0) + 1);
    for (let p = d; p; p = dirOf(p)) { total.set(p, (total.get(p) || 0) + 1); if (f.k === 'i') pics.set(p, (pics.get(p) || 0) + 1); }
  }
  const kids = new Map();
  for (const d of home) { const p = dirOf(d); (kids.get(p) || kids.set(p, []).get(p)).push(d); }
  const holding = home.filter(d => isHolding(baseOf(d)) && d.split('/').length <= 3);
  const inHolding = d => holding.some(h => d === h || under(d, h));
  const parking = home.filter(d => !d.includes('/') && PARKING.test(norm(baseOf(d))) && !inHolding(d));   // top folders named for downloads
  const fewest = (list, n) => list.slice().sort((a, b) => a.split('/').length - b.split('/').length || (n.get(b) || 0) - (n.get(a) || 0) || (a < b ? -1 : 1))[0];
  // the pictures folder: named for pictures (every word of its name), else a top folder that holds five or more files, nearly all pictures and no models
  const picNamed = home.filter(d => d.split('/').length <= 2 && !inHolding(d) && (w => w.length > 0 && w.every(x => PICWORDS.has(x)) && w.some(x => !SMALLWORDS.has(x) && !VIDWORDS.test(x)))(wordsOf(baseOf(d)).map(stemOf)));
  const picFull = home.filter(d => !d.includes('/') && !inHolding(d) && (total.get(d) || 0) >= 5 && (pics.get(d) || 0) >= 0.8 * total.get(d) && !home.some(x => (x === d || under(x, d)) && models.get(x)));
  const PIC = fewest(picNamed, pics) || fewest(picFull, pics) || null;
  const VID = (PIC && (kids.get(PIC) || []).find(d => VIDWORDS.test(norm(baseOf(d))))) || home.find(d => !d.includes('/') && /^(videos?|movies?|clips?|timelapses?)$/.test(norm(baseOf(d)))) || PIC;
  // where a model with no obvious home can wait: the fullest holding folder, else a top folder named for downloads
  const PARK = holding.slice().sort((a, b) => (models.get(b) || 0) - (models.get(a) || 0) || a.split('/').length - b.split('/').length || (a < b ? -1 : 1))[0] || home.find(d => !d.includes('/') && PARKING.test(norm(baseOf(d)))) || null;
  // every other folder with a name that says something can be a file's home
  const shelf = d => !d.includes('/') && (OWNWORK.test(d) || PARKING.test(norm(d)));   // a top folder named for whose work it holds, or for downloads, is a shelf for other folders, not a subject
  const cats = home.filter(d => !inHolding(d) && d !== PIC && !(PIC && under(d, PIC)) && !VAGUE.test(norm(baseOf(d))) && !shelf(d)).map(d => {
    const w = wordsOf(baseOf(d)).filter(x => !SMALLWORDS.has(x) && !/^\d+$/.test(x)).map(stemOf);
    return { d, n: norm(baseOf(d)), w, glued: w.join(''), own: OWNWORK.test(d.split('/')[0]), has: models.get(d) || 0, depth: d.split('/').length };
  }).filter(c => c.glued.length >= 4);
  const better = (a, b) => !b || a.glued.length > b.glued.length || (a.glued.length === b.glued.length && (a.own !== b.own ? !a.own : a.has !== b.has ? a.has > b.has : a.depth !== b.depth ? a.depth < b.depth : a.d < b.d));

  const match = (name, inside) => {
    const stem = name.replace(/\.[^.]+$/, ''), fn = norm(stem).replace(/spiderman/g, ''), fw = new Set(wordsOf(stem).map(stemOf));
    const pool = inside ? cats.filter(c => under(c.d, inside)) : cats;
    let best = null;
    for (const c of pool) {
      const said = (c.n.length >= 5 && fn.includes(c.n)) || (c.glued.length >= 5 && fn.includes(c.glued)) || c.w.every(x => x.length >= 4 && fw.has(x));
      if (said && better(c, best)) best = c;
    }
    if (best) return { d: best.d, why: 'name matches the folder “' + baseOf(best.d) + '”' };
    for (const [tags, words] of KEYWORDS) {
      const w = words.find(x => fn.includes(x));
      if (!w) continue;
      let c = null;
      for (const x of pool) if (tags.some(t => x.n.includes(t)) && (!c || (x.own !== c.own ? !x.own : x.has !== c.has ? x.has > c.has : x.depth !== c.depth ? x.depth < c.depth : x.d < c.d))) c = x;
      if (c) return { d: c.d, why: 'name contains “' + w + '”' };
    }
    return null;
  };
  // When a file's own name points nowhere, what the model is called may: the title inside the file (a 3MF's listing), or the title
  // and tags of the page it was downloaded from. The reason given says which, because a page's words are only a claim.
  const said = (f, inside) => {
    const mo = metaOf(f); if (!mo) return null;
    const own = !mo.tw && mo.ti ? match(mo.ti + '.x', inside) : null;
    if (own) return { d: own.d, why: own.why.replace(/^name matches/, 'its listing title (“' + mo.ti.slice(0, 60) + '”) matches').replace(/^name contains/, 'its listing title contains') };
    if (!mo.sp) return null;
    const words = [mo.tw ? mo.ti : '', ...(mo.stg || [])].filter(Boolean).join(' '); if (!words) return null;
    const pg = match(words + '.x', inside), from = mo.sw || 'the page it came from';
    return pg ? { d: pg.d, why: pg.why.replace(/^name matches/, 'its page on ' + from + ' matches').replace(/^name contains/, 'its page on ' + from + ' says') } : null;
  };
  for (const f of sc.files) {
    if (f.p[0] === ':') continue;   // files in other locations are the assistants' business (Auto sort), not these rules'
    const dir = dirOf(f.p), ext = extOf(f.p), name = baseOf(f.p);
    const modelish = MODEL.has(ext) || ext === 'zip';
    let to = null, why = '';
    if (dir === '') {
      if (modelish) {
        const m = match(name, null) || said(f, null);
        if (m) { to = m.d; why = 'Loose in the top folder; ' + m.why + '.'; }
        else if (PARK) { to = PARK; why = 'Loose in the top folder with no obvious category — park it in “' + baseOf(PARK) + '” with the other files waiting to be sorted.'; }
      } else if (VIDEO.has(ext) && VID) { to = VID; why = 'Loose video in the top folder.'; }
      else if (IMAGE.has(ext) && PIC) { to = PIC; why = 'Loose picture in the top folder.'; }
    } else if (modelish && holding.includes(dir)) {
      const m = match(name, null) || said(f, null);
      if (m) { to = m.d; why = 'Sitting in “' + baseOf(dir) + '”; ' + m.why + '.'; }
    } else {
      if (modelish && parking.includes(dir)) {   // sitting in the downloads folder: looked at like a file in "Unsorted"
        const m = match(name, null) || said(f, null);
        if (m) { to = m.d; why = 'Sitting in “' + baseOf(dir) + '”; ' + m.why + '.'; }
      }
      if (!to && modelish && !inHolding(dir) && (kids.get(dir) || []).length >= 2 && dir !== PIC && !(PIC && under(dir, PIC))) {   // loose beside the folders it could be filed in
        const m = match(name, dir) || said(f, dir), wait = (kids.get(dir) || []).find(d => isHolding(baseOf(d)));
        if (m) { to = m.d; why = 'Loose in “' + baseOf(dir) + '”; ' + m.why + '.'; }
        else if (wait) { to = wait; why = 'Loose in “' + baseOf(dir) + '” with no obvious category.'; }
      }
    }
    if (!to || to === dir) continue;
    const dest = to + '/' + name;
    if (have.has(dest.toLowerCase())) continue;
    list.push({ f, to: dest, why });
  }
  moveCache = { of: sc, list, rev: metaRev + '/' + srcRev };
  return list;
}

function buildReview() {
  const sc = visible(lastScan);   // hidden folders take no part: no moves into or out of them, no duplicates counted against them
  if (!sc) return [];
  const out = [];
  const add = s => { s.id = sha(s.type + '|' + s.p + '|' + (s.to || '') + '|' + (s.keep || '')).slice(0, 16); out.push(s); };
  const info = f => ({ p: f.p, s: f.s, m: f.m, k: f.k, key: f.key, t: thumbState(f), tv: redone.keys[f.key] });

  // 1. moves — loose files that have an obvious home
  for (const m of builtinMoves(sc)) add({ type: 'move', ...info(m.f), to: m.to, why: m.why });

  // 2. duplicates — byte-for-byte identical files
  const byHash = new Map();
  for (const f of sc.files) {
    const c = hashes[fk(f)];
    if (!c || !c.h || f.s < 1024 || DUP_SKIP.has(extOf(f.p))) continue;
    const k = c.h + ':' + f.s;
    (byHash.get(k) || byHash.set(k, []).get(k)).push(f);
  }
  const rank = f => (f.p[0] === ':' ? 200 : 0) + (dirOf(f.p) === '' ? 100 : 0) + (dirOf(f.p).split('/').some(isHolding) ? 50 : 0) + (/\(\d+\)|copy|\+/i.test(baseOf(f.p)) ? 10 : 0);
  for (const g of byHash.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => rank(a) - rank(b) || a.m - b.m || a.p.length - b.p.length);
    for (const f of g.slice(1)) add({ type: 'dup', ...info(f), keep: g[0].p, why: 'Identical, byte for byte, to the copy that would be kept.' });
  }

  // 3. possibly broken
  for (const f of sc.files) {
    const ext = extOf(f.p);
    if (f.s === 0) { add({ type: 'broken', ...info(f), why: 'Empty file (0 bytes).' }); continue; }
    const e = f.key && errs.get(f.key);
    if (e && e.kind === 'corrupt') add({ type: 'broken', ...info(f), why: 'Could not be read: ' + e.msg });
    else if (ext === 'zip' && hashes[fk(f)] && hashes[fk(f)].z === false) add({ type: 'broken', ...info(f), why: 'Not a complete zip — the end of the archive is missing (incomplete download?).' });
  }
  out.push(...ai.suggestions(sc, info));   // Claude's suggestions wait here for approval like all the others
  // A downloaded file whose name says nothing of what it is ("body_v3.stl") is offered the name its page gives the model. Only for a
  // file that has a page of its own, only when no word of that title is in its name already, and never when an assistant has
  // already suggested a name for it. It waits for approval like every other suggestion, and the owner can type another name.
  {
    const named = new Set(out.filter(s => s.type === 'ai-rename').map(s => s.p)), taken = new Set(sc.files.map(f => lc(f.p)));
    for (const f of sc.files) {
      if (f.p[0] === ':' || named.has(f.p) || !(MODEL.has(extOf(f.p)) || extOf(f.p) === 'zip')) continue;
      const mo = metaOf(f); if (!mo || !mo.sp || mo.si || mo.sz1 || !mo.tw || !mo.tq || !mo.ti) continue;
      const stem = baseOf(f.p).replace(/\.[^.]+$/, ''), fn = norm(stem), tw = wordsOf(mo.ti).map(stemOf).filter(w => w.length >= 4 && !SMALLWORDS.has(w));
      if (!tw.length || tw.some(w => fn.includes(w)) || norm(mo.ti).length < 4) continue;
      const ext = (/\.[^./]+$/.exec(baseOf(f.p)) || [''])[0], name = cleanName(mo.ti.slice(0, 80).trim() + ext);
      if (!name || name === baseOf(f.p)) continue;
      const dir = dirOf(f.p), to = (dir ? dir + '/' : '') + name; if (taken.has(lc(to))) continue;
      taken.add(lc(to));
      add({ type: 'ai-rename', src: 'page', ai: 'page', ...info(f), name, why: 'Its name does not say what it is. Its page on ' + (mo.sw || 'the site it came from') + ' calls it “' + mo.ti.slice(0, 80) + '”' + (mo.by ? ', by ' + mo.by.slice(0, 60) : '') + '.' });
    }
  }
  const gone = new Set(state.dismissed);
  // an AI suggestion that names a hidden folder (as the thing to change, or as where something should go) is left out too
  const hid = s => hiddenIn(s.p) || (s.type === 'ai-plan' ? s.op !== 'rename' && hiddenIn(s.to) : typeof s.to === 'string' && hiddenIn(dirOf(s.to)));
  return out.filter(s => !gone.has(s.id) && !(hidden.length && hid(s)) && !keptStep(s));
}

// A suggestion that would rename, move, merge away or remove a folder that is left alone. Suggestions about FILES are never
// this (a file inside Downloads may go anywhere); folder steps from an assistant are checked by the folder they act on.
const keptStepMemo = new Map();
function keptStep(s) {
  if (s.type !== 'ai-plan' || s.op === 'create' || s.op === 'split') return false;   // create makes a folder, split only suggests moves for the files inside
  if (typeof s.p !== 'string') return true;
  let abs; try { abs = absOf(s.p); } catch { return false; }
  const key = abs.toLowerCase() + '|' + LOCS.length, hit = keptStepMemo.get(key);
  if (hit && Date.now() - hit.at < 5000) return hit.v;
  const v = !!keptWhy(abs);
  if (keptStepMemo.size > 2000) keptStepMemo.clear();
  keptStepMemo.set(key, { at: Date.now(), v });
  return v;
}
async function exists(abs) { try { await fsp.stat(abs); return true; } catch { return false; } }

// The ONLY place a file in the 3D Prints folder is ever moved because of a suggestion.
async function applySuggestion(id, list, over) {
  let s = (list || buildReview()).find(x => x.id === id);
  if (!s) throw new Error('That suggestion is no longer current — rescan and try again.');
  if (over && typeof over.name === 'string' && s.type === 'ai-rename') {   // the owner typed their own name: the file type is still kept
    const ext = (/\.[^./]+$/.exec(baseOf(s.p)) || [''])[0];
    let stem = over.name.trim();
    if (ext && stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length).trim();
    s = { ...s, name: cleanName(stem + ext) };
    if (s.name === baseOf(s.p)) {   // the owner typed the name it already has: they want it left alone, so the suggestion is finished with
      ai.drop(s.id); log('kept name', JSON.stringify(s.p));
      return Object.assign([], { kept: true });
    }
  }
  if (over && over.removeCopy === true && s.type === 'ai-rename') {   // a name suggestion for a file that turned out to be an exact copy of its neighbour: the owner removes the copy instead, the way a duplicate is removed
    if (!s.same || !s.clash) throw new Error('These two files are not known to be the same — nothing was removed.');
    s = { id: s.id, type: 'dup', p: s.p, s: s.s, keep: s.clash, wasName: true };
  }
  if (over && typeof over.to === 'string' && (s.type === 'move' || s.type === 'ai-move')) {   // the owner chose their own folder (it may be a new one)
    const parts = over.to.split(/[\\/]+/).map(x => x.trim()).filter(Boolean);
    parts.forEach(cleanName);
    const rel = parts.length ? safeRel(parts.join('/')) : '';
    if (rel === null || (rel && protectedRel(rel))) throw new Error('That is not a folder files can be moved into.');
    if (rel.toLowerCase() === dirOf(s.p).toLowerCase()) throw new Error('It is already in that folder.');
    s = { ...s, to: rel ? rel + '/' + baseOf(s.p) : baseOf(s.p) };
  }
  if (s.src === 'ai') {
    if (s.type === 'ai-plan' && s.op !== 'create' && s.op !== 'split') { const k = keptRel(String(s.p)); if (k) throw new Error(k); }   // checked again at the moment of approval
    const done = await ai.apply(s);
    log('approved', s.type, s.op || '', JSON.stringify(s.p));
    if (!list) await freshScan();
    return done;
  }
  if (s.type === 'ai-rename') {   // a name taken from the page a file was downloaded from (the assistants' names were dealt with above)
    const st0 = await fsp.stat(absOf(s.p)).catch(() => null);
    if (!st0 || st0.size !== s.s) throw new Error('The file has changed or moved since the scan — nothing was done.');
    const r = await renameItem(s.p, s.name);
    log('approved a name', JSON.stringify(s.p), '->', JSON.stringify(s.name));
    if (!list) await freshScan();
    return r.done;
  }
  if (s.type !== 'move' && s.type !== 'dup' && s.type !== 'broken') throw new Error('That kind of suggestion cannot be approved here — nothing was done.');
  const from = absOf(s.p);
  const st = await fsp.stat(from).catch(() => null);
  if (!st || st.size !== s.s) throw new Error('The file has changed or moved since the scan — nothing was done.');
  let toRel;
  if (s.type === 'move') toRel = s.to;
  else {
    if (s.type === 'dup') {
      const k = await fsp.stat(absOf(s.keep)).catch(() => null);
      if (!k || k.size !== s.s) throw new Error('The copy that was going to be kept is no longer there — nothing was done.');
    }
    const lr = locOf(s.p), pre = lr.loc.home ? '' : ':' + lr.loc.name + '/';   // a file in another location goes to that location's own removed folder
    toRel = pre + TRASH + '/' + lr.sub;
    if (await exists(absOf(toRel))) toRel = pre + TRASH + '/' + lr.sub.replace(/(\.[^./]+)?$/, ' (' + Date.now() + ')$1');
  }
  const to = absOf(toRel);
  if (await exists(to)) throw new Error('A file with that name is already in the destination — nothing was done.');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await relocate(from, to);
  refreshState();
  const h = record(s.type === 'move' ? 'move' : 'remove', s.p, toRel);
  saveState();
  log('approved', s.type, JSON.stringify(s.p), '->', JSON.stringify(toRel));
  if (s.wasName) ai.drop(s.id);   // its name suggestion is finished with
  if (!list) await freshScan();
  return [h];
}

async function undo(hid, noScan) {
  refreshState();
  const h = state.history.find(x => x.id === hid);
  if (!h) throw new Error('That action is not in the history any more.');
  if (h.copy && (h.type === 'import' || h.type === 'copy' || h.type === 'unzip')) {   // a copy (made here, or brought in from outside) is withdrawn to the removed folder; its original is not touched
    const r = await removeItems([h.to]);
    if (!r.done.length) throw new Error((r.skipped[0] && r.skipped[0].why) || 'The copy could not be withdrawn.');
    const i = state.history.findIndex(x => x.id === hid); if (i >= 0) state.history.splice(i, 1);
    saveState();
    if (!noScan) await freshScan();
    return redoNote({ type: h.type, from: h.from, to: h.to, copy: true, abs: h.abs, back: r.done[0].id });
  }
  const from = absOf(h.to), to = h.abs || absOf(h.from);   // h.abs: a file moved in from a drive goes back to that drive
  if (!(await exists(from))) throw new Error('The file is no longer where the gallery put it.');
  if (await exists(to)) throw new Error('Something else now has the original name — nothing was done.');
  { const k = keptWhy(from); if (k) throw new Error(k); }   // it has since become a folder that is left alone
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await relocate(from, to);
  state.history.splice(state.history.indexOf(h), 1);
  saveState();
  if (!h.abs && (h.type === 'move' || h.type === 'rename')) hiddenFollow(h.to, h.from);
  log('undone', JSON.stringify(h.to), '->', JSON.stringify(h.from));
  if (!noScan) await freshScan();
  return redoNote({ type: h.type, from: h.from, to: h.to, abs: h.abs, aside: h.aside });
}
// ---- redo: what an undo put back can be done again. The window is handed a ticket for each undone action; the details stay here. ----
const REDO = new Map();
function redoNote(d) {
  const t = crypto.randomBytes(9).toString('hex');
  REDO.set(t, d);
  if (REDO.size > 2000) REDO.delete(REDO.keys().next().value);
  return { t, type: d.type, from: d.from, to: d.to };
}
async function redo(tickets) {
  const done = [], skipped = [];
  for (const t of (Array.isArray(tickets) ? tickets : []).map(String).slice(0, 5000)) {
    const d = REDO.get(t);
    if (!d) { skipped.push({ p: '', why: 'it can no longer be done again' }); continue; }
    REDO.delete(t);
    try {
      refreshState();
      if (d.copy) {   // the copy that Undo withdrew is brought back from the removed folder
        const back = state.history.find(x => x.id === d.back);
        if (!back) throw new Error('the copy is no longer in the removed folder');
        await undo(back.id, true);
        refreshState();
        const h = record(d.type, d.from, d.to); h.copy = true; if (d.abs) h.abs = d.abs;
        saveState(); done.push(h);
      } else if (d.type === 'remove') {
        const r = await removeItems([d.from]);
        if (!r.done.length) throw new Error((r.skipped[0] || {}).why || 'it could not be removed');
        if (d.aside) { for (const x of r.done) x.aside = true; saveState(); }
        done.push(...r.done);
      } else if (d.type === 'rename' && !d.abs && lc(dirOf(d.from)) === lc(dirOf(d.to))) {
        done.push(...(await renameItem(d.from, baseOf(d.to))).done);
      } else {   // a move (or a file moved in from a drive): from where Undo put it, back to where it had been moved
        const from = d.abs || absOf(d.from), to = absOf(d.to);
        if (!(await exists(from))) throw new Error('it is no longer where Undo put it');
        if (await exists(to)) throw new Error('something else now has that name');
        { const k = keptWhy(from); if (k) throw new Error(k); }
        await fsp.mkdir(path.dirname(to), { recursive: true });
        await relocate(from, to);
        const h = record(d.type, d.from, d.to); if (d.abs) h.abs = d.abs;
        saveState(); done.push(h);
      }
      log('done again', d.type, JSON.stringify(d.from), '->', JSON.stringify(d.to));
    } catch (e) { skipped.push({ p: d.from, why: e.message }); }
  }
  return { done, skipped };
}

// ---------- organising: every function below runs only from a direct action in the window ----------
function record(type, from, to) {
  const h = { id: sha(from + to + Date.now() + Math.random()).slice(0, 12), at: Date.now(), type, from, to };
  state.history.unshift(h);
  state.history.length = Math.min(state.history.length, 500);
  if (type === 'move' || type === 'rename') hiddenFollow(from, to);   // a hidden folder stays hidden under its new name or place
  return h;
}
const lc = s => s.toLowerCase();
const protectedRel = rel => { const r = locOf(rel); return ownTop((r ? r.sub : rel).split('/')[0]); };   // the removed-files folder and the program's own folder, under either of its names
function cleanName(n) {
  n = String(n || '').trim();
  if (!n || n.length > 200 || /[\\/:*?"<>|\x00-\x1f]/.test(n) || /[. ]$/.test(n) || n === '.' || n === '..') throw new Error('That name can\u2019t be used for a file or folder.');
  return n;
}
// Move a file or folder. On one drive this is an instant rename. Between drives the contents have to be copied: every file
// is copied, compared with its original byte for byte, and only when all of them match are the originals removed.
const hashFile = abs => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(abs).on('error', rej).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))); });
// tick (optional): called with each file's name just before it is copied; it throws to stop a long job that was cancelled.
async function copyVerified(from, to, tick) {
  const part = to + '.pgpart';
  if (tick) tick(path.basename(from));
  try {
    await fsp.copyFile(from, part);
    if (process.env.GALLERY_TEST_BADCOPY) await fsp.appendFile(part, 'x');   // test hook: a damaged copy must never replace the original
    const [a, b] = await Promise.all([hashFile(from), hashFile(part)]);
    if (a !== b) throw new Error('the copy did not match the original, so the original was left where it is');
    const st = await fsp.stat(from);
    await fsp.utimes(part, st.atime, st.mtime);   // keep the file's date
    await fsp.rename(part, to);
  } catch (e) { await fsp.unlink(part).catch(() => {}); throw e; }
}
async function copyTree(from, to, tick) {
  await fsp.mkdir(to);
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) await copyTree(a, b, tick);
    else if (e.isFile()) await copyVerified(a, b, tick);
    else throw new Error('it contains a link or special file (' + e.name + ')');
  }
}
// A copy of a file or a whole folder. A folder that cannot be copied completely (or whose copy is cancelled) is withdrawn again.
async function copyAny(from, to, tick) {
  const st = await fsp.stat(from);
  if (!st.isDirectory()) return copyVerified(from, to, tick);
  try { await copyTree(from, to, tick); }
  catch (e) { await fsp.rm(to, { recursive: true, force: true }).catch(() => {}); throw e; }
}
async function relocate(from, to, tick) {
  { const k = keptWhy(from); if (k) throw Object.assign(new Error(k), { kept: true }); }   // the last line of defence: every caller has already checked
  if (!process.env.GALLERY_FORCE_COPY) {
    try { await fsp.rename(from, to); return 'renamed'; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  }
  const st = await fsp.stat(from);
  if (st.isDirectory()) {
    try { await copyTree(from, to, tick); }
    catch (e) { await fsp.rm(to, { recursive: true, force: true }).catch(() => {}); throw e; }   // nothing half-moved: the copy is withdrawn, the originals untouched
    await fsp.rm(from, { recursive: true });
  } else {
    await copyVerified(from, to, tick);
    await fsp.unlink(from);
  }
  return 'copied';
}
// ---- long jobs: the window can ask how far a move, copy or import has got, and ask for it to stop ----
const JOBS = new Map();   // job id (made up by the window) -> { done, total, name, cancel }
function jobStart(id, total) {
  const j = { done: 0, total, name: '', cancel: false };
  if (typeof id === 'string' && /^[\w-]{6,40}$/.test(id)) { j.id = id; JOBS.set(id, j); }
  j.tick = name => { if (j.cancel) throw Object.assign(new Error('cancelled'), { cancelled: true }); j.name = name; };
  return j;
}
const jobEnd = j => { if (j.id) JOBS.delete(j.id); };
// A name that is free in a folder: "part - Copy.stl", "part - Copy (2).stl" (tag ' - Copy'), or "part (2).stl", "part (3).stl" (no tag).
async function freeName(dest, name, tag, isDir) {
  const dot = isDir ? -1 : name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let i = tag ? 1 : 2; i < 10000; i++) {
    const n = stem + tag + (i > 1 ? ' (' + i + ')' : '') + ext, rel = dest ? dest + '/' + n : n;
    if (!(await exists(absOf(rel)))) return rel;
  }
  throw new Error('no free name could be found');
}
// Move, copy or bring in files and folders. kind: 'move' | 'copy' (library paths) | 'import' (full paths of files outside the
// library, which are copied and never moved). When a name is already taken at the destination:
//   opt.clash 'ask'  \u2014 the item is left alone and listed in clashes, for the window to ask about;
//   'replace'        \u2014 the file already there goes to the removed folder first (recorded, so it can be undone), then the new one takes its place;
//   'both'           \u2014 the new one is given a free name ("name (2)");   'skip' \u2014 it is left alone.
// opt.choices gives an answer per item. With neither, a clash is skipped with a note, as it always was.
async function transfer(kind, items, toDir, opt = {}) {
  const verb = { move: 'moved', copy: 'copied', import: 'brought in' }[kind];
  const dest = safeRel(toDir);
  if (dest === null || (dest && protectedRel(dest))) throw new Error('That is not a folder files can be ' + (kind === 'move' ? 'moved' : 'copied') + ' into.');
  const destAbs = dest ? absOf(dest) : ROOT;
  const dst = await fsp.stat(destAbs).catch(() => null);
  if (!dst || !dst.isDirectory()) throw new Error('The destination folder no longer exists.');
  refreshState();
  const done = [], skipped = [], clashes = [];
  const list = Array.isArray(items) ? items.slice(0, 5000) : [], job = jobStart(opt.job, list.length);
  const choices = opt.choices && typeof opt.choices === 'object' ? opt.choices : {};
  let cancelled = false;
  try {
    for (const raw of list) {
      if (job.cancel) { cancelled = true; break; }
      let rel = null, src, name, id;
      if (kind === 'import') {
        if (typeof raw !== 'string' || raw.includes('\0') || !path.isAbsolute(raw)) { skipped.push({ p: String(raw), why: 'not a file or folder on this computer' }); job.done++; continue; }
        src = path.resolve(raw); id = raw; name = path.basename(src);
        try { cleanName(name); } catch { skipped.push({ p: id, why: 'its name can\u2019t be used in the library' }); job.done++; continue; }
      } else {
        rel = safeRel(raw); id = rel;
        if (!rel || protectedRel(rel)) { skipped.push({ p: String(raw), why: 'not something that can be ' + verb }); job.done++; continue; }
        if (isLocRoot(rel)) { const k = kind === 'move' ? keptRel(rel) : ''; skipped.push({ p: String(raw), why: k || 'not something that can be ' + verb, ...(k ? { kept: true } : {}) }); job.done++; continue; }
        src = absOf(rel); name = baseOf(rel);
      }
      job.name = name;
      const same = rel !== null ? lc(dirOf(rel)) === lc(dest) : sameDir(path.dirname(src), destAbs);   // already in that folder
      if (same && kind === 'move') { job.done++; continue; }
      const st = await fsp.lstat(src).catch(() => null);
      if (!st) { skipped.push({ p: id, why: 'it is no longer there' }); job.done++; continue; }
      if (!st.isFile() && !st.isDirectory()) { skipped.push({ p: id, why: 'it is a link or special file' }); job.done++; continue; }
      if (st.isDirectory() && within(destAbs, src)) { skipped.push({ p: id, why: 'a folder can\u2019t go inside itself' }); job.done++; continue; }
      if (kind === 'move' && st.isDirectory()) { const k = keptWhy(src); if (k) { skipped.push({ p: id, why: k, kept: true }); job.done++; log('left alone (move)', JSON.stringify(id)); continue; } }   // a copy leaves the original where it is, so it is allowed
      let toRel = dest ? dest + '/' + name : name;
      if (protectedRel(toRel)) { skipped.push({ p: id, why: 'that name is reserved by the gallery' }); job.done++; continue; }
      try {
        if (same) toRel = await freeName(dest, name, ' - Copy', st.isDirectory());   // a copy beside its original
        else {
          const there = await fsp.stat(absOf(toRel)).catch(() => null);
          if (there) {
            const c = ['replace', 'skip', 'both'].includes(choices[id]) ? choices[id] : opt.clash;
            if (c === 'both') toRel = await freeName(dest, name, '', st.isDirectory());
            else if (c === 'replace') {
              if (st.isDirectory() || there.isDirectory()) { skipped.push({ p: id, why: 'a folder is never replaced \u2014 keep both or skip it' }); job.done++; continue; }
              saveState();
              const r = await removeItems([toRel]);   // the one already there is set aside first, never overwritten
              if (!r.done.length) { skipped.push({ p: id, why: 'the one already there could not be set aside (' + ((r.skipped[0] || {}).why || 'unknown') + ')' }); job.done++; continue; }
              for (const x of r.done) x.aside = true;   // set aside to make room, not removed for its own sake
              done.push(...r.done);
            }
            else if (c === 'skip') { skipped.push({ p: id, why: 'skipped \u2014 the same name is already there' }); job.done++; continue; }
            else if (c === 'ask') { clashes.push({ p: id, name, to: dest, dir: st.isDirectory() || there.isDirectory(), src: { s: st.size, m: Math.round(st.mtimeMs) }, dst: { s: there.size, m: Math.round(there.mtimeMs) } }); job.done++; continue; }
            else { skipped.push({ p: id, why: 'the same name already exists there' }); job.done++; continue; }
          }
        }
        if (process.env.GALLERY_TEST_SLOW) await new Promise(r => setTimeout(r, +process.env.GALLERY_TEST_SLOW));   // test hook: a job long enough to watch and cancel
        if (kind === 'move') await relocate(src, absOf(toRel), job.tick); else await copyAny(src, absOf(toRel), job.tick);
      } catch (e) {
        if (e.cancelled) { cancelled = true; break; }
        skipped.push({ p: id, why: e.kept ? e.message : e.code && !/did not match|contains a link/.test(e.message) ? e.code : e.message, ...(e.kept ? { kept: true } : {}) }); job.done++; continue;
      }
      const h = record(kind, kind === 'import' ? src.split(path.sep).join('/') : rel, toRel);
      if (kind !== 'move') h.copy = true;        // undoing a copy withdraws the copy to the removed folder; the original is not involved
      if (kind === 'import') h.abs = src;
      done.push(h); job.done++;
      log(verb, JSON.stringify(kind === 'import' ? src : rel), '->', JSON.stringify(toRel));
    }
  } finally { jobEnd(job); saveState(); }
  return { done, skipped, clashes, cancelled };
}
const moveItems = (items, toDir, opt) => transfer('move', items, toDir, opt);
// Windows will not rename a folder while one of its files is being read, and the gallery itself reads new files for a moment
// (previews, duplicate checking). A rename refused for that reason is tried again for a couple of seconds before giving up.
async function renamePatiently(from, to) {
  for (let i = 0; ; i++) {
    try { return await fsp.rename(from, to); }
    catch (e) { if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e; await new Promise(r => setTimeout(r, 300)); }
  }
}
async function removeItems(items) {
  refreshState();
  const done = [], skipped = [];
  for (const raw of Array.isArray(items) ? items.slice(0, 5000) : []) {
    const rel = safeRel(raw);
    if (!rel || protectedRel(rel)) { skipped.push({ p: String(raw), why: 'not something that can be removed' }); continue; }
    { const k = keptRel(rel); if (k) { skipped.push({ p: rel, why: k, kept: true }); log('left alone (remove)', JSON.stringify(rel)); continue; } }
    if (isLocRoot(rel)) { skipped.push({ p: String(raw), why: 'not something that can be removed' }); continue; }
    if (!(await exists(absOf(rel)))) { skipped.push({ p: rel, why: 'it is no longer there' }); continue; }
    const lr = locOf(rel), pre = lr.loc.home ? '' : ':' + lr.loc.name + '/';
    let toRel = pre + TRASH + '/' + lr.sub;
    if (await exists(absOf(toRel))) toRel = pre + TRASH + '/' + lr.sub + ' (' + Date.now() + ')';
    try { await fsp.mkdir(path.dirname(absOf(toRel)), { recursive: true }); await renamePatiently(absOf(rel), absOf(toRel)); }
    catch (e) { skipped.push({ p: rel, why: e.code || e.message }); continue; }
    done.push(record('remove', rel, toRel));
    log('removed', JSON.stringify(rel), '->', JSON.stringify(toRel));
  }
  saveState();
  return { done, skipped };
}
// A file sent from a phone or a browser ("Add files from this device"). It is written beside its final place as a .pgpart file and
// only takes its name once every byte has arrived. The same name-clash rule as a copy: ask, replace (the old one is set aside first),
// keep both, or skip.
const UPLOAD_MAX = 4 * 1024 * 1024 * 1024;   // one file: 4 GB
async function upload(req, u, remote) {
  const dest = safeRel(u.searchParams.get('to') || '');
  if (dest === null || (dest && protectedRel(dest))) throw new Error('That is not a folder files can be added to.');
  const name = cleanName(u.searchParams.get('name'));
  const dst = await fsp.stat(dest ? absOf(dest) : ROOT).catch(() => null);
  if (!dst || !dst.isDirectory()) throw new Error('The destination folder no longer exists.');
  if (+req.headers['content-length'] > UPLOAD_MAX) throw Object.assign(new Error('That file is too large to add this way (the limit is 4 GB).'), { tooBig: true });
  let toRel = dest ? dest + '/' + name : name, replace = false;
  if (protectedRel(toRel)) throw new Error('That name is reserved by the gallery.');
  const there = await fsp.stat(absOf(toRel)).catch(() => null);
  if (there) {
    const c = u.searchParams.get('clash');
    if (c === 'both') toRel = await freeName(dest, name, '', false);
    else if (c === 'replace') { if (there.isDirectory()) throw new Error('A folder with that name is already there.'); replace = true; }
    else if (c === 'skip') return { ok: true, done: [], skipped: [{ p: name, why: 'skipped \u2014 the same name is already there' }] };
    else return { ok: true, clash: { p: name, name, to: dest, dir: there.isDirectory(), dst: { s: there.size, m: Math.round(there.mtimeMs) } }, done: [], skipped: [] };
  }
  const abs = absOf(toRel), part = abs + '.pgpart';
  let got = 0;
  try {
    await new Promise((ok, bad) => {
      const w = fs.createWriteStream(part);
      req.on('data', d => { got += d.length; if (got > UPLOAD_MAX) { req.unpipe(w); w.destroy(); bad(Object.assign(new Error('That file is too large to add this way (the limit is 4 GB).'), { tooBig: true })); } });
      req.on('aborted', () => { w.destroy(); bad(new Error('The upload was interrupted.')); });
      req.on('error', e => { w.destroy(); bad(e); });
      w.on('error', bad); w.on('finish', ok);
      req.pipe(w);
    });
    const want = +req.headers['content-length'];
    if (Number.isFinite(want) && want !== got) throw new Error('The upload was interrupted.');
    const m = +u.searchParams.get('m');
    if (m > 0) await fsp.utimes(part, new Date(), new Date(m)).catch(() => {});   // keep the file's own date
    refreshState();
    const done = [];
    if (replace && await exists(abs)) {
      const r = await removeItems([toRel]);   // the one already there is set aside first, never overwritten
      if (!r.done.length) throw new Error('The file already there could not be set aside.');
      for (const x of r.done) x.aside = true;
      done.push(...r.done);
    }
    if (await exists(abs)) throw new Error('Something with that name appeared there meanwhile \u2014 nothing was replaced.');
    await fsp.rename(part, abs);
    const h = record('import', (remote ? 'From a phone or tablet/' : 'From this device/') + name, toRel); h.copy = true;
    saveState(); done.push(h);
    log('added', JSON.stringify(toRel), got, 'bytes', remote ? '(from a paired device)' : '');
    return { ok: true, done, skipped: [] };
  } catch (e) { await fsp.unlink(part).catch(() => {}); throw e; }
}
async function renameItem(p, name) {
  const rel = safeRel(p);
  name = cleanName(name);
  if (!rel) { if (rel === '') { const k = keptWhy(ROOT); if (k) throw new Error(k); } throw new Error('That can\u2019t be renamed.'); }
  if (protectedRel(rel)) throw new Error('That can\u2019t be renamed.');
  { const k = keptRel(rel); if (k) { log('left alone (rename)', JSON.stringify(rel)); throw new Error(k); } }
  if (isLocRoot(rel)) throw new Error('That can\u2019t be renamed.');
  const dir = dirOf(rel), toRel = dir ? dir + '/' + name : name;
  if (toRel === rel) return { done: [], skipped: [] };
  if (protectedRel(toRel)) throw new Error('That name is reserved by the gallery.');
  const st = await fsp.stat(absOf(rel)).catch(() => null);
  if (!st) throw new Error('It is no longer there.');
  if (lc(toRel) !== lc(rel) && await exists(absOf(toRel))) throw new Error('Something with that name is already in this folder.');
  await fsp.rename(absOf(rel), absOf(toRel));
  if (st.isFile()) {   // keep the saved preview so it isn't rendered again under the new name
    const m = Math.round(st.mtimeMs), a = thumbKey({ p: rel, s: st.size, m }), b = thumbKey({ p: toRel, s: st.size, m });
    try { if (thumbs.get(a) === 'ok' && !thumbs.has(b)) { fs.copyFileSync(path.join(THUMBS, a + '.img'), path.join(THUMBS, b + '.img')); thumbs.set(b, 'ok'); } } catch {}
    ai.copyDesc(a, b);
    sourceFollows(a, b);   // and where it was downloaded from
    if (SEEN && !OUTDATED && SEEN.t[a.slice(0, 12)] !== undefined && SEEN.t[b.slice(0, 12)] === undefined) { SEEN.t[b.slice(0, 12)] = SEEN.t[a.slice(0, 12)]; saveSeen(); }   // the date it was added goes with it
  }
  refreshState();
  const h = record('rename', rel, toRel);
  saveState();
  log('renamed', JSON.stringify(rel), '->', JSON.stringify(toRel));
  return { done: [h], skipped: [] };
}
async function makeDir(parent, name) {
  const par = safeRel(parent);
  name = cleanName(name);
  if (par === null || (par && protectedRel(par))) throw new Error('A folder can\u2019t be created there.');
  const rel = par ? par + '/' + name : name;
  if (protectedRel(rel)) throw new Error('That name is reserved by the gallery.');
  if (await exists(absOf(rel))) throw new Error('A folder with that name already exists there.');
  await fsp.mkdir(absOf(rel));
  log('new folder', JSON.stringify(rel));
  return rel;
}
// ---------- zip files: looking inside, and taking files out ----------
// Looking inside reads the zip's own list of contents and unpacks nothing into the library. What is inside a zip is not part of the
// library until it is taken out: it is not indexed, not searched, and never shown or sent to an AI. A zip in a hidden folder
// cannot be opened at all (visible()). Taking files out checks each one against the checksum the zip records for it, and
// nothing lands in the library unless every chosen file passed.
const ZIP_MAX = +process.env.GALLERY_ZIP_MAX || 50 * 1024 * 1024 * 1024;   // a zip claiming to unpack to more than 50 GB is refused (the env name is a test hook)
const ZIP_PREVIEW_MAX = 600 * 1024 * 1024, ZIP_PIC_MAX = 64 * 1024 * 1024;
const zipBase = e => e.name.slice(Math.max(e.name.lastIndexOf('/'), e.name.lastIndexOf('\\')) + 1);
const zipJunk = e => /(^|[\\/])__MACOSX[\\/]/.test(e.name) || zipBase(e).startsWith('._') || SKIP_NAMES.has(zipBase(e).toLowerCase());   // what a Mac or Windows adds beside the real files
const zipOf = f => { const c = f.k === 'o' && extOf(f.p) === 'zip' && hashes[fk(f)] && hashes[fk(f)].zc; return c ? { zn: c.n, zm: c.m, ze: c.e || undefined, zb: c.b || undefined } : null; };
const zipCache = new Map();
async function zipOpen(p) {
  const rel = safeRel(p), sc = visible(lastScan);
  if (!rel || extOf(rel) !== 'zip' || !sc || !sc.files.some(f => f.p === rel)) throw new Error('That zip is not in the gallery any more.');
  const abs = absOf(rel), st = await fsp.stat(abs).catch(() => null);
  if (!st || !st.isFile()) throw new Error('That zip is no longer there.');
  const k = rel + '|' + st.size + '|' + Math.round(st.mtimeMs);
  let z = zipCache.get(k);
  if (!z) { z = await zip.list(abs); zipCache.set(k, z); if (zipCache.size > 12) zipCache.delete(zipCache.keys().next().value); }
  return { rel, abs, z };
}
const zipKey = e => sha('zip|' + zipBase(e) + '|' + e.usize + '|' + e.crc).slice(0, 24);   // the same file in another zip, or in the same zip moved elsewhere, shares its preview
const zipStem = rel => { const s = baseOf(rel).replace(/\.zip$/i, '').replace(/[. ]+$/, '').trim(); try { return cleanName(s); } catch { return 'Unpacked'; } };
const LOCKED = () => 'This zip is password-protected. ' + brandOf().name + ' cannot open it — unpack it with its password in another program first.';
async function zipView(p) {
  let o;
  try { o = await zipOpen(p); }
  catch (e) { if (e.zip) return { ok: true, state: e.zip === 'locked' ? 'locked' : 'damaged', why: e.message, files: [], bytes: 0, models: 0 }; throw e; }
  const { z, abs, rel } = o, files = [];
  let bytes = 0, models = 0, locked = 0, unsafe = 0;
  for (const e of z.entries) {
    if (e.dir || zipJunk(e)) continue;
    const ext = extOf(e.name), k = ext === 'zip' ? 'z' : kindOf(ext);
    const it = { i: e.i, n: e.parts ? e.parts.join('/') : e.name.replace(/\\/g, '/'), s: e.usize, k, m: e.m || undefined };
    bytes += e.usize; if (k === 'm') models++;
    if (!e.parts) { it.no = 'unsafe'; unsafe++; }
    else if (e.enc) { it.no = 'locked'; locked++; }
    else if (e.method !== 0 && e.method !== 8) it.no = 'packing';
    else if ((MODEL.has(ext) || HEIC.has(ext)) && e.usize > 0 && e.usize <= ZIP_PREVIEW_MAX) {
      const key = it.key = zipKey(e);
      if (!thumbs.has(key) && fs.existsSync(path.join(THUMBS, key + '.img'))) thumbs.set(key, 'ok');
      if (!thumbs.has(key) && !queued.has(key) && !OUTDATED) { queued.add(key); queue.unshift({ key, ext, size: e.usize, zip: { abs, ent: e } }); }   // ahead of the queue: the owner is looking at it now
      it.t = thumbs.get(key) === 'ok' ? 'ok' : thumbs.get(key) === 'err' || OUTDATED ? 'err' : 'wait';
    }
    else if (k === 'i' && !VIDEO.has(ext) && !HEIC.has(ext) && e.usize > 0 && e.usize <= ZIP_PIC_MAX) it.pic = 1;
    files.push(it);
  }
  pump();
  const stem = zipStem(rel), beside = dirOf(rel), all = locked > 0 && locked === files.length;
  return { ok: true, state: all ? 'locked' : 'ok', p: rel, files, bytes, models, locked, unsafe, into: beside ? beside + '/' + stem : stem, why: all ? LOCKED() : '' };
}
// Take files out of a zip. body: { p, all: true | items: [entry numbers], to (a folder; left out = the folder named after the zip,
// beside it), flat (put the chosen files straight into the folder, without the folders they sit in inside the zip), clash, choices, job }.
// Everything is unpacked into a holding folder first (its name starts with a dot, so the gallery never lists it) and each file is
// checked against the zip's checksum. Only when every file has passed is anything given its place in the library; if one fails,
// or the job is cancelled, the holding folder is withdrawn and nothing has been taken out.
async function unzip(body) {
  const NOPE = 'This zip is password-protected, so nothing was taken out. Unpack it with its password in another program first.';
  let o;
  try { o = await zipOpen(String(body.p || '')); }
  catch (e) { if (e.zip === 'locked') throw new Error(NOPE); if (e.zip) throw new Error(e.message + ' Nothing was taken out.'); throw e; }
  const { rel, abs, z } = o, all = body.all === true, flat = body.flat === true && !all;
  const want = all ? z.entries.filter(e => !e.dir && !zipJunk(e)) : [...new Set((Array.isArray(body.items) ? body.items : []).map(Number))].slice(0, 100000).map(i => z.entries[i]).filter(e => e && !e.dir);
  if (!want.length) throw new Error('Nothing was chosen to take out.');
  if (want.some(e => e.enc)) throw new Error(NOPE);
  const beside = dirOf(rel), own = typeof body.to !== 'string';
  let dest = own ? (beside ? beside + '/' + zipStem(rel) : zipStem(rel)) : safeRel(body.to);
  if (dest === null || (dest && (protectedRel(dest) || hiddenIn(dest)))) throw new Error('That is not a folder files can be unpacked into.');
  let destSt = await fsp.stat(dest ? absOf(dest) : ROOT).catch(() => null);
  if (destSt && !destSt.isDirectory()) {
    if (!own) throw new Error('That is not a folder files can be unpacked into.');
    dest = await freeName(beside, baseOf(dest), '', true); destSt = null;   // a file already has the folder's name: the folder gets "(2)"
  }
  const fresh = !destSt, skipped = [], plan = [];
  for (const e of want) {
    if (!e.parts) { skipped.push({ p: e.name, why: 'its path inside the zip is not safe to unpack' }); continue; }
    if (e.method !== 0 && e.method !== 8) { skipped.push({ p: e.name, why: 'it is packed in a way ' + brandOf().name + ' cannot read' }); continue; }
    const inner = (flat ? e.parts.slice(-1) : e.parts).join('/'), toRel = dest ? dest + '/' + inner : inner;
    if (safeRel(toRel) !== toRel || protectedRel(toRel)) { skipped.push({ p: e.name, why: 'its path inside the zip is not safe to unpack' }); continue; }
    plan.push({ e, id: String(e.i), toRel });
  }
  const total = plan.reduce((a, x) => a + x.e.usize, 0);
  if (total > ZIP_MAX) throw new Error('This zip says it unpacks to ' + (total / 1073741824).toFixed(1) + ' GB, which is more than ' + brandOf().name + ' will unpack. Nothing was taken out.');
  let near = dest ? absOf(dest) : ROOT;
  while (!(await exists(near)) && path.dirname(near) !== near) near = path.dirname(near);
  const room = await fsp.statfs(near).then(v => Number(v.bavail) * Number(v.bsize)).catch(() => Infinity);
  if (total + 32 * 1024 * 1024 > room) throw new Error('There is not enough room on that drive: the files need ' + (total / 1048576).toFixed(0) + ' MB and ' + (room / 1048576).toFixed(0) + ' MB is free. Nothing was taken out.');
  // names already taken where the files are going
  const choices = body.choices && typeof body.choices === 'object' ? body.choices : {}, clashes = [], taken = new Set(), go = [];
  const free = async x => {
    const d = dirOf(x.toRel), n = baseOf(x.toRel), dot = n.lastIndexOf('.'), stem = dot > 0 ? n.slice(0, dot) : n, ext = dot > 0 ? n.slice(dot) : '';
    for (let i = 2; i < 10000; i++) { const r = (d ? d + '/' : '') + stem + ' (' + i + ')' + ext; if (!taken.has(lc(r)) && !(await exists(absOf(r)))) return r; }
    throw new Error('no free name could be found');
  };
  for (const x of plan) {
    const there = fresh ? null : await fsp.stat(absOf(x.toRel)).catch(() => null), twice = taken.has(lc(x.toRel));
    if (there || twice) {
      let c = ['replace', 'skip', 'both'].includes(choices[x.id]) ? choices[x.id] : body.clash;
      if (twice && !there && c !== 'skip') c = 'both';   // two of the chosen files share a name: the second gets "(2)"
      if (c === 'both') x.toRel = await free(x);
      else if (c === 'replace' && there && !there.isDirectory() && !twice) x.replace = true;
      else if (c === 'replace') { skipped.push({ p: x.e.name, why: 'a folder is never replaced — keep both or skip it' }); continue; }
      else if (c === 'skip') { skipped.push({ p: x.e.name, why: 'skipped — the same name is already there' }); continue; }
      else if (c === 'ask') { clashes.push({ p: x.id, name: baseOf(x.toRel), to: dirOf(x.toRel), dir: there.isDirectory(), src: { s: x.e.usize, m: x.e.m || Date.now() }, dst: { s: there.size, m: Math.round(there.mtimeMs) } }); continue; }
      else { skipped.push({ p: x.e.name, why: 'the same name already exists there' }); continue; }
    }
    taken.add(lc(x.toRel)); go.push(x);
  }
  if (clashes.length) return { done: [], skipped: [], clashes, cancelled: false, dest, whole: false };   // nothing is unpacked until every clash has its answer
  if (!go.length) return { done: [], skipped, clashes: [], cancelled: false, dest, whole: false };
  const job = jobStart(body.job, go.length), stage = path.join(near, '.pgunzip-' + crypto.randomBytes(5).toString('hex'));
  const done = [];
  let placed = 0;
  try {
    await fsp.mkdir(stage);
    for (const x of go) {
      job.tick(baseOf(x.toRel));
      const sub = dest ? x.toRel.slice(dest.length + 1) : x.toRel, out = path.join(stage, ...sub.split('/'));
      await fsp.mkdir(path.dirname(out), { recursive: true });
      if (process.env.GALLERY_TEST_SLOW) await new Promise(r => setTimeout(r, +process.env.GALLERY_TEST_SLOW));   // test hook: a job long enough to watch and cancel
      await zip.extract(abs, x.e, out, () => { if (job.cancel) throw Object.assign(new Error('cancelled'), { cancelled: true }); });
      x.sub = sub; x.out = out; job.done++;
    }
    job.tick('');
  } catch (e) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    jobEnd(job);
    if (e.cancelled) return { done: [], skipped: [], clashes: [], cancelled: true, dest, whole: false };
    if (e.zip === 'locked') throw new Error(NOPE);
    if (e.zip) { log('unzip refused', JSON.stringify(rel), e.zip); throw new Error(e.message + ' Nothing was taken out.'); }
    throw new Error('The files could not be unpacked (' + (e.code || e.message) + '). Nothing was taken out.');
  }
  // every file has passed its check: give them their places
  try {
    refreshState();
    if (fresh) {
      await fsp.mkdir(path.dirname(absOf(dest)), { recursive: true });
      if (await exists(absOf(dest))) throw new Error('Something named “' + baseOf(dest) + '” appeared there meanwhile. Nothing was taken out.');
      await fsp.rename(stage, absOf(dest));
      const h = record('unzip', rel, dest); h.copy = true; h.n = go.length;   // one line in the history for the whole folder: undoing it withdraws the folder
      done.push(h); placed = go.length;
    } else {
      for (const x of go) {
        try {
          const to = absOf(x.toRel);
          await fsp.mkdir(path.dirname(to), { recursive: true });
          if (x.replace && await exists(to)) {
            saveState();
            const r = await removeItems([x.toRel]);   // the one already there is set aside first, never overwritten
            if (!r.done.length) { skipped.push({ p: x.e.name, why: 'the one already there could not be set aside' }); continue; }
            for (const d of r.done) d.aside = true;
            done.push(...r.done);
          }
          if (await exists(to)) { skipped.push({ p: x.e.name, why: 'the same name appeared there meanwhile' }); continue; }
          await fsp.rename(x.out, to);
          x.placed = true;
          const h = record('unzip', rel + '/' + x.sub, x.toRel); h.copy = true;
          done.push(h); placed++;
        } catch (e) { skipped.push({ p: x.e.name, why: e.code || e.message }); }
      }
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) { await fsp.rm(stage, { recursive: true, force: true }).catch(() => {}); throw e; }
  finally { jobEnd(job); saveState(); }
  try {   // files taken out of a downloaded zip came from the page the zip came from
    const zst = fs.statSync(abs), zk = thumbKey({ p: rel, s: zst.size, m: Math.round(zst.mtimeMs) });
    if (sources[zk]) for (const x of go) { if (!fresh && !x.placed) continue; const st = await fsp.stat(absOf(x.toRel)).catch(() => null); if (st && st.isFile()) sourceFollows(zk, thumbKey({ p: x.toRel, s: st.size, m: Math.round(st.mtimeMs) }), true); }
  } catch (e) { log('source not carried from the zip', e.message); }
  log('unpacked', placed, 'of', want.length, 'from', JSON.stringify(rel), '->', JSON.stringify(dest));
  return { done, skipped, clashes: [], cancelled: false, dest, count: placed, whole: all && !skipped.length && placed === want.length };
}
const ai = require('./ai.js')({ log, readJSON, writeJSON, hooks, THUMBS, thumbs, getScan: () => visible(lastScan), dkey: f => f.dk || (f.dk = f.key || thumbKey(f)), review: () => buildReview(), sameBytes, IMAGE, metaOf, metaReady, locs: () => LOCS, safeRel, protectedRel, keptRel, absOf, baseOf, dirOf, extOf, cleanName, moveItems, removeItems, renameItem });
const desk = require('./desk.js')({ ROOT, LOCS, MODEL, TRASH, hooks, log, localDir: process.env.GALLERY_LOCAL || path.join(require('os').homedir(), '.print-gallery'),
  safeRel: p => safeRel(p), absOf, extOf, baseOf, cleanName, getScan: () => lastScan, hashFile, copyVerified, record, saveState, refreshState, freshScan: () => freshScan(),
  addLocation: (d, o) => addLocation(d, o), removeLocation: n => removeLocation(n) });
const locList = sc => LOCS.map(l => {
  const pre = ':' + l.name + '/'; let n = 0, b = 0;
  for (const f of sc.files) if (l.home ? f.p[0] !== ':' : f.p.startsWith(pre)) { n++; b += f.s; }
  return { name: l.name, root: l.root, home: !!l.home, offline: !!l.offline, files: n, bytes: b };
});
// ---- other locations: add, remove, check ----
const watchers = new Map();
function watchLoc(l) {
  try {
    let t = null;
    const w = fs.watch(l.root, { recursive: true }, (ev, name) => {
      if (name && ownTop(name)) return;
      clearTimeout(t); t = setTimeout(() => scan().catch(() => {}), 3000);
    });
    w.on('error', e => log('watch', l.name, e.message));
    watchers.set(l.name, w);
  } catch (e) { log('watch unavailable', l.name, e.message); }
}
async function addLocation(dir, opt) {
  if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0') || !path.isAbsolute(dir)) throw new Error('Choose a folder on this computer.');
  const root = path.resolve(dir);
  // Too broad to be a location? A whole drive, a whole user folder, AppData, Program Files or Windows is refused; Documents, Desktop
  // and the like, or a cloud drive's top folder, need the owner's yes first (opt.sure). A plugged-in drive the owner asked to see
  // (opt.usb) is shown as it is: that is the whole drive on purpose, only while it is connected, and never remembered.
  if (!(opt && opt.usb)) {
    const c = choiceOf(root, 'location');
    if (c.level === 'refuse') throw Object.assign(new Error(c.text), { extra: { refused: true, path: c.path, kind: c.kind } });
    if (c.level === 'warn' && !(opt && opt.sure)) throw Object.assign(new Error(c.warn.text), { extra: { warn: { ...c.warn, path: c.path, kind: c.kind } } });
  }
  const st = await fsp.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('That folder could not be opened.');
  if (within(root, ROOT)) throw new Error('That folder is already inside your home library.');
  if (within(ROOT, root)) throw new Error('Your home library is inside that folder. Choose a folder beside it, not above it.');
  for (const l of LOCS) if (!l.home && (within(root, l.root) || within(l.root, root))) throw new Error('That folder overlaps the location \u201c' + l.name + '\u201d, which is already listed.');
  let base = path.basename(root).replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!base) base = 'Drive ' + root.slice(0, 1).toUpperCase();
  let name = base;
  for (let i = 2; LOCS.some(l => l.name.toLowerCase() === name.toLowerCase()) || ownTop(name); i++) name = base + ' ' + i;
  const l = { name, root };
  if (opt && opt.usb) l.usb = true;   // a plugged-in drive: shown while it is connected, never remembered
  LOCS.push(l); saveLocs(); watchLoc(l);
  log('location added', JSON.stringify(name), root);
  await freshScan();
  return l;
}
async function removeLocation(name) {
  const i = LOCS.findIndex(l => !l.home && l.name.toLowerCase() === String(name).toLowerCase());
  if (i < 0) throw new Error('That location is not in the list.');
  const [l] = LOCS.splice(i, 1);
  const w = watchers.get(l.name); if (w) { try { w.close(); } catch {} watchers.delete(l.name); }
  saveLocs();
  log('location dropped from the list (its files are untouched)', JSON.stringify(l.name));
  await freshScan();
}
// Cloud folders can list files that have not been downloaded to this computer yet. Windows marks them; count them.
function onlineOnly(name) {
  const l = LOCS.find(x => x.name.toLowerCase() === String(name).toLowerCase());
  if (!l) return Promise.reject(new Error('That location is not in the list.'));
  const ps = "$n = 0; $first = @(); Get-ChildItem -LiteralPath $env:PG_DIR -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { if (([int]$_.Attributes -band 0x401000) -ne 0) { $n++; if ($first.Count -lt 5) { $first += $_.Name } } }; ConvertTo-Json -Compress @{ n = $n; first = $first }";
  return new Promise(res => {
    let out = '';
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, PG_DIR: l.root } });
    const t = setTimeout(() => { try { c.kill(); } catch {} }, 120000);
    c.stdout.on('data', d => out += d);
    c.on('error', () => { clearTimeout(t); res({ known: false }); });
    c.on('close', () => { clearTimeout(t); try { const j = JSON.parse(out.trim()); res({ known: true, count: +j.n || 0, first: [].concat(j.first || []).map(String) }); } catch { res({ known: false }); } });
  });
}
const payload = sc => ({
  root: ROOT, trash: TRASH, locs: locList(sc), at: sc.at, ms: sc.ms, sig: sc.sig, seq, pending: pendingCount(), review: buildReview().length, dirs: sc.dirs, kept: keptDirs(sc), ai: ai.rev() + metaRev, hidden: sc.hiddenN || 0,
  files: sc.files.map(f => ({ p: f.p, s: f.s, m: f.m, a: f.a, k: f.k, key: f.key, t: thumbState(f), tv: f.key ? redone.keys[f.key] : undefined, ...ai.descOf(f), ...metaOf(f), ...zipOf(f) })),
});

// ---------- http ----------
function safeRel(p) {
  if (typeof p !== 'string' || p.includes('\0')) return null;
  let base = ROOT, pre = '';
  if (p[0] === ':') {   // a path in another location: it must name one that is connected, and stay inside it
    const r = locOf(p.replace(/\\/g, '/'));
    if (!r) return null;
    base = r.loc.root; pre = ':' + r.loc.name; p = r.sub;
  }
  const abs = path.resolve(base, p);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const tidy = rel.split(path.sep).join('/');
  return pre ? (tidy ? pre + '/' + tidy : pre) : tidy;
}
// small per-computer preferences (voice settings): never in the shared library folder
const prefFile = path.join(process.env.GALLERY_LOCAL || path.join(require('os').homedir(), '.print-gallery'), 'prefs.json');
const getPrefs = () => { try { return hooks.prefs ? hooks.prefs.get() : JSON.parse(fs.readFileSync(prefFile, 'utf8')); } catch { return {}; } };
const setPrefs = p => { if (hooks.prefs) return hooks.prefs.set(p); fs.mkdirSync(path.dirname(prefFile), { recursive: true }); fs.writeFileSync(prefFile, JSON.stringify(p)); };
const sendJSON = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((res, rej) => {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 4e6) req.destroy(); });
  req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch (e) { rej(new Error('bad request')); } });
  req.on('error', rej);
});

function sendFile(req, res, abs, type, extra) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', ...extra };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, code = 200;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = +m[1]; if (m[2]) end = Math.min(+m[2], end); } else start = Math.max(0, st.size - +m[2]);
      if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      code = 206; head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    head['Content-Length'] = st.size ? end - start + 1 : 0;
    res.writeHead(code, head);
    if (req.method === 'HEAD' || !st.size) return res.end();
    fs.createReadStream(abs, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

// ---------- the program's name and addresses, its licence, and the notices for the libraries it is built with ----------
// The desktop shell hands the name over through hooks.brand() (brand.js). Without a shell — a test — brand.js is read here, and
// the two addresses stay empty, which keeps "Give feedback" and the website link off the page.
const BRAND_DEFAULT = { name: brand.name, maker: brand.maker || '', publisher: brand.publisher || '', licence: brand.licence || '', copyright: brand.copyright || '', feedbackEmail: '', website: '' };
function brandOf() {
  let b = null;
  try { b = hooks.brand ? hooks.brand() : null; } catch (e) { log('brand', e.message); }
  const s = v => typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 200) : '';
  const out = { ...BRAND_DEFAULT };
  if (b && typeof b === 'object') {
    if (s(b.name)) out.name = s(b.name);
    out.publisher = s(b.publisher); out.maker = s(b.maker);
    if (s(b.licence)) out.licence = s(b.licence);
    if (s(b.copyright)) out.copyright = s(b.copyright);
    if (/^[^\s@<>,;:"'?&]+@[^\s@<>,;:"'?&]+\.[^\s@<>,;:"'?&]+$/.test(s(b.feedbackEmail))) out.feedbackEmail = s(b.feedbackEmail);   // one plain address, or none
    if (/^https?:\/\/[^\s"'<>]+$/i.test(s(b.website))) out.website = s(b.website);
  }
  return out;
}
const SYSTEM = (() => { try { return (os.version() + ' (' + os.release() + ', ' + os.arch() + ')').slice(0, 120); } catch { return ''; } })();   // "Windows 11 Pro (10.0.26100, x64)": filled into a feedback message, sent nowhere by the app itself
async function licenceText() {
  try { const t = hooks.licence ? await hooks.licence() : null; if (typeof t === 'string' && t.trim()) return t.slice(0, 2e5); } catch (e) { log('licence', e.message); }
  try { const t = await fsp.readFile(path.join(__dirname, 'LICENSE'), 'utf8'); if (t.trim()) return t.slice(0, 2e5); } catch {}
  return '';
}
async function noticesText() {
  try { const t = hooks.notices ? await hooks.notices() : null; if (typeof t === 'string' && t.trim()) return t.slice(0, 2e6); } catch (e) { log('notices', e.message); }
  for (const f of ['THIRD-PARTY-NOTICES.txt', 'NOTICES.txt']) { try { const t = await fsp.readFile(path.join(__dirname, f), 'utf8'); if (t.trim()) return t.slice(0, 2e6); } catch {} }
  return '';
}

// things that open a window on this computer, or handle its secret key, are not offered to a paired phone
const PC_ONLY = new Set(['/api/reveal', '/api/open', '/api/dictate', '/api/ai/key', '/api/update/start', '/api/fs/import', '/api/feedback/mail', '/api/website', '/api/home/choose']);   // import takes full paths on this computer; a phone opens its own mail app
// "Give feedback": hands a ready-written message to this computer's own email program. Nothing is sent by the app — the owner
// reads it there and presses Send. It can only ever be addressed to the feedback address the program was built with.
function mailFeedback(body) {
  const to = brandOf().feedbackEmail;
  if (!to) throw new Error('No feedback address is set in this copy.');
  const s = (v, n) => String(v || '').replace(/\0/g, '').slice(0, n);
  let url = 'mailto:' + to + '?subject=' + encodeURIComponent(s(body.subject, 150).replace(/[\r\n]+/g, ' ')) + '&body=' + encodeURIComponent(s(body.body, 4000));
  if (url.length > 2000) url = url.slice(0, 2000).replace(/%[0-9A-F]?$/i, '');   // Windows will not hand a longer link to a mail program
  if (process.env.GALLERY_TEST_MAILTO) { fs.writeFileSync(process.env.GALLERY_TEST_MAILTO, url); return; }   // test hook: written down instead of opened
  if (hooks.openExternal) return hooks.openExternal(url);
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', e => log('mailto', e.message)).unref();
}
// The program's own web page, in this computer's browser. Only ever the address the program was built with (brand.js), and
// only when it has one: nothing the page sends can change where this goes.
function openWebsite() {
  const url = brandOf().website;
  if (!url) throw new Error('This copy has no website address.');
  if (process.env.GALLERY_TEST_MAILTO) { fs.writeFileSync(process.env.GALLERY_TEST_MAILTO, url); return; }   // test hook: written down instead of opened
  if (hooks.openExternal) return hooks.openExternal(url);
  spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', e => log('website', e.message)).unref();
}
// One handler for both doors: this computer's own window (remote = false) and paired devices on the home network (remote = true).
async function handle(req, res, remote) {
  try {
    const u = new URL(req.url, 'http://x');
    const route = u.pathname;
    if (remote) {
      if (!(await phone.gate(req, res, u))) return;   // not paired: the gate has already answered
      if (route.startsWith('/api/phone') || route.startsWith('/api/slicers') || (req.method === 'POST' && PC_ONLY.has(route))) return sendJSON(res, 409, { error: 'That is done on the computer itself.' });
    } else {
      const host = (req.headers.host || '').toLowerCase();
      if (host !== 'localhost:' + PORT && host !== '127.0.0.1:' + PORT) { res.writeHead(403); return res.end('forbidden'); }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (route === '/' && remote) {   // the same page, told that it is being used from another device
        const html = (await fsp.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8')).replace('<body>', '<body class="remote">');
        res.writeHead(200, { 'Content-Type': MIME.html, 'Cache-Control': 'no-store' }); return res.end(req.method === 'HEAD' ? undefined : html);
      }
      if (route === '/') return sendFile(req, res, path.join(__dirname, 'public', 'index.html'), MIME.html, { 'Cache-Control': 'no-store' });
      if (route.startsWith('/thumb/')) {
        const key = route.slice(7);
        if (!/^[a-f0-9]{24}$/.test(key)) { res.writeHead(404); return res.end(); }
        const abs = path.join(THUMBS, key + '.img');
        let type = 'image/png';
        try { const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); if (b[0] === 0xFF) type = 'image/jpeg'; } catch {}
        return sendFile(req, res, abs, type, { 'Cache-Control': 'public, max-age=31536000, immutable' });
      }
      if (route === '/mesh') {
        const rel = safeRel(u.searchParams.get('p'));
        if (!rel || !MODEL.has(extOf(rel))) return sendJSON(res, 400, { error: 'Not a 3D model.' });
        let m;
        try { m = await meshJob(absOf(rel), extOf(rel)); } catch (e) { return sendJSON(res, 422, { error: e.message }); }
        let head = JSON.stringify({ tris: m.tris, min: m.min, max: m.max, groups: m.groups });
        head += ' '.repeat((4 - (Buffer.byteLength(head) % 4)) % 4);
        const hb = Buffer.from(head), len = Buffer.alloc(4);
        len.writeUInt32LE(hb.length);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': 4 + hb.length + m.buf.byteLength });
        res.write(len); res.write(hb);
        return res.end(Buffer.from(m.buf));
      }
      if (route === '/logo.png' || route === '/jrii.png') return sendFile(req, res, path.join(__dirname, 'public', route.slice(1)), 'image/png', { 'Cache-Control': 'public, max-age=3600' });   // the program's mark, and its maker's logo
      if (route === '/vendor/OrbitControls.js') return sendFile(req, res, path.join(__dirname, 'public', 'OrbitControls.js'), 'text/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });
      if (route.startsWith('/vendor/three/')) {   // the 3D library, served from inside the app (no internet needed)
        const base = path.join(__dirname, 'node_modules', 'three');
        const abs = path.resolve(base, decodeURIComponent(route.slice(14)));
        if (!abs.startsWith(base + path.sep) || !abs.endsWith('.js')) { res.writeHead(404); return res.end(); }
        return sendFile(req, res, abs, 'text/javascript; charset=utf-8', { 'Cache-Control': 'public, max-age=86400' });
      }
      if (route === '/file') {
        const rel = safeRel(u.searchParams.get('p'));
        if (rel === null) { res.writeHead(400); return res.end('bad path'); }
        return sendFile(req, res, absOf(rel), MIME[extOf(rel)] || 'application/octet-stream',
          { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'private, max-age=60' });
      }
      if (route === '/api/scan') {
        let sc;
        try { sc = await freshScan(u.searchParams.get('again') === '1'); }
        catch (e) { return sendJSON(res, 503, { error: 'Could not open ' + ROOT + ' (' + (e.code || e.message) + '). Is the drive connected, and is its sync app running and signed in?' }); }
        return sendJSON(res, 200, payload(visible(sc)));
      }
      if (route === '/api/files') {   // instant: whatever the index holds right now
        try { return sendJSON(res, 200, payload(visible(lastScan || await scan()))); }
        catch (e) { return sendJSON(res, 503, { error: 'Could not open ' + ROOT + ' (' + (e.code || e.message) + ').' }); }
      }
      if (route === '/api/status') {
        const since = +u.searchParams.get('since') || 0;
        return sendJSON(res, 200, { seq, sig: lastScan && visible(lastScan).sig, scan: { on: scanStat.on, seen: scanStat.seen, idle: scanStat.on ? Date.now() - scanStat.at : 0 }, pending: pendingCount(), bg, review: buildReview().length, ai: ai.rev() + metaRev, events: events.filter(e => e.seq > since) });
      }
      if (route === '/api/inbox') return sendJSON(res, 200, remote ? { files: [], loc: '', dest: '' } : inbox());
      if (route === '/api/review') refreshState();
      if (route === '/api/review') return sendJSON(res, 200, { items: buildReview(), bg, history: state.history, trash: TRASH, dismissed: state.dismissed.length + ai.stays() });
      if (route === '/api/fs/job') { const j = JOBS.get(String(u.searchParams.get('id'))); return sendJSON(res, 200, j ? { running: true, done: j.done, total: j.total, name: j.name } : { running: false }); }
      if (route === '/api/prefs') return sendJSON(res, 200, getPrefs());
      if (route === '/api/locations') return sendJSON(res, 200, { locs: locList(visible(lastScan) || { files: [] }), canPick: !remote && !!hooks.pickFolder });
      if (route === '/api/hidden') return sendJSON(res, 200, { dirs: hiddenList() });
      if (route === '/api/zip') { try { return sendJSON(res, 200, await zipView(u.searchParams.get('p'))); } catch (e) { return sendJSON(res, 409, { error: e.message }); } }
      if (route === '/zip/file') {   // a picture inside a zip, shown without unpacking anything into the library
        try {
          const o = await zipOpen(u.searchParams.get('p')), e = o.z.entries[+u.searchParams.get('i')], ext = e ? extOf(e.name) : '';
          if (!e || e.dir || !IMAGE.has(ext) || HEIC.has(ext)) { res.writeHead(404); return res.end('not found'); }
          const buf = await zip.read(o.abs, e, ZIP_PIC_MAX);
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'private, max-age=600' });
          return res.end(req.method === 'HEAD' ? undefined : buf);
        } catch { res.writeHead(404); return res.end('not found'); }
      }
      if (route === '/api/phone') return sendJSON(res, 200, phone.state());
      if (route === '/api/about') return sendJSON(res, 200, { version: VERSION, outdated: OUTDATED ? { theirs: lastUsed.version, mine: VERSION } : null, update: hooks.updateInfo ? hooks.updateInfo() : null, canUpdate: !remote && !!hooks.update, brand: brandOf(), system: SYSTEM, appdir: APPDIR, returning: !remote && hooks.returning ? !!hooks.returning() : false, broad: remote ? [] : broadNotes(), canChooseHome: !remote && !!hooks.chooseHome });
      if (route === '/api/notices') return sendJSON(res, 200, { text: await noticesText() });
      if (route === '/api/licence') return sendJSON(res, 200, { text: await licenceText() });
      { const r = await desk.handle(req, route, {}, remote); if (r) return sendJSON(res, 200, r); }
      if (route.startsWith('/api/ai/')) { const r = await ai.handle(req, route, {}); if (r) return sendJSON(res, 200, r); }
      res.writeHead(404); return res.end('not found');
    }

    if (req.method === 'POST' && route === '/api/fs/upload') {   // a file's own bytes, sent from a phone or a browser: the same custom header, and a content type no web form can send
      if (req.headers['x-gallery'] !== '1' || !/^application\/octet-stream/.test(req.headers['content-type'] || '')) { res.writeHead(403); return res.end('forbidden'); }
      let out, code = 200;
      if (OUTDATED) { code = 423; out = { error: 'This copy of ' + brandOf().name + ' is out of date, so it only looks. Update it to make changes.', outdated: true }; }
      else { try { out = await upload(req, u, remote); } catch (e) { code = e.tooBig ? 413 : 409; out = { error: e.message }; } }
      if (!req.complete) { if (code === 413) { res.setHeader('Connection', 'close'); sendJSON(res, code, out); return req.destroy(); } req.resume(); }   // the rest of an upload that was turned down is let go
      return sendJSON(res, code, out);
    }
    if (req.method === 'POST') {
      // custom header + JSON content type: other web sites cannot forge these requests
      if (req.headers['x-gallery'] !== '1' || !/^application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(403); return res.end('forbidden'); }
      const body = await readBody(req);
      try {
        if (OUTDATED && !RO_OK.test(route)) return sendJSON(res, 423, { error: 'This copy of ' + brandOf().name + ' is out of date, so it only looks. Update it to make changes.', outdated: true });
        if (route === '/api/update/start') { if (!hooks.update) throw new Error('Updating is done from the installed app on the computer.'); hooks.update(); return sendJSON(res, 200, { ok: true }); }
        { const r = await desk.handle(req, route, body, remote); if (r) return sendJSON(res, 200, r); }
        if (route === '/api/phone/set') return sendJSON(res, 200, await phone.set(!!body.on));
        if (route === '/api/phone/code') return sendJSON(res, 200, phone.newCode());
        if (route === '/api/phone/forget') return sendJSON(res, 200, phone.forget(body.id));
        if (route.startsWith('/api/ai/')) { const r = await ai.handle(req, route, body); if (r) return sendJSON(res, 200, r); }
        if (route === '/api/review/apply') { const done = await applySuggestion(String(body.id), null, body); return sendJSON(res, 200, { ok: true, action: done[0] || null, done, kept: !!done.kept }); }
        if (route === '/api/review/apply-all') {   // one click, many approvals: moves, renames and folder steps. Removals only for rows the owner ticked one by one (removals: true).
          const list = buildReview(), done = [], failed = [];
          let applied = 0;
          for (const id of (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 5000)) {
            const it = list.find(x => x.id === id);
            if (!it || !(['move', 'ai-move', 'ai-rename', 'ai-plan'].includes(it.type) || (body.removals === true && ['dup', 'broken'].includes(it.type)))) continue;
            try {
              const own = body.names && typeof body.names === 'object' && typeof body.names[id] === 'string' ? body.names[id] : null;   // a name the owner typed for this one
              const d = await applySuggestion(id, list, typeof body.to === 'string' ? { to: body.to } : own !== null && it.type === 'ai-rename' ? { name: own } : null); done.push(...d); applied++;
              // later suggestions about the same file or folder must follow it to where it is now
              for (const h of d) for (const x of list) { if (x.p === h.from) x.p = h.to; else if (x.p.startsWith(h.from + '/')) x.p = h.to + x.p.slice(h.from.length); }
            } catch (e) { failed.push({ id, name: baseOf(it.p), why: e.message }); }
          }
          await freshScan();
          return sendJSON(res, 200, { ok: true, applied, done, failed });
        }
        if (route.startsWith('/api/fs/')) {
          let r;
          const opt = { clash: body.clash, choices: body.choices, job: body.job };
          if (route === '/api/fs/cancel') { const j = JOBS.get(String(body.job)); if (j) j.cancel = true; return sendJSON(res, 200, { ok: true, found: !!j }); }
          if (route === '/api/fs/move') r = await moveItems(body.items, String(body.to || ''), opt);
          else if (route === '/api/fs/copy') r = await transfer('copy', body.items, String(body.to || ''), opt);
          else if (route === '/api/fs/import') r = await transfer('import', body.items, String(body.to || ''), opt);
          else if (route === '/api/fs/remove') r = await removeItems(body.items);
          else if (route === '/api/fs/rename') r = await renameItem(String(body.p || ''), body.name);
          else if (route === '/api/fs/mkdir') r = { done: [], skipped: [], made: await makeDir(String(body.parent || ''), body.name) };
          else throw new Error('unknown action');
          return sendJSON(res, 200, { ok: true, ...r, data: payload(visible(await freshScan())) });
        }
        if (route === '/api/zip/extract') { const r = await unzip(body); return sendJSON(res, 200, { ok: true, ...r, data: payload(visible(await freshScan())) }); }
        if (route === '/api/hidden/set') {   // { dirs: [folders], hide: true | false } or { all: true, hide: false }. No file is touched.
          setHidden(body);
          return sendJSON(res, 200, { ok: true, dirs: hiddenList(), data: payload(visible(lastScan || await scan())) });
        }
        if (route === '/api/review/dismiss') {
          const it = buildReview().find(x => x.id === String(body.id));
          if (it && it.src === 'ai') { ai.drop(it.id); return sendJSON(res, 200, { ok: true }); }
          refreshState();
          if (!state.dismissed.includes(String(body.id))) state.dismissed.push(String(body.id));
          saveState(); return sendJSON(res, 200, { ok: true });
        }
        if (route === '/api/review/dismiss-many') {   // the rows ticked in Review
          const list = buildReview(); let n = 0;
          refreshState();
          for (const id of (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 5000)) {
            const it = list.find(x => x.id === id);
            if (!it) continue;
            if (it.src === 'ai') ai.drop(id); else if (!state.dismissed.includes(id)) state.dismissed.push(id);
            n++;
          }
          saveState(); return sendJSON(res, 200, { ok: true, dismissed: n });
        }
        if (route === '/api/review/restore-dismissed') { state.dismissed = []; ai.forgetStays(); saveState(); return sendJSON(res, 200, { ok: true }); }
        if (route === '/api/prefs') { if (remote) return sendJSON(res, 200, { ok: true });   // voice settings belong to each device
          setPrefs({ say: !!body.say, voice: String(body.voice || '').slice(0, 120), rate: Math.min(2, Math.max(0.5, +body.rate || 1)) }); return sendJSON(res, 200, { ok: true }); }
        if (route === '/api/locations/add') {
          let dir = typeof body.root === 'string' ? body.root : '';
          if (!dir) { if (remote || !hooks.pickFolder) throw new Error('Choose a folder on this computer.'); dir = await hooks.pickFolder(); if (!dir) return sendJSON(res, 200, { ok: true, cancelled: true }); }
          const l = await addLocation(dir, { sure: body.sure === true });   // sure: the owner has answered the "use all of it?" question
          return sendJSON(res, 200, { ok: true, name: l.name, locs: locList(visible(lastScan)) });
        }
        if (route === '/api/locations/remove') { await removeLocation(body.name); return sendJSON(res, 200, { ok: true, locs: locList(visible(lastScan)) }); }
        if (route === '/api/locations/check') return sendJSON(res, 200, { ok: true, ...(await onlineOnly(body.name)) });
        if (route === '/api/feedback/mail') { await mailFeedback(body); return sendJSON(res, 200, { ok: true }); }
        if (route === '/api/website') { openWebsite(); return sendJSON(res, 200, { ok: true }); }
        if (route === '/api/home/choose') { if (!hooks.chooseHome) throw new Error('The home folder is chosen in the program on the computer: File > Choose home folder.'); hooks.chooseHome(); return sendJSON(res, 200, { ok: true }); }
        if (route === '/api/dictate') { if (!hooks.dictate) throw new Error('Press Win+H to dictate.'); hooks.dictate(); return sendJSON(res, 200, { ok: true }); }
        if (route === '/api/undo-many') {   // newest first, one rescan at the end
          let n = 0, why = '';
          const again = [];
          for (const id of (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 5000)) { try { again.push(await undo(id, true)); n++; } catch (e) { why = why || e.message; } }
          await freshScan();
          return sendJSON(res, 200, { ok: true, undone: n, why, redo: again });
        }
        if (route === '/api/undo') { const again = await undo(String(body.id)); return sendJSON(res, 200, { ok: true, redo: [again] }); }
        if (route === '/api/redo') { const r = await redo(body.tickets); return sendJSON(res, 200, { ok: true, ...r, data: payload(visible(await freshScan())) }); }
        if (route === '/api/reveal' || route === '/api/open') {
          const rel = safeRel(body.p);
          if (rel === null) throw new Error('bad path');
          const abs = rel ? absOf(rel) : ROOT;
          const st = await fsp.stat(abs).catch(() => null);
          if (!st) throw new Error('Not found on disk any more.');
          if (st.isDirectory()) { if (hooks.openPath) hooks.openPath(abs); else spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).unref(); }
          else if (route === '/api/reveal' && hooks.reveal) hooks.reveal(abs);
          else if (route === '/api/reveal') spawn('explorer.exe', ['/select,"' + abs + '"'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
          else {
            if (!OPENABLE.has(extOf(rel))) throw new Error('This type of file is not opened from the gallery.');
            if (hooks.openPath) hooks.openPath(abs); else spawn('explorer.exe', ['"' + abs + '"'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
          }
          return sendJSON(res, 200, { ok: true });
        }
      } catch (e) { return sendJSON(res, 409, { error: e.message, ...(e && e.extra) }); }   // extra: what the window needs to ask its question (a folder too broad to add)
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    log('request', e.stack || e);
    if (!res.headersSent) res.writeHead(500);
    res.end('error');
  }
}
const server = http.createServer((q, s) => handle(q, s, false));
// the switch, the pairing codes and the paired devices are kept on this computer only
const phone = require('./phone.js')({ file: process.env.GALLERY_PHONEFILE || path.join(process.env.GALLERY_LOCAL || path.join(require('os').homedir(), '.print-gallery'), 'phone.json'), handle: (q, s) => handle(q, s, true), log, name: () => brandOf().name });

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log('already running on port', PORT); process.exit(0); }
  log('server', e.stack || e); process.exit(1);
});
const ready = new Promise(resolve => server.listen(PORT, '127.0.0.1', () => {
  PORT = server.address().port;
  log('listening on http://localhost:' + PORT, 'root=' + ROOT);
  phone.start();   // only if the owner has switched phone access on
  if (!OUTDATED && !process.env.GALLERY_NO_USB) desk.start();   // notices drives being plugged in
  scan().catch(e => log('first scan failed', e.message));
  // notice changes made outside the app (downloads, slicer saves, Drive sync) without re-walking on a timer
  let wT;
  try {
    for (const l of LOCS) if (!l.home) watchLoc(l);
    fs.watch(ROOT, { recursive: true }, (ev, name) => {
      if (name && ownTop(name)) return;
      clearTimeout(wT); wT = setTimeout(() => scan().catch(() => {}), 3000);
    }).on('error', e => log('watch', e.message));
  } catch (e) { log('watch unavailable', e.message); }
  resolve(PORT);
}));
// for the desktop window's "drag a file out": where a file that is on show lives on this computer, and its preview picture if it
// has one. Anything else — a folder, a hidden or unknown path, something outside the library — answers null.
function fileOnShow(p) {
  const rel = safeRel(p), sc = visible(lastScan), f = rel && sc && sc.files.find(x => x.p === rel);
  return f ? { abs: absOf(rel), thumb: f.key && thumbs.get(f.key) === 'ok' ? path.join(THUMBS, f.key + '.img') : null } : null;
}
module.exports = { ready, hooks, ROOT, DATA, APPDIR, LOCS, VERSION, log, fileOnShow, noteSource, sourcesAt, outdated: OUTDATED ? { theirs: lastUsed.version, mine: VERSION } : null };
