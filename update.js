'use strict';
// Looks for a newer version of the program and fetches its installer. Nothing here runs by itself: Help > Check for updates asks first.
// Three places are tried, in order:
//   1. the project's GitHub releases, read openly (works once the project is public);
//   2. the same releases through the GitHub command-line program, if it is installed and signed in on this computer
//      (needed while the project is private — its sign-in stays with that program, the app never sees it);
//   3. <home library>/<data folder>/updates/latest.json, which travels with the library to every computer that shares it.
// What an installer file is called (PrintBinder-Setup-1.2.3.exe) comes from the name in brand.js. A file named after one of
// the program's former names (Print-Gallery-Setup-1.2.3.exe) is accepted too: a release carries the same installer under both
// names, for the installs that only know the old one (docs/RELEASING.md). Where a release has both, the one under today's name
// is taken. A file named otherwise is never fetched or started.
const fs = require('fs'), path = require('path'), { execFile, spawn } = require('child_process'), { once } = require('events');
const brand = require('./brand.js');

const nums = v => String(v || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
const newer = (a, b) => { const x = nums(a), y = nums(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
const isSetup = n => brand.isSetup(n);
const pickSetup = assets => (assets || []).find(x => x && String(x.name).startsWith(brand.setupPrefix) && isSetup(x.name)) || (assets || []).find(x => x && isSetup(x.name));
const run = (exe, args, ms) => new Promise((ok, no) => execFile(exe, args, { windowsHide: true, timeout: ms || 30000, maxBuffer: 4 << 20 }, (e, out) => e ? no(e) : ok(out)));

module.exports = function ({ repo, libDir, tmpDir }) {
  const ghExes = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'), 'gh'];
  async function gh(args, ms) {
    let last;
    for (const exe of ghExes) { try { return await run(exe, args, ms); } catch (e) { last = e; if (e.code !== 'ENOENT') break; } }
    throw last;
  }
  async function fromWeb() {
    const r = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': brand.slug }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('GitHub answered ' + r.status);
    const j = await r.json(), a = pickSetup(j.assets);
    if (!a) throw new Error('that release has no installer');
    return { version: String(j.tag_name).replace(/^v/i, ''), notes: j.body || '', source: 'web', name: a.name, url: a.browser_download_url, size: +a.size || 0 };
  }
  async function fromGh() {
    const j = JSON.parse(await gh(['release', 'view', '--repo', repo, '--json', 'tagName,body,assets']));
    const a = pickSetup(j.assets);
    if (!a) throw new Error('that release has no installer');
    return { version: String(j.tagName).replace(/^v/i, ''), notes: j.body || '', source: 'gh', name: a.name, tag: j.tagName, size: +a.size || 0 };
  }
  async function fromLibrary() {
    const dir = path.join(libDir, 'updates'), j = JSON.parse(await fs.promises.readFile(path.join(dir, 'latest.json'), 'utf8'));
    if (!isSetup(j.file)) throw new Error('no installer named in latest.json');
    await fs.promises.access(path.join(dir, j.file));
    return { version: String(j.version), notes: j.notes || '', source: 'library', name: j.file, file: path.join(dir, j.file) };
  }
  // Test hook: GALLERY_UPDATE_FAKE names a JSON file { version, file, slow } describing a pretend newer version, so that the whole
  // update flow can be exercised without a real release. file must be named like an installer; it is never checked for size.
  async function fromFake() {
    const j = JSON.parse(await fs.promises.readFile(process.env.GALLERY_UPDATE_FAKE, 'utf8'));
    if (!isSetup(path.basename(String(j.file)))) throw new Error('the pretend installer is not named like one');
    return { version: String(j.version), notes: j.notes || '', source: 'library', fake: true, slow: +j.slow || 0, name: path.basename(j.file), file: j.file, size: (await fs.promises.stat(j.file)).size };
  }
  // The newest version any of the three places knows about.
  async function check(current) {
    const found = [], why = [];
    for (const f of process.env.GALLERY_UPDATE_FAKE ? [fromFake] : [fromWeb, fromGh, fromLibrary]) { try { found.push(await f()); } catch (e) { why.push(e.message.split('\n')[0]); } }
    if (!found.length) return { current, reached: false, why };
    const best = found.reduce((a, b) => newer(b.version, a.version) ? b : a);
    return { current, reached: true, latest: best.version, newer: newer(best.version, current), notes: best.notes, pick: best };
  }
  // Puts the installer in a temporary folder on this computer and returns where it is.
  // opt.onProgress(done, total) is called with the bytes that have arrived so far (total is 0 when the size is not known);
  // opt.signal (an AbortSignal) stops it: what had arrived is removed and the error is marked .cancelled.
  async function fetchInstaller(pick, opt = {}) {
    const dir = path.join(tmpDir, brand.slug + '-update');
    await fs.promises.rm(dir, { recursive: true, force: true }); await fs.promises.mkdir(dir, { recursive: true });
    const out = path.join(dir, pick.name), sig = opt.signal, say = (d, t) => { try { if (opt.onProgress) opt.onProgress(d, t || 0); } catch {} };
    const stopped = () => Object.assign(new Error('The update was cancelled.'), { cancelled: true });
    if (!isSetup(pick.name)) throw new Error('Unexpected installer name');
    // one way of writing the file for both a copy and a download, counting the bytes as they go
    const pour = async (chunks, total) => {
      const ws = fs.createWriteStream(out);
      let done = 0;
      try {
        for await (const c of chunks) {
          if (sig && sig.aborted) throw stopped();
          if (!ws.write(c)) await once(ws, 'drain');   // waits for the disk; a write error ends the wait too
          done += c.length; say(done, total);
          if (pick.slow) await new Promise(r => setTimeout(r, pick.slow));   // only a pretend update (the test hook) is slowed down, so its progress can be watched
        }
        await new Promise((ok, no) => ws.end(e => e ? no(e) : ok()));
      } catch (e) { ws.destroy(); throw sig && sig.aborted ? stopped() : e; }
    };
    try {
      say(0, pick.size);
      if (pick.source === 'library') {
        const total = (await fs.promises.stat(pick.file)).size;
        await pour(fs.createReadStream(pick.file, { highWaterMark: pick.slow ? 4096 : 1 << 20 }), total);
      } else if (pick.source === 'gh') {
        // the GitHub program writes the file itself: its size on disk, looked at a few times a second, against the size the release gives
        await new Promise((ok, no) => {
          const tryExe = i => {
            let failed = false;
            const c = spawn(ghExes[i], ['release', 'download', pick.tag, '--repo', repo, '--pattern', pick.name, '--dir', dir, '--clobber'], { windowsHide: true, stdio: 'ignore' });
            const stop = () => { try { c.kill(); } catch {} };
            const watch = setInterval(async () => {
              let big = 0;
              try { for (const n of await fs.promises.readdir(dir)) { const st = await fs.promises.stat(path.join(dir, n)).catch(() => null); if (st && st.isFile() && st.size > big) big = st.size; } } catch {}
              say(big, pick.size);
            }, 400);
            const end = () => { clearInterval(watch); clearTimeout(limit); if (sig) sig.removeEventListener('abort', stop); };
            const limit = setTimeout(stop, 600000);
            if (sig) sig.addEventListener('abort', stop);
            c.on('error', e => { end(); failed = true; if (e.code === 'ENOENT' && i + 1 < ghExes.length) tryExe(i + 1); else no(e); });
            c.on('exit', code => { if (failed) return; end(); if (sig && sig.aborted) no(stopped()); else if (code === 0) ok(); else no(new Error('The GitHub program could not fetch the installer (it ended with code ' + code + ')')); });
          };
          if (sig && sig.aborted) return no(stopped());
          tryExe(0);
        });
      } else {
        const r = await fetch(pick.url, { headers: { 'User-Agent': brand.slug }, signal: sig ? AbortSignal.any([sig, AbortSignal.timeout(600000)]) : AbortSignal.timeout(600000) });
        if (!r.ok) throw new Error('GitHub answered ' + r.status);
        await pour(r.body, +r.headers.get('content-length') || pick.size || 0);
      }
      if (sig && sig.aborted) throw stopped();
      const size = (await fs.promises.stat(out)).size;
      if (!pick.fake && size < 20e6) throw new Error('The installer did not arrive whole');
      say(size, size);
      return out;
    } catch (e) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw sig && sig.aborted ? stopped() : e;
    }
  }
  return { check, fetchInstaller, newer };
};
