'use strict';
// "Find models online": a second window that shows model sites, walled off from the rest of the program.
//
// The gallery window only ever shows the program's own page. This window shows other people's pages, so it is kept apart:
//   - its pages run sandboxed, with no bridge to the program at all (no preload), in a session of their own: their cookies and
//     sign-ins are kept apart from everything else and can be cleared with one button;
//   - they cannot reach this computer or the home network: a request is refused when it is not http or https, when its address
//     is a private one or a bare name (as devices on a home network have), or when its name turns out to lead to a private
//     address. The gallery's own local server also refuses any request that does not name it exactly;
//   - they are given no permissions (camera, microphone, location, notifications, clipboard …);
//   - a pop-up (a site's "Sign in with Google" window) is a small window with the same walls, and its title is the address it shows;
//   - a download is never opened or run. Only the kinds of file a model site hands out are saved (3D files, zips, pictures,
//     instructions), into the library's unsorted folder, where Review can suggest a place for them; everything else is refused.
// Nothing about the pages visited is written down by the program, with one exception: the page a file was downloaded from is
// noted with that file (its address and what the page says the model is), so the model can be found and named properly later.
const { BrowserWindow, WebContentsView, session, ipcMain, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');

const TOOL_H = 88, TAB_H = 38;   // the height of the bar at the top, and of the row of tabs under it during a search (browser.html)
// Where each of the four sites answers a search: %s is where the words go. Each is the site's own results page, shown as it is.
const SEARCH = [['Printables', 'https://www.printables.com/search/models?q=%s'], ['MakerWorld', 'https://makerworld.com/en/search/models?keyword=%s'], ['Creality Cloud', 'https://www.crealitycloud.com/search?q=%s'], ['Thingiverse', 'https://www.thingiverse.com/search?q=%s&type=things']];
const PART = 'persist:pb-find-models';
// what is saved: 3D models and the files that travel with them
const KEEP = new Set(['stl', '3mf', 'obj', 'step', 'stp', 'iges', 'igs', 'amf', 'ply', 'glb', 'gltf', '3ds', 'dae', 'fbx', 'x3d', 'scad', 'f3d', 'f3z', 'fcstd', 'blend', 'skp', 'sldprt', 'dxf', 'gcode', 'bgcode',
  'zip', '7z', 'rar', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'pdf', 'txt', 'md', 'csv']);
const MAX_BYTES = 4 * 1024 * 1024 * 1024, MAX_AT_ONCE = 3, MAX_PER_MINUTE = 20;
const extOf = n => { const m = /\.([^./\\]+)$/.exec(n); return m ? m[1].toLowerCase() : ''; };
const LOCAL_PORT = !app.isPackaged && /^\d{4,5}$/.test(process.env.GALLERY_TEST_BROWSER_LOCAL || '') ? process.env.GALLERY_TEST_BROWSER_LOCAL : '';   // test hook, never in an installed copy: a test server on this one port of this computer
const localTest = u => !!LOCAL_PORT && u.hostname === '127.0.0.1' && u.port === LOCAL_PORT;

// Is this numeric address on this computer or a private network? Anything that is not plainly a public address counts as private.
function privateAddress(addr) {
  let a = String(addr || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (a.includes(':')) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (m) a = m[1];
    else return !/^[23][0-9a-f]{3}:/.test(a) || /^2002:/.test(a) || /^2001:(0?db8|0{0,4}):/.test(a);   // only global unicast (2000::/3) is public; 6to4, documentation and Teredo are not
  }
  const q = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (!q) return true;
  const [x, y] = [+q[1], +q[2]];
  return x === 0 || x === 10 || x === 127 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
}
// Judged as written: an address in numbers, a bare name such as "router" or "octopi", or a name kept for private use.
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (!h) return true;
  if (h.startsWith('[') || h.includes(':')) return true;   // an IPv6 address written out: not something a model site uses
  if (/^[\d.]+$/.test(h) || /^0x/.test(h)) return privateAddress(h);
  if (!h.includes('.')) return true;
  return /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa|test|invalid|example)$/.test(h);
}
function allowedSync(url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;   // made by the page itself, inside its sandbox
  if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'wss:' && u.protocol !== 'ws:') return false;
  if (localTest(u)) return true;
  return !isPrivateHost(u.hostname);
}
const hostText = url => { try { return new URL(url).hostname.replace(/^www\./, '') || ''; } catch { return ''; } };

module.exports = function makeBrowser(c) {   // c: { root(), rescan(), log(), source(file, info), have(url), show(p), count(words), searchLibrary(words) }
  let win = null, view = null, ses = null, home = true, wired = false;
  let mainView = null, tabs = [], tabAt = 0, searchQ = '', libCount = -1;   // a search: one tab per site, each loaded when it is first shown; view is always the page on show
  const popups = new Set();
  const log = (...a) => { try { if (c.log) c.log('find models:', ...a); } catch {} };   // faults only: never an address or a page
  const tell = (ch, data) => { try { if (win && !win.isDestroyed()) win.webContents.send(ch, data); } catch {} };
  const hist = () => view.webContents.navigationHistory || { canGoBack: () => view.webContents.canGoBack(), canGoForward: () => view.webContents.canGoForward(), goBack: () => view.webContents.goBack(), goForward: () => view.webContents.goForward() };
  const place = () => { if (!win || !view) return; const [w, h] = win.getContentSize(), top = TOOL_H + (tabs.length ? TAB_H : 0);
    for (const v of [mainView, ...tabs.map(t => t.view)]) if (v && v !== view) v.setVisible(false);
    view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) }); view.setVisible(!home); };

  // Sites the owner saved, shown on the start page beside the four that come with the program. Kept per computer, in the settings folder.
  // A saved site's search address: an address on that same site with %s where the words go. The owner pastes the address of a
  // search for the word "printbinder", and that word is where %s is put. Anything else is refused.
  function searchAddress(text, siteUrl) {
    let t = String(text || '').trim().slice(0, 600); if (!t) return '';
    if (!t.includes('%s')) t = t.replace(/printbinder/i, '%s');
    if (t.split('%s').length !== 2) return '';
    try { const u = new URL(t.replace('%s', 'x')), s = new URL(siteUrl); if (!/^https?:$/.test(u.protocol) || !allowedSync(u.href) || hostText(u.href) !== hostText(s.href)) return ''; } catch { return ''; }
    return t;
  }
  const sitesFile = () => path.join(app.getPath('userData'), 'browser-sites.json');
  const cleanUrl = url => { try { const u = new URL(url); if (!/^https?:$/.test(u.protocol) || !allowedSync(u.href)) return ''; u.hash = ''; u.username = ''; u.password = ''; return u.href; } catch { return ''; } };
  const readSites = () => { try { const j = JSON.parse(fs.readFileSync(sitesFile(), 'utf8')); return Array.isArray(j) ? j.filter(x => x && typeof x.url === 'string' && cleanUrl(x.url) === x.url).map(x => { const q = searchAddress(x.q, x.url); return { url: x.url, name: String(x.name || '').slice(0, 60), ...(q ? { q } : {}) }; }).slice(0, 60) : []; } catch { return []; } };
  const writeSites = list => { try { fs.writeFileSync(sitesFile(), JSON.stringify(list, null, 1)); } catch (e) { log('saved sites could not be written:', e.message); } };
  const sendSites = () => tell('pb-sites', readSites());
  const state = extra => { if (!view) return; const wc = view.webContents; tell('pb-state', { home, saved: !home && readSites().some(x => x.url === cleanUrl(wc.getURL())), url: home ? '' : wc.getURL(), title: home ? '' : wc.getTitle(), loading: !home && wc.isLoading(), back: !home, fwd: !home && hist().canGoForward(), ...extra }); };

  // A name that is fine as written may still lead to a private address (a public name pointed at a home network). Each name is
  // looked up the way the page's own request will be, and refused if any address it leads to is private. Answers are kept a minute.
  const looked = new Map();
  async function allowed(url) {
    if (!allowedSync(url)) return false;
    let u; try { u = new URL(url); } catch { return false; }
    if (!/^(https?|wss?):$/.test(u.protocol) || /^[\d.]+$/.test(u.hostname) || localTest(u)) return true;
    const h = u.hostname.toLowerCase(), had = looked.get(h);
    if (had && Date.now() - had.at < 60000) return had.ok;
    let ok = true;
    try { const r = await ses.resolveHost(h); const list = (r && r.endpoints) || []; ok = list.length > 0 && list.every(e => !privateAddress(e.address)); }
    catch { return true; }   // the name does not exist or cannot be looked up: the request fails by itself
    if (looked.size > 2000) looked.clear();
    looked.set(h, { ok, at: Date.now() });
    return ok;
  }

  function setUpSession() {
    ses = session.fromPartition(PART);
    ses.setPermissionRequestHandler((wc, perm, done) => done(false));
    ses.setPermissionCheckHandler(() => false);
    if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);
    ses.webRequest.onBeforeRequest((d, done) => { allowed(d.url).then(ok => done(ok ? {} : { cancel: true }), () => done({ cancel: true })); });
    ses.on('will-download', (e, item, from) => { download(item, from).catch(err => { try { item.cancel(); } catch {} log('download failed:', err && err.message); tell('pb-note', { bad: true, text: 'That download could not be saved.' }); }); });
  }

  // Where downloads go: the library's own holding folder if it has one ("Unsorted", "_Unsorted" …, at the top or one folder
  // down), otherwise a new "Unsorted" at the top. Review treats a folder of that name as files waiting to be sorted.
  function unsortedDir(root) {
    const isIt = n => n.toLowerCase().replace(/[^a-z0-9]/g, '') === 'unsorted';
    const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } };
    const top = dirs(root), hit = top.find(isIt);
    if (hit) return path.join(root, hit);
    for (const t of top) { if (/^[._$]/.test(t)) continue; const in2 = dirs(path.join(root, t)).find(isIt); if (in2) return path.join(root, t, in2); }
    return path.join(root, 'Unsorted');
  }
  function safeName(name) {
    let n = path.basename(String(name || '')).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
    const ext = extOf(n); let stem = ext ? n.slice(0, -(ext.length + 1)) : n;
    if (stem.length > 120) stem = stem.slice(0, 120).trim();
    if (!stem || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem)) stem = '_' + stem;
    return ext ? stem + '.' + ext : stem;
  }
  // What the page being shown says the model is: read once, at the moment a download starts. The page wrote every word of it,
  // so it comes back as plain text of limited length and is cleaned again where it is stored (server.js, cleanSource).
  const PAGE_FACTS = `(() => { const g = s => { const e = document.querySelector(s); return e ? String(e.getAttribute('content') || '') : ''; };
    let by = g('meta[name="author"]'), tags = [];
    try { for (const s of document.querySelectorAll('script[type="application/ld+json"]')) { let j; try { j = JSON.parse(s.textContent); } catch { continue; }
      for (const o of [].concat((j && j['@graph']) || j)) { if (!o || typeof o !== 'object') continue; const a = [].concat(o.author || o.creator || [])[0];
        if (!by && a) by = typeof a === 'string' ? a : String(a.name || ''); if (!tags.length && o.keywords) tags = Array.isArray(o.keywords) ? o.keywords : String(o.keywords).split(','); } } } catch {}
    let lt = '', lu = '';
    try { const a = document.querySelector('a[href*="creativecommons.org/licenses/"], a[href*="creativecommons.org/publicdomain/"], a[rel~="license"], link[rel~="license"]'); if (a) { lu = String(a.href || ''); lt = String(a.textContent || a.title || '').replace(/\s+/g, ' ').trim(); } } catch {}
    const kw = g('meta[name="keywords"]'); if (!tags.length && kw) tags = kw.split(',');
    return { marked: !!g('meta[property="og:title"]'), title: String(g('meta[property="og:title"]') || document.title || '').slice(0, 400), desc: String(g('meta[property="og:description"]') || g('meta[name="description"]') || '').slice(0, 3000),
      lt: String(lt).slice(0, 200), lu: String(lu).slice(0, 300), by: String(by || '').slice(0, 200), site: String(g('meta[property="og:site_name"]') || '').slice(0, 100), tags: tags.slice(0, 20).map(t => String(t).slice(0, 60)) }; })()`;
  async function pageFacts() {
    if (home || !view) return null;
    const wc = view.webContents, u = wc.getURL(); if (!/^https?:/i.test(u) || !allowedSync(u)) return null;
    let p = null; try { p = await Promise.race([wc.executeJavaScript(PAGE_FACTS, false), new Promise(ok => setTimeout(() => ok(null), 1500))]); } catch {}
    const info = { u };
    if (p && typeof p === 'object') {
      let ti = String(p.title || ''), by = String(p.by || ''); const site = String(p.site || '') || hostText(u).split('.')[0];
      // "Model name by Someone | Download free STL model | Site.com" and "Model name by Someone - Site": the model's name is the first part
      ti = ti.split(' | ')[0]; const tail = ti.lastIndexOf(' - '); if (tail > 0 && site && ti.slice(tail + 3).toLowerCase().replace(/[^a-z0-9]/g, '').includes(site.toLowerCase().replace(/[^a-z0-9]/g, ''))) ti = ti.slice(0, tail);
      const m = / by ([^|]{2,80})$/i.exec(ti); if (m) { if (!by) by = m[1]; ti = ti.slice(0, m.index); }
      info.ti = ti.trim(); info.by = by.trim(); if (p.marked === true) info.tq = 1;
      info.lt = String(p.lt || ''); info.lu = String(p.lu || ''); info.ab = String(p.desc || ''); info.tg = Array.isArray(p.tags) ? p.tags.map(String) : [];
    }
    return info;
  }
  const dlList = [];   // this run's downloads, newest first: { name, where, p } — shown on the start page, kept nowhere
  let have = [], haveFor = '', haveTimer = null;
  const sendSession = () => tell('pb-dl', dlList.map(d => ({ name: d.name, where: d.where })));
  function checkHave() {   // does the library already hold something from this page?
    clearTimeout(haveTimer);
    haveTimer = setTimeout(() => { if (!view || !c.have) return; const u = home ? '' : view.webContents.getURL(); have = u && /^https?:/i.test(u) ? c.have(u) : []; haveFor = u; tell('pb-have', { n: have.length, name: have[0] ? have[0].name : '' }); }, 350);
  }
  let lastDl = { url: '', at: 0 }, active = 0; const recent = [], claimed = new Set();
  function closeIfEmpty(wc) { try { for (const w of popups) if (w.webContents === wc && !/^https?:/i.test(wc.getURL())) setTimeout(() => { try { w.close(); } catch {} }, 300); } catch {} }
  async function download(item, from) {
    const full = String(item.getURL());
    if (full === lastDl.url && Date.now() - lastDl.at < 8000) { item.cancel(); return closeIfEmpty(from); }   // some sites ask for the same file twice: it is saved once
    lastDl = { url: full, at: Date.now() };
    closeIfEmpty(from);
    const refuse = text => { item.cancel(); tell('pb-note', { bad: true, text }); };
    const root = c.root();
    if (typeof root !== 'string' || !root) return refuse('Choose a home folder first; downloads are saved into your library.');
    const raw = safeName(item.getFilename() || 'download'), ext = extOf(raw);
    if (!KEEP.has(ext)) return refuse('“' + raw + '” was not downloaded: only 3D files, zips, pictures and instructions are saved here. Use “Open in my browser” for anything else.');
    const now = Date.now(); while (recent.length && now - recent[0] > 60000) recent.shift();
    if (active >= MAX_AT_ONCE) return refuse('“' + raw + '” was not downloaded: three downloads are running already. Try again when one has finished.');
    if (recent.length >= MAX_PER_MINUTE) return refuse('“' + raw + '” was not downloaded: this site has sent a great many files in the last minute.');
    if (item.getTotalBytes() > MAX_BYTES) return refuse('“' + raw + '” was not downloaded: it is larger than 4 GB.');
    const dir = unsortedDir(root), where = path.relative(root, dir).split(path.sep).join('/');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { return refuse('Could not make the folder “' + where + '”: ' + err.message); }
    let dest = path.join(dir, raw);
    for (let i = 2; fs.existsSync(dest) || fs.existsSync(dest + '.part') || claimed.has(dest.toLowerCase()); i++) dest = path.join(dir, raw.replace(/(\.[^.]+)?$/, ' (' + i + ')$1'));
    claimed.add(dest.toLowerCase()); recent.push(now); active++;
    item.setSavePath(dest + '.part');   // set at once, so no "Save as" window opens; the name is put right when the file has arrived whole
    const facts = pageFacts().catch(() => null);   // the page as it is now, before the owner moves on
    const short = raw.length > 60 ? raw.slice(0, 57) + '…' : raw;
    tell('pb-note', { text: 'Downloading “' + short + '” …' });
    item.on('updated', () => {
      if (item.getReceivedBytes() > MAX_BYTES) { item.cancel(); return; }
      const t = item.getTotalBytes(); tell('pb-note', { text: 'Downloading “' + short + '”' + (t ? ' ' + Math.round(100 * item.getReceivedBytes() / t) + '%' : ' …') });
    });
    item.once('done', (e, how) => {
      active = Math.max(0, active - 1); claimed.delete(dest.toLowerCase());
      if (how !== 'completed') { try { fs.rmSync(dest + '.part', { force: true }); } catch {} tell('pb-note', { bad: true, text: 'The download of “' + short + '” did not finish.' }); return; }
      try { if (fs.existsSync(dest)) throw new Error('a file of that name arrived first'); fs.renameSync(dest + '.part', dest); }
      catch (err) { try { fs.rmSync(dest + '.part', { force: true }); } catch {} log('a download could not be put in place:', err.message); tell('pb-note', { bad: true, text: 'Could not save “' + short + '”: ' + err.message }); return; }
      const got = path.basename(dest);
      tell('pb-note', { good: true, text: 'Saved “' + (got.length > 60 ? got.slice(0, 57) + '…' : got) + '” into “' + where + '” in your library.' });
      dlList.unshift({ name: got, where, p: path.relative(root, dest).split(path.sep).join('/') }); if (dlList.length > 100) dlList.pop(); sendSession();
      facts.then(info => { try { if (info && c.source) c.source(dest, { ...info, n: raw }); } catch {} }).finally(() => { try { c.rescan(); } catch {} setTimeout(checkHave, 2500); });
    });
  }

  // The walls every page here gets, the pop-ups included: no way round the refused addresses by a link, a redirect or a new
  // window, and nothing sent between computers on the home network by a video-call connection.
  function guard(wc, isPopup) {
    try { wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp'); } catch {}
    const fine = url => allowedSync(url) && /^(https?|about|blob|data):/i.test(url);
    const stop = (e, url) => { if (!fine(url)) { e.preventDefault(); if (!isPopup) tell('pb-note', { bad: true, text: 'That link cannot be opened here.' }); } };
    wc.on('will-navigate', stop);
    wc.on('will-redirect', stop);
    wc.on('will-frame-navigate', e => { try { if (!fine(e.url)) e.preventDefault(); } catch {} });
    wc.setWindowOpenHandler(({ url }) => {
      if (home && !isPopup) return { action: 'deny' };   // nothing opens windows from behind the start page
      if (url && url !== 'about:blank' && (!/^https?:/i.test(url) || !allowedSync(url))) return { action: 'deny' };
      if (popups.size >= 4) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: { parent: win, width: 540, height: 720, minWidth: 360, minHeight: 420, autoHideMenuBar: true, title: 'Opening…', icon: path.join(__dirname, 'icon.png'),
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, webviewTag: false, preload: undefined } } };
    });
    wc.on('did-create-window', w => {
      popups.add(w); w.setMenuBarVisibility(false);
      const pw = w.webContents; guard(pw, true);
      // the pop-up's title is the address it is showing, never what the page calls itself
      const title = () => { try { const h = hostText(pw.getURL()); w.setTitle(h ? h + ' — opened by ' + (hostText(wc.getURL()) || 'this page') : 'Opening…'); } catch {} };
      pw.on('page-title-updated', e => { e.preventDefault(); title(); });
      pw.on('did-navigate', title); pw.on('did-navigate-in-page', title);
      w.on('closed', () => popups.delete(w));
    });
  }

  function makeView() {
    const v = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, webviewTag: false } });
    win.contentView.addChildView(v); v.setVisible(false);
    const wc = v.webContents, shown = f => () => { if (v === view) f(); };   // a tab in the background does not speak for the window
    guard(wc, false);
    wc.on('did-navigate', shown(() => { state(); checkHave(); }));
    wc.on('did-navigate-in-page', shown(() => { state(); checkHave(); }));
    wc.on('page-title-updated', shown(() => state()));
    wc.on('did-start-loading', shown(() => state()));
    wc.on('did-stop-loading', shown(() => state()));
    wc.on('did-fail-load', (e, code, desc, url, isMain) => { if (v !== view) return; if (isMain && code !== -3 && !home) tell('pb-note', { bad: true, text: 'The page could not be opened (' + desc + ').' }); state(); });
    return v;
  }
  const dropView = v => { try { win.contentView.removeChildView(v); } catch {} try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch {} };
  const sendTabs = () => tell('pb-tabs', { q: searchQ, at: tabAt, lib: libCount, tabs: tabs.map(t => t.name) });
  // One search, a tab for each site: the four that come with the program, and any saved site that was given a search address.
  // Each tab is that site's own results page, and is only loaded when it is first looked at.
  function search(words) {
    const q = String(words || '').replace(/\s+/g, ' ').trim().slice(0, 120); if (!q) return;
    endSearch();
    const list = [...SEARCH, ...readSites().filter(s => s.q).map(s => [s.name || hostText(s.url), s.q])].slice(0, 12);
    tabs = list.map(([name, tpl]) => ({ name: String(name).slice(0, 40), url: tpl.replace('%s', encodeURIComponent(q)), view: null })).filter(t => allowedSync(t.url));
    if (!tabs.length) return;
    searchQ = q; libCount = -1; home = false; showTab(0);
    if (c.count) Promise.resolve(c.count(q)).then(n => { if (searchQ === q) { libCount = Number.isFinite(+n) ? +n : -1; sendTabs(); } }).catch(() => {});
  }
  function showTab(i) {
    const t = tabs[i]; if (!t) return;
    if (!t.view) { t.view = makeView(); t.view.webContents.loadURL(t.url).catch(() => {}); }
    tabAt = i; view = t.view; home = false; place(); sendTabs(); state(); checkHave();
  }
  function endSearch() {
    if (!tabs.length) return;
    for (const t of tabs) if (t.view) dropView(t.view);
    tabs = []; tabAt = 0; searchQ = ''; libCount = -1; view = mainView; sendTabs();
  }

  function go(url) {
    let u = String(url || '').trim(); if (!u) return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = /^[^\s/]+\.[^\s/]+(\/.*)?$/.test(u) ? 'https://' + u : 'https://duckduckgo.com/?q=' + encodeURIComponent(u);
    try { u = new URL(u).href; } catch { u = ''; }
    if (!/^https?:/i.test(u) || !allowedSync(u)) { tell('pb-note', { bad: true, text: 'That address cannot be opened here.' }); return; }
    home = false; place(); view.webContents.loadURL(u).catch(() => {}); state();
  }
  // Back to the start page: the page left behind is unloaded, not just hidden, and its pop-ups go with it.
  function goHome() { endSearch(); home = true; checkHave(); place(); const wc = view.webContents; wc.stop(); wc.loadURL('about:blank').catch(() => {}); for (const w of popups) { try { w.close(); } catch {} } state(); }
  function backUrl() { try { const h = view.webContents.navigationHistory, i = h.getActiveIndex(); return i > 0 ? h.getEntryAtIndex(i - 1).url : ''; } catch { return ''; } }

  function wire() {
    if (wired) return; wired = true;
    const mine = e => win && !win.isDestroyed() && e.sender === win.webContents;   // only the bar of this window is listened to
    ipcMain.on('pb-nav', (e, m) => {
      if (!mine(e) || !view || !m) return;
      const wc = view.webContents, h = hist();
      if (m.a === 'go') go(m.url);
      else if (m.a === 'home') goHome();
      else if (m.a === 'back') { const b = backUrl(); if (!home && h.canGoBack() && b && b !== 'about:blank') h.goBack(); else if (!tabs.length) goHome(); state(); }   // in a search, the first page of a tab is as far back as it goes
      else if (m.a === 'search') search(m.url);
      else if (m.a === 'tab') showTab(m.i | 0);
      else if (m.a === 'libshow') { if (searchQ && c.searchLibrary) c.searchLibrary(searchQ); }
      else if (m.a === 'setq') {   // give a saved site a search address, or take it away
        const u = cleanUrl(m.url), list = readSites(), s = list.find(x => x.url === u); if (!s) return;
        const q = searchAddress(m.q, u);
        if (String(m.q || '').trim() && !q) { tell('pb-note', { bad: true, text: 'That is not a search address on that site. Search the site for the word printbinder and paste the address of the results.' }); return; }
        if (q) s.q = q; else delete s.q;
        writeSites(list); sendSites(); tell('pb-note', { good: true, text: q ? 'Saved. “' + (s.name || hostText(u)) + '” gets a tab in your searches now.' : 'Taken out of your searches.' });
      }
      else if (m.a === 'fwd') { if (!home && h.canGoForward()) h.goForward(); }
      else if (m.a === 'reload') { if (!home) wc.reload(); }
      else if (m.a === 'stop') wc.stop();
      else if (m.a === 'outside') { const u = wc.getURL(); if (!home && /^https?:/i.test(u)) shell.openExternal(u); }
      else if (m.a === 'sites') { sendSites(); sendSession(); sendTabs(); }
      else if (m.a === 'showhave') { if (have[0] && c.show) c.show(have[0].p); }
      else if (m.a === 'showdl') { const d = dlList[m.i | 0]; if (d && c.show) c.show(d.p); }
      else if (m.a === 'save') {   // the page being shown, or taken off the list again if it is already on it
        const u = home ? '' : cleanUrl(wc.getURL()); if (!u) return;
        let list = readSites();
        if (list.some(x => x.url === u)) { list = list.filter(x => x.url !== u); tell('pb-note', { text: 'Taken off your saved sites.' }); }
        else if (list.length >= 60) { tell('pb-note', { bad: true, text: 'Sixty sites are saved already. Take one off first.' }); return; }
        else { const host = hostText(u); list.push({ url: u, name: (wc.getTitle() || host).replace(/[ \t\r\n]+/g, ' ').trim().slice(0, 60) || host }); tell('pb-note', { good: true, text: 'Saved. It is on the start page now (the house button).' }); }
        writeSites(list); sendSites(); state();
      }
      else if (m.a === 'unsave') { const u = cleanUrl(m.url); writeSites(readSites().filter(x => x.url !== u)); sendSites(); state(); }
      else if (m.a === 'clear') {
        for (const w of popups) { try { w.close(); } catch {} }
        ses.clearStorageData().then(() => ses.clearCache()).then(() => ses.clearAuthCache()).then(() => { looked.clear(); tell('pb-note', { good: true, text: 'Sign-ins, cookies and saved pages for this window were cleared.' }); if (!home) wc.reload(); }).catch(err => log('clearing failed:', err && err.message));
      }
    });
  }

  function open(url) {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); if (url) go(url); return; }
    if (!ses) setUpSession();
    wire();
    win = new BrowserWindow({ width: 1280, height: 860, minWidth: 640, minHeight: 420, title: 'Find models online', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'browser-preload.js') } });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());   // the bar never goes anywhere itself
    win.loadFile(path.join(__dirname, 'browser.html'));
    tabs = []; tabAt = 0; searchQ = ''; libCount = -1;
    mainView = view = makeView();
    home = true;
    win.on('resize', place);
    win.once('ready-to-show', () => { place(); win.show(); state(); sendSites(); sendTabs(); if (url) go(url); });
    win.on('closed', () => { for (const w of popups) { try { w.close(); } catch {} } for (const v of [mainView, ...tabs.map(t => t.view)]) { try { if (v && !v.webContents.isDestroyed()) v.webContents.close(); } catch {} } win = null; view = null; mainView = null; tabs = []; searchQ = ''; });
  }
  return { open, close: () => { if (win && !win.isDestroyed()) win.close(); } };
};
module.exports.isPrivateHost = isPrivateHost;
module.exports.privateAddress = privateAddress;
module.exports.allowedSync = allowedSync;
