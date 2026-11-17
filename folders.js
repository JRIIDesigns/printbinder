'use strict';
// IS A CHOSEN FOLDER TOO BROAD? One place decides, for the home folder (main.js: the first-run choice and File > Choose home
// folder) and for an other location (server.js: Locations > Add a folder, whether picked, typed or asked for by a paired phone).
// Chosen as it stands, a whole drive or a whole user folder would have every file on it listed, and the folders of Windows and
// of other programs would sit in the library where the owner's own clicks could rename or remove them.
//
// It starts from the list the 2.1.3 guard already has (main.js protectedFolders -> GALLERY_PROTECTED -> server.js KEPT) and
// sorts each folder on it into a kind:
//   REFUSE  — cannot be chosen at all:
//     drive    a drive's top folder (C:\, D:\ …)
//     users    the folder every person's files are in (C:\Users)
//     profile  a person's whole user folder (C:\Users\Name, and Public)
//     appdata  AppData, and anything inside it
//     system   Program Files, ProgramData, the Windows folder, and anything inside them
//     own      the folder the program is installed in and its settings folder, and anything inside them
//     kept     anything else on the list that could not be told apart
//   WARN, THEN ALLOW — a question whose ready answer is "Choose a different folder":
//     media    Documents, Desktop, Pictures, Music, Videos themselves
//     downloads  Downloads itself — as the HOME folder only; as an other location it is what locations are for, so no question
//     cloud    a cloud app's top folder: OneDrive's, or a folder named like one directly under a drive or the user folder
//   FINE — everything else, a folder inside any of the WARN ones included (Documents\3D Prints, My Drive\3D Prints).
//     ok       a kind a caller may give a folder on the list to say it is fine to choose all the same (a portable copy's folder)
// The kind of a folder on the list comes from `hints` when the caller knows it for certain (the desktop shell asks Windows,
// which matters when Documents has been moved somewhere unusual) and otherwise from its name and its place among the others.
// Nothing here opens a window or changes anything: it answers with a level and the words to show.
const fs = require('fs'), path = require('path');

const MEDIA = { desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', music: 'Music', pictures: 'Pictures', videos: 'Videos' };
const CLOUD = /^(my drive|google drive|dropbox|onedrive.*|icloud ?drive)$/i;
const SYSTEM = /^(program files( \(x86\))?|programdata|windows)$/i;
const REFUSE = new Set(['drive', 'users', 'profile', 'appdata', 'system', 'own', 'kept']);
const DEEP = new Set(['appdata', 'system', 'own']);   // refused all the way down

const key = p => path.resolve(String(p)).toLowerCase();
const sep = k => k.endsWith(path.sep) ? k : k + path.sep;
// a folder as written, and as Windows resolves it (short 8.3 names, links) when it is there
const keys = p => { const a = key(p), out = [a]; try { const r = fs.realpathSync.native(path.resolve(String(p))).toLowerCase(); if (r !== a) out.push(r); } catch {} return out; };
const isDriveTop = k => /^[a-z]:\\?$/.test(k);
const usable = p => typeof p === 'string' && !!p.trim() && !p.includes('\0') && path.isAbsolute(p.trim());

// What the environment says about this computer, as { folder: kind }. `env` and `home` are handed in so a test can pass made-up ones.
function hintsFromEnv(env, home) {
  const h = {}, put = (p, kind) => { if (usable(p)) h[path.resolve(p.trim())] = kind; };
  env = env || {};
  home = home || env.USERPROFILE || '';
  if (usable(home)) {
    put(path.dirname(home), 'users'); put(home, 'profile'); put(path.join(home, 'AppData'), 'appdata');
    for (const k of Object.keys(MEDIA)) put(path.join(home, MEDIA[k]), k === 'downloads' ? 'downloads' : 'media');
  }
  for (const k of ['APPDATA', 'LOCALAPPDATA']) put(env[k], 'appdata');
  for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData']) put(env[k], 'system');
  put(env.SystemRoot, 'windows');   // a system folder too; named apart so the drive it is on can be told from the others
  for (const k of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) put(env[k], 'cloud');
  return h;
}

// list: the protected folders (strings). hints: { folder: kind } for the ones whose kind is known (the kind 'windows' is a
// 'system' folder that also says which drive Windows is on, so that only that drive is described as holding Windows).
// opt.except: folders that are fine although they sit inside a refused-all-the-way-down one (a test's temp folder).
function build(list, hints, opt) {
  const byKey = new Map();   // key -> { path, kind }
  const put = (p, kind, sure) => {
    if (!usable(p)) return;
    const abs = path.resolve(p.trim());
    for (const k of keys(abs)) { const was = byKey.get(k); if (!was || (sure && !was.sure)) byKey.set(k, { path: abs, kind, sure: !!sure }); }
  };
  let sys = '';
  for (const p of Object.keys(hints || {})) { if (hints[p] === 'windows' && usable(p)) sys = p; put(p, hints[p] === 'windows' ? 'system' : hints[p], true); }
  const plain = (Array.isArray(list) ? list : []).filter(usable).map(p => path.resolve(p.trim()));
  const set = new Set(plain.map(key));
  const named = p => path.basename(p).toLowerCase();
  // a folder on the list whose Documents, Desktop … are on the list too is somebody's user folder; the folder above it holds everybody's
  const profiles = plain.filter(p => Object.keys(MEDIA).filter(n => set.has(key(path.join(p, n)))).length >= 2);
  for (const p of profiles) { put(p, 'profile'); put(path.join(p, 'AppData'), 'appdata'); if (set.has(key(path.dirname(p)))) put(path.dirname(p), 'users'); }
  for (const p of plain) {
    const n = named(p), up = named(path.dirname(p));
    if (isDriveTop(key(p))) continue;   // a drive is a drive, on the list or not
    if (n === 'appdata' || (up === 'appdata' && /^(roaming|local|locallow)$/.test(n))) { put(p, 'appdata'); if (up === 'appdata') put(path.dirname(p), 'appdata'); }
    else if (SYSTEM.test(n)) put(p, 'system');
    else if (MEDIA[n]) put(p, n === 'downloads' ? 'downloads' : 'media');
    else if (/^onedrive/.test(n)) put(p, 'cloud');
    else put(p, 'kept');
  }
  const entries = [...byKey].map(([k, v]) => ({ key: k, path: v.path, kind: v.kind }));
  if (!sys) sys = (entries.find(e => e.kind === 'system' && /^windows$/i.test(path.basename(e.path))) || {}).path;
  const except = ((opt && opt.except) || []).filter(usable).flatMap(p => keys(p.trim()));
  return { entries, except, systemDrive: sys ? key(path.parse(path.resolve(sys)).root) : '' };
}

// What `dir` is, for `use` ('home' or 'location'): { level: 'ok' | 'warn' | 'refuse', kind, path, name }
function classify(dir, use, rules) {
  const abs = path.resolve(String(dir)), ks = keys(abs), es = (rules && rules.entries) || [];
  const out = (level, kind, extra) => ({ level, kind, path: abs, name: path.basename(abs) || abs, use: use === 'home' ? 'home' : 'location', ...extra });
  for (const k of ks) if (isDriveTop(k)) return out('refuse', 'drive', { windows: !!rules && sep(k) === sep(rules.systemDrive || '') });
  let hit = null;
  for (const k of ks) { hit = es.find(e => e.key === k); if (hit) break; }
  // somebody else's user folder (Public too): anything directly inside the folder that holds everybody's
  const inUsers = ks.some(k => es.some(e => e.kind === 'users' && key(path.dirname(k)) === e.key));
  if (hit && REFUSE.has(hit.kind) && !(hit.kind === 'kept' && inUsers)) return out('refuse', hit.kind, { self: true });
  const spared = k => ((rules && rules.except) || []).some(x => k === x || k.startsWith(sep(x)));
  for (const k of ks) { const inside = es.find(e => DEEP.has(e.kind) && k.startsWith(sep(e.key))); if (inside && !ks.some(spared)) return out('refuse', inside.kind, { self: false, holder: inside.path }); }
  if (inUsers) return out('refuse', 'profile', { self: true, other: true });
  if (hit && hit.kind === 'downloads') return use === 'home' ? out('warn', 'downloads') : out('ok', 'downloads');
  if (hit && (hit.kind === 'media' || hit.kind === 'cloud')) return out('warn', hit.kind);
  // a cloud app's top folder, known by its name: directly under a drive, or directly inside a user folder
  if (CLOUD.test(path.basename(abs))) {
    for (const k of ks) { const up = key(path.dirname(k)); if (isDriveTop(up) || es.some(e => e.kind === 'profile' && e.key === up)) return out('warn', 'cloud'); }
  }
  return out('ok', '');
}

// ---------- the words ----------
const q = s => '\u201c' + s + '\u201d';
const INSTEAD = 'Choose the folder your 3D files are in instead, or make a new one';
const EXAMPLE = ', for example Documents\\3D Prints.';
// Why a folder cannot be chosen: one plain paragraph.
function refuseText(c, app) {
  const p = q(c.path);
  switch (c.kind) {
    case 'drive': return p + ' is a whole drive. ' + app + ' would list every file on it' + (c.windows ? ', including Windows and your other programs' : '') + '. ' + INSTEAD + '.';
    case 'users': return p + ' holds the files of everyone who uses this computer. ' + app + ' would list all of them, including the settings of other programs. ' + INSTEAD + EXAMPLE;
    case 'profile': return p + (c.other ? ' is a whole user folder. ' : ' is your whole user folder. ') + app + ' would list every file in it, including the settings of your other programs. ' + INSTEAD + EXAMPLE;
    case 'appdata': return p + (c.self ? ' is where' : ' is inside the folder where') + ' Windows and your other programs keep their settings. ' + app + ' leaves that alone. ' + INSTEAD + EXAMPLE;
    case 'system': return p + (c.self ? ' belongs' : ' is inside a folder that belongs') + ' to Windows and your installed programs. ' + app + ' leaves that alone. ' + INSTEAD + EXAMPLE;
    case 'own': return p + (c.self ? ' is' : ' is inside') + ' a folder ' + app + ' keeps for itself. Files put there can be replaced when the program is updated. ' + INSTEAD + EXAMPLE;
    default: return p + ' is a folder Windows and your other programs use. ' + app + ' would list everything in it. ' + INSTEAD + EXAMPLE;
  }
}
// The question before a WARN folder is used: a title, the paragraph, and the two answers (the first is the ready one).
function warnText(c, app) {
  const home = c.use === 'home';
  const what = c.kind === 'cloud' ? 'the top folder of a cloud drive, with everything you keep in it' : 'your whole ' + c.name + ' folder';
  const eg = (c.kind === 'cloud' ? c.name : c.kind === 'downloads' ? 'Documents' : c.name) + '\\3D Prints';
  return {
    title: 'Use all of ' + q(c.name) + '?',
    text: q(c.path) + ' is ' + what + '. If you ' + (home ? 'make it your home folder' : 'add it') + ', ' + app + ' will list every file in it, not only your 3D files. Nothing is changed until you approve it, and the folder itself will never be renamed or moved.\n\n'
      + 'It is usually better to make or pick a folder just for your 3D files, for example ' + eg + '.',
    other: 'Choose a different folder',   // the ready answer
    use: 'Use this folder',
  };
}
// what is wrong with listing everything in such a folder: a drive Windows is not on holds no Windows files to get wrong
const risk = c => c.kind === 'drive' && !c.windows ? ', whatever it is, not only your 3D files.' : ', including files that belong to Windows and your other programs, and those could be renamed or removed by mistake.';
// For an install that already has such a folder as its home folder or as a location: it keeps working, and is told once.
function noticeText(c, app, locName) {
  const home = c.use === 'home', p = q(c.path);
  const what = { drive: 'a whole drive', users: 'the folder that holds everyone\u2019s files on this computer', profile: c.other ? 'a whole user folder' : 'your whole user folder',
    appdata: c.self ? 'where Windows and your other programs keep their settings' : 'inside the folder where Windows and your other programs keep their settings',
    system: c.self ? 'a folder that belongs to Windows and your installed programs' : 'inside a folder that belongs to Windows and your installed programs',
    own: c.self ? 'a folder ' + app + ' keeps for itself' : 'inside a folder ' + app + ' keeps for itself' }[c.kind] || 'a folder Windows and your other programs use';
  return {
    what,
    title: home ? 'Your home folder is ' + what : 'The location ' + q(locName || c.name) + ' is ' + what,
    text: (home ? 'It is ' + p + '. ' : 'It shows ' + p + '. ') + app + ' lists every file in it' + risk(c) + ' '
      + 'Everything keeps working as it is, and nothing is changed unless you approve it. It is safer to ' + (home ? 'choose the folder your 3D files are in as your home folder.' : 'remove this location and add the folder your 3D files are in instead. Removing it from the list leaves its files exactly as they are.'),
    button: home ? 'Choose a different home folder\u2026' : 'Remove this location\u2026',
    later: 'Keep it as it is',
  };
}
// A refused folder that has been a library before (its previews, descriptions and history are in it): nobody is locked out of
// their own library, so it may still be chosen as the home folder — after the same kind of question, which says what the risk is.
function usedBeforeText(c, app) {
  const n = noticeText(c, app);
  return {
    title: 'Keep using ' + q(c.path) + '?',
    text: 'This folder has been used with ' + app + ' before, so its previews, descriptions and history are in it. But ' + q(c.path) + ' is ' + n.what + '. ' + app + ' lists every file in it' + risk(c) + '\n\n'
      + 'Nothing is changed until you approve it. It is safer to keep your 3D files in a folder of their own and choose that.',
    other: 'Choose a different folder',
    use: 'Keep using it',
  };
}
// Everything a caller needs in one go: the level and, when there is something to say, the words.
// more.usedBefore: the folder already holds a library (home folder only) — a refusal becomes a question.
function check(dir, use, rules, app, more) {
  const c = classify(dir, use, rules);
  if (c.level === 'refuse' && more && more.usedBefore && c.use === 'home') Object.assign(c, { level: 'warn', was: 'refuse', warn: usedBeforeText(c, app) });
  else if (c.level === 'refuse') c.text = refuseText(c, app);
  else if (c.level === 'warn') Object.assign(c, { warn: warnText(c, app) });
  return c;
}
// The message box for a folder that is not simply fine, as the desktop shell shows it. The first button is always the ready
// one and always "Choose a different folder"; useId is the button that goes ahead (-1 when the folder is refused).
function boxFor(c, app) {
  if (c.level === 'refuse') return { type: 'warning', title: app, message: c.use === 'home' ? 'That folder can’t be your home folder' : 'That folder can’t be added', detail: c.text, buttons: ['Choose a different folder', 'Cancel'], defaultId: 0, cancelId: 1, useId: -1, noLink: true };
  return { type: 'question', title: app, message: c.warn.title, detail: c.warn.text, buttons: [c.warn.other, c.warn.use, 'Cancel'], defaultId: 0, cancelId: 2, useId: 1, noLink: true };
}
// Choosing a folder, start to finish, with nothing of Electron in it: pick() opens the folder chooser and answers a path or
// null; ask(box) shows a message box and answers the number of the button pressed. Answers the folder, or null when given up.
async function choose({ pick, ask, use, rules, app, usedBefore }) {
  for (;;) {
    const dir = await pick();
    if (!dir) return null;
    const c = check(dir, use, rules, app, { usedBefore: !!(usedBefore && usedBefore(dir)) });
    if (c.level === 'ok') return dir;
    const box = boxFor(c, app), a = await ask(box);
    if (box.useId >= 0 && a === box.useId) return dir;
    if (a !== 0) return null;   // Cancel, or the box was closed; button 0 goes round again
  }
}

module.exports = { build, classify, check, choose, boxFor, hintsFromEnv, refuseText, warnText, noticeText, usedBeforeText };
