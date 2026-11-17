'use strict';
// Things that belong to the computer the app runs on, not to the shared library:
//   - slicers: the programs a model can be sent to (the list is kept per computer);
//   - drives: noticing a USB stick, card or external drive being plugged in, and importing its 3D files on request.
// Nothing here acts by itself: a slicer starts only on "Send to slicer", a drive is only read until "Import" is pressed.
const fs = require('fs'), fsp = fs.promises, path = require('path'), { execFile, spawn } = require('child_process');

module.exports = function (c) {
  const lc = s => String(s).toLowerCase();
  const exists = async p => { try { await fsp.stat(p); return true; } catch { return false; } };

  // ---------- slicers ----------
  const SFILE = process.env.GALLERY_SLICERFILE || path.join(c.localDir, 'slicers.json');
  const SLICE = new Set([...c.MODEL, 'amf']);
  let sl = { list: [], def: '' };
  try { const j = JSON.parse(fs.readFileSync(SFILE, 'utf8')); if (Array.isArray(j.list)) sl = { list: j.list.filter(x => x && x.id && x.exe), def: String(j.def || '') }; } catch {}
  const saveSl = () => { fs.mkdirSync(path.dirname(SFILE), { recursive: true }); fs.writeFileSync(SFILE, JSON.stringify(sl, null, 2)); };
  const defOf = () => (sl.list.find(x => x.id === sl.def) || sl.list[0] || { id: '' }).id;
  // Programs known to be slicers, by the name of their program file.
  const EXE = /^(orca-slicer|bambu-studio|prusa-slicer|superslicer|crealityprint|creality[ _-]?print|snapmaker[-_ ]?orca|ultimaker-cura|cura|elegoo-?slicer|anycubicslicer(next)?|qidi-?studio|orca-flashforge|flashprint|ideamaker|simplify3d|lycheeslicer|chitubox(pro)?|luban|snapmaker luban|[\w .-]*slicer)\.exe$/i;
  const DIR = /slicer|orca|bambu|prusa|creality|snapmaker|cura|ultimaker|elegoo|anycubic|qidi|flashforge|flashprint|ideamaker|simplify3d|lychee|chitubox|luban/i;
  const NOT = /unins|setup|install|update|crash|report|helper|console|launcher-helper/i;
  const niceName = exe => {
    let d = path.dirname(exe);
    if (/^(bin|x64|win64|app)$/i.test(path.basename(d))) d = path.dirname(d);
    return path.basename(d).replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || path.basename(exe, '.exe');
  };
  async function walk(dir, depth, out) {
    let es; try { es = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.isFile() && EXE.test(e.name) && !NOT.test(e.name)) out.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth > 0 && !/^(resources|locales|plugins|share|lib|python\d*)$/i.test(e.name)) await walk(path.join(dir, e.name), depth - 1, out);
    }
  }
  let foundAt = 0, foundList = [];
  async function detect() {
    if (Date.now() - foundAt < 60000) return foundList;
    const exes = [], env = process.env;
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.LOCALAPPDATA].filter(Boolean)) {
      let es; try { es = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const e of es) if (e.isDirectory() && DIR.test(e.name)) await walk(path.join(root, e.name), 3, exes);
    }
    const named = new Map();
    if (c.hooks.shortcuts) { try { for (const s of await c.hooks.shortcuts()) if (s.target && EXE.test(path.basename(s.target)) && !NOT.test(path.basename(s.target))) { exes.push(s.target); named.set(lc(s.target), s.name); } } catch {} }
    const seen = new Set(), out = [];
    for (const exe of exes) { const k = lc(path.resolve(exe)); if (seen.has(k) || !(await exists(exe))) continue; seen.add(k); out.push({ name: named.get(lc(exe)) || niceName(exe), exe: path.resolve(exe) }); }
    // an updater's private copy of a program that is also installed normally shows up under a version number: leave it out
    const base = x => lc(path.basename(x.exe));
    for (let i = out.length - 1; i >= 0; i--) if (/^\d/.test(out[i].name) && out.some((o, j) => j !== i && base(o) === base(out[i]) && !/^\d/.test(o.name))) out.splice(i, 1);
    out.sort((a, b) => a.name.localeCompare(b.name));
    foundAt = Date.now(); return foundList = out;
  }
  async function slicers() {
    const list = await Promise.all(sl.list.map(async x => ({ ...x, ok: await exists(x.exe) })));
    const have = new Set(sl.list.map(x => lc(x.exe)));
    return { list, def: defOf(), found: (await detect()).filter(f => !have.has(lc(f.exe))), canPick: !!c.hooks.pickExe };
  }
  async function addSlicer(exe, name) {
    if (typeof exe !== 'string' || !path.isAbsolute(exe) || !/\.exe$/i.test(exe)) throw new Error('Choose the slicer’s program file (it ends in .exe).');
    exe = path.resolve(exe);
    const st = await fsp.stat(exe).catch(() => null);
    if (!st || !st.isFile()) throw new Error('That program file could not be found.');
    if (sl.list.some(x => lc(x.exe) === lc(exe))) throw new Error('That slicer is already in the list.');
    const it = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(name || '').trim().slice(0, 60) || niceName(exe), exe };
    sl.list.push(it); if (!sl.def) sl.def = it.id; saveSl();
    c.log('slicer added', JSON.stringify(it.name), exe);
    return it;
  }
  async function sendTo(p, id) {
    const rel = c.safeRel(p);
    if (!rel) throw new Error('bad path');
    if (!SLICE.has(c.extOf(rel))) throw new Error('Only 3D model files are sent to a slicer.');
    const s = sl.list.find(x => x.id === (id || defOf()));
    if (!s) throw new Error('No slicer is set up yet.');
    const abs = c.absOf(rel);
    if (!(await exists(abs))) throw new Error('That file is no longer there.');
    if (!(await exists(s.exe))) throw new Error(s.name + ' could not be found where it was. Check it in Slicers.');
    spawn(s.exe, [abs], { detached: true, stdio: 'ignore', cwd: path.dirname(s.exe) }).on('error', e => c.log('slicer start failed', e.message)).unref();
    c.log('sent to slicer', JSON.stringify(s.name), JSON.stringify(rel));
    return { ok: true, name: s.name };
  }

  // ---------- drives being plugged in ----------
  const drives = new Map();   // letter -> { letter, label, state: 'looking' | 'ready' | 'importing' | 'done', files, count, fresh, hidden, loc, done, total, result }
  let known = null, ticking = false;
  const ps = script => new Promise(ok => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 }, (e, out) => ok(e ? '' : String(out))));
  // letter -> { type: 2 removable | 3 fixed | 4 network | 5 disc, label }
  async function diskInfo() {
    const out = {}, t = await ps('Get-CimInstance Win32_LogicalDisk | ForEach-Object { "$($_.DeviceID)|$($_.DriveType)|$($_.VolumeName)" }');
    for (const line of t.split(/\r?\n/)) { const m = /^([A-Z]):\|(\d+)\|(.*)$/i.exec(line.trim()); if (m) out[m[1].toUpperCase()] = { type: +m[2], label: m[3].trim() }; }
    return out;
  }
  async function letters() {
    if (process.env.GALLERY_USB_FAKE) { try { return JSON.parse(await fsp.readFile(process.env.GALLERY_USB_FAKE, 'utf8')).map(d => d.letter); } catch { return []; } }   // test hook: a file listing pretend drives
    const out = [];
    await Promise.all('DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async L => { try { await fsp.access(L + ':\\'); out.push(L); } catch {} }));
    return out.sort();
  }
  const rootOf = d => d.root || d.letter + ':\\';
  const inUse = L => c.LOCS.some(l => !l.usb && lc(path.resolve(l.root)).startsWith(lc(L) + ':'));   // the library itself, or a location the owner added
  async function look(d) {
    const files = [], SKIPD = /^(\$|\.)|^system volume information$|^found\.\d+$/i;
    const go = async (dir, rel, depth) => {
      let es; try { es = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        if (files.length >= 20000) return;
        if (e.isDirectory()) { if (depth < 12 && !SKIPD.test(e.name) && lc(e.name) !== lc(c.TRASH)) await go(path.join(dir, e.name), rel ? rel + '/' + e.name : e.name, depth + 1); }
        else if (e.isFile() && c.MODEL.has(c.extOf(e.name))) { const st = await fsp.stat(path.join(dir, e.name)).catch(() => null); if (st) files.push({ rel: rel ? rel + '/' + e.name : e.name, s: st.size }); }
      }
    };
    await go(rootOf(d), '', 0);
    await c.freshScan().catch(() => {});   // compare against the library as it is now, not as it was last listed
    const sc = c.getScan(), have = new Set((sc ? sc.files : []).filter(f => f.p[0] !== ':').map(f => lc(c.baseOf(f.p)) + '|' + f.s));
    d.files = files; d.count = files.length; d.fresh = files.filter(f => !have.has(lc(c.baseOf(f.rel)) + '|' + f.s)).length;
    d.state = 'ready';
    c.log('drive', d.letter + ':', JSON.stringify(d.label), 'has', d.count, '3D files,', d.fresh, 'look new');
  }
  async function tick() {
    if (ticking) return; ticking = true;
    try {
      const now = await letters(), first = known === null, fresh = first ? now : now.filter(L => !known.includes(L));
      for (const L of [...drives.keys()]) if (!now.includes(L)) {   // pulled out
        const d = drives.get(L); drives.delete(L);
        if (d.loc) c.removeLocation(d.loc).catch(() => {});
        c.log('drive', L + ':', 'removed');
      }
      known = now;
      const cand = fresh.filter(L => !drives.has(L) && !inUse(L));
      if (cand.length) {
        let info = {};
        if (process.env.GALLERY_USB_FAKE) { try { for (const d of JSON.parse(await fsp.readFile(process.env.GALLERY_USB_FAKE, 'utf8'))) info[d.letter] = { type: 2, label: d.label || '', root: d.root }; } catch {} }
        else info = await diskInfo();
        for (const L of cand) {
          const i = info[L];
          if (!i || (first ? i.type !== 2 : (i.type !== 2 && i.type !== 3))) continue;   // at start only true removable drives; later anything newly plugged in except network drives and discs
          const d = { letter: L, label: i.label || '', root: i.root, state: 'looking', files: [], count: 0, fresh: 0 };
          drives.set(L, d);
          look(d).catch(e => { c.log('drive look failed', e.message); drives.delete(L); });
        }
      }
    } catch (e) { c.log('drive check', e.message); }
    ticking = false;
  }
  const usbState = () => ({ drives: [...drives.values()].filter(d => !d.hidden && d.state !== 'looking' && d.count > 0).map(d => ({ letter: d.letter, label: d.label, count: d.count, fresh: d.fresh, state: d.state, done: d.done || 0, total: d.total || 0, result: d.result || null, shown: !!d.loc })) });
  const stamp = () => { const t = new Date(), p = n => String(n).padStart(2, '0'); return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()); };
  // Copy (or move) every 3D file on the drive into a dated folder in the home library. Each file is copied and checked byte for
  // byte; in "move" the original is removed from the drive only after its copy has passed that check. Files the library
  // already holds, byte for byte, are left alone and counted.
  async function importDrive(d, mode) {
    const move = mode === 'move', sc = c.getScan();
    const bySize = new Map();
    for (const f of (sc ? sc.files : [])) if (f.p[0] !== ':') (bySize.get(f.s) || bySize.set(f.s, []).get(f.s)).push(f.p);
    const label = c.cleanName(d.label || '') || 'Drive ' + d.letter, base = 'Imported/' + label + ' ' + stamp();
    const res = { imported: 0, had: 0, failed: 0, why: '', dest: base, ids: [], mode: move ? 'move' : 'copy' };
    d.state = 'importing'; d.done = 0; d.total = d.files.length;
    c.refreshState();
    for (const f of d.files) {
      const src = path.join(rootOf(d), ...f.rel.split('/'));
      try {
        let dup = false;
        const cands = bySize.get(f.s) || [];
        if (cands.length) { const h = await c.hashFile(src); for (const p of cands) { if (await c.hashFile(c.absOf(p)).catch(() => '') === h) { dup = true; break; } } }
        if (dup) res.had++;
        else {
          const parts = f.rel.split('/').map(x => c.cleanName(x) || 'file'), ext = (/\.[^.]+$/.exec(parts[parts.length - 1]) || [''])[0];
          let toRel = base + '/' + parts.join('/');
          for (let i = 2; await exists(c.absOf(toRel)); i++) toRel = base + '/' + parts.slice(0, -1).concat(parts[parts.length - 1].slice(0, parts[parts.length - 1].length - ext.length) + ' (' + i + ')' + ext).join('/');
          await fsp.mkdir(path.dirname(c.absOf(toRel)), { recursive: true });
          await c.copyVerified(src, c.absOf(toRel));
          if (move) await fsp.unlink(src);
          const h = c.record('import', (d.label || d.letter + ':') + '/' + f.rel, toRel);
          h.copy = !move; h.abs = src;
          res.ids.push(h.id); res.imported++;
          (bySize.get(f.s) || bySize.set(f.s, []).get(f.s)).push(toRel);
        }
      } catch (e) {
        res.failed++; res.why = res.why || (e.code || e.message);
        if (!(await exists(rootOf(d)))) { res.why = 'the drive was removed part-way'; break; }   // nothing half-written: an unfinished copy is withdrawn by copyVerified
      }
      d.done++;
    }
    c.saveState();
    c.log('import from', d.letter + ':', JSON.stringify(res));
    await c.freshScan().catch(() => {});
    d.result = res; d.state = 'done';
  }

  async function handle(req, route, body, remote) {
    if (req.method === 'GET') {
      if (route === '/api/slicers') return slicers();
      if (route === '/api/usb') return usbState();
      return null;
    }
    if (route === '/api/slicers/add') {
      let exe = body.exe;
      if (!exe) { if (!c.hooks.pickExe) throw new Error('Type the full path of the slicer’s program file.'); exe = await c.hooks.pickExe(); if (!exe) return { ok: true, cancelled: true, ...(await slicers()) }; }
      await addSlicer(exe, body.name); return { ok: true, ...(await slicers()) };
    }
    if (route === '/api/slicers/remove') { sl.list = sl.list.filter(x => x.id !== body.id); if (sl.def === body.id) sl.def = ''; saveSl(); return { ok: true, ...(await slicers()) }; }
    if (route === '/api/slicers/default') { if (sl.list.some(x => x.id === body.id)) { sl.def = body.id; saveSl(); } return { ok: true, ...(await slicers()) }; }
    if (route === '/api/slicers/rename') { const s = sl.list.find(x => x.id === body.id), n = String(body.name || '').trim().slice(0, 60); if (s && n) { s.name = n; saveSl(); } return { ok: true, ...(await slicers()) }; }
    if (route === '/api/slicers/send') return sendTo(body.p, body.id);
    if (route.startsWith('/api/usb/')) {
      const d = drives.get(String(body.letter || '').toUpperCase());
      if (!d) throw new Error('That drive is no longer connected.');
      if (route === '/api/usb/dismiss') { d.hidden = true; return { ok: true, ...usbState() }; }
      if (route === '/api/usb/show') {
        if (!d.loc) { const l = await c.addLocation(rootOf(d), { usb: true }); d.loc = l.name; }
        return { ok: true, loc: d.loc, ...usbState() };
      }
      if (route === '/api/usb/import') {
        if (d.state === 'importing') throw new Error('That drive is already being imported.');
        if (d.state !== 'ready' && d.state !== 'done') throw new Error('Still looking through that drive — try again in a moment.');
        if (d.state === 'done') await look(d);   // a second import: read the drive again first
        importDrive(d, body.mode === 'move' ? 'move' : 'copy').catch(e => { c.log('import failed', e.message); d.result = { imported: 0, had: 0, failed: d.files.length, why: e.message, ids: [], dest: '' }; d.state = 'done'; });
        return { ok: true, ...usbState() };
      }
    }
    return null;
  }
  function start() { tick(); setInterval(tick, 4000).unref(); }
  return { handle, start, slicers };
};
