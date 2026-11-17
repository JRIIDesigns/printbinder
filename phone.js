'use strict';
// Phone access: an optional second listener so a phone or tablet on the same home network can use the gallery.
//   * Off until the owner switches it on, on this computer. The switch and the list of paired phones live on this computer only.
//   * Only addresses on a home network are answered at all.
//   * A phone gets in only after pairing: it opens a one-time code shown on this computer (the QR square carries it) and is
//     handed a long random key in a cookie. Only a fingerprint of that key is stored here; removing the phone forgets it.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const qrcode = require('qrcode-generator');

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no letters or digits that look alike
const CODE_MS = 15 * 60000, PORT0 = 38383;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const tidy = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isHome = ip => {
  ip = String(ip || '').replace(/^::ffff:/i, '');
  if (ip === '::1' || /^(fe80|fc|fd)/i.test(ip)) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
};

module.exports = function ({ file, handle, log, name }) {
  // the program's name as the pairing page shows it (the server knows it; "PrintBinder" when it does not say)
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const APP = () => { try { return String((name && name()) || 'PrintBinder'); } catch { return 'PrintBinder'; } };
  let cfg = { on: false, port: PORT0, devices: [] };
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); cfg = { on: !!c.on, port: +c.port || PORT0, devices: Array.isArray(c.devices) ? c.devices : [] }; } catch {}
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg, null, 2)); } catch (e) { log('phone settings', e.message); } };
  const BIND = process.env.GALLERY_PHONE_HOST || '0.0.0.0';   // tests bind it to this computer only
  let lan = null, port = 0, error = '', pair = null, bad = [], savedAt = 0;

  // the addresses a phone could use, likeliest first: real network cards before virtual ones
  function addrs() {
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4' || !isHome(a.address) || a.address.startsWith('169.254.')) continue;
      const virt = /vethernet|wsl|virtual|vmware|hyper-v|loopback|bluetooth|docker|tailscale|zerotier|vpn/i.test(name);
      out.push({ ip: a.address, name, rank: (virt ? 10 : 0) + (a.address.startsWith('192.168.') ? 0 : 1) + (/wi-?fi|wlan|ethernet/i.test(name) ? 0 : 2) });
    }
    return out.sort((a, b) => a.rank - b.rank);
  }
  function newCode() {
    let c = '';
    for (const b of crypto.randomBytes(8)) c += ALPHA[b % ALPHA.length];
    pair = { code: c, exp: Date.now() + CODE_MS, bad: 0 };
    return pair;
  }
  const livePair = () => (pair && pair.exp > Date.now() ? pair : newCode());
  function qrSvg(text) {
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    const n = q.getModuleCount(), m = 4;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" role="img" aria-label="Pairing code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  function state() {
    const a = addrs(), run = !!lan && !error;
    const st = { on: cfg.on, running: run, port: port || cfg.port, error, addrs: a.map(x => ({ ip: x.ip, name: x.name })),
      devices: cfg.devices.map(d => ({ id: d.id, name: d.name, at: d.at, seen: d.seen || 0 })) };
    if (run && a.length) {
      const p = livePair(), base = 'http://' + a[0].ip + ':' + port;
      st.url = base; st.code = p.code.slice(0, 4) + '-' + p.code.slice(4); st.svg = qrSvg(base + '/pair?c=' + p.code);
    }
    return st;
  }

  function start() {
    if (lan) return Promise.resolve();
    error = '';
    return new Promise(resolve => {
      let tries = 0, p = cfg.port || PORT0;
      const go = () => {
        const s = http.createServer(handle);
        s.once('error', e => {
          if (e.code === 'EADDRINUSE' && ++tries < 10) { p++; return go(); }
          error = e.code === 'EADDRINUSE' ? 'Another program is using the network port.' : 'Could not open the network port (' + (e.code || e.message) + ').';
          log('phone access', error); lan = null; port = 0; resolve();
        });
        s.listen(p, BIND, () => {
          lan = s; port = s.address().port;
          if (cfg.port !== port && p !== 0) { cfg.port = port; save(); }
          s.on('error', e => log('phone access', e.message));
          log('phone access on, port ' + port);
          resolve();
        });
      };
      go();
    });
  }
  function stop() {
    if (!lan) return;
    const s = lan; lan = null; port = 0; pair = null;
    try { s.close(); if (s.closeAllConnections) s.closeAllConnections(); } catch {}
    log('phone access off');
  }
  async function set(on) {
    cfg.on = !!on; save();
    if (cfg.on) await start(); else { stop(); error = ''; }
    return state();
  }
  function forget(id) {
    cfg.devices = cfg.devices.filter(d => d.id !== String(id)); save();
    return state();
  }

  const cookieOf = req => { const m = /(?:^|;\s*)pg=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
  function deviceOf(req) {
    const t = cookieOf(req);
    if (!t) return null;
    const h = sha(t);
    return cfg.devices.find(d => d.h === h) || null;
  }
  function nameFor(req) {
    const ua = req.headers['user-agent'] || '';
    const base = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet') : /Windows/.test(ua) ? 'Windows computer' : /Macintosh/.test(ua) ? 'Mac' : 'Device';
    let name = base, n = 1;
    while (cfg.devices.some(d => d.name === name)) name = base + ' ' + (++n);
    return name;
  }
  // a code works once. Wrong guesses use it up, and a burst of them closes pairing for a while.
  function tryPair(code, req) {
    const now = Date.now();
    bad = bad.filter(t => now - t < 10 * 60000);
    if (bad.length >= 40) return { error: 'Too many wrong codes. Wait ten minutes, then use the code shown on the computer.' };
    const p = pair && pair.exp > now ? pair : null;
    if (!p || tidy(code).length !== p.code.length || !crypto.timingSafeEqual(Buffer.from(tidy(code)), Buffer.from(p.code))) {
      bad.push(now);
      if (p && ++p.bad >= 8) newCode();
      return { error: 'That code is not the current one. Open Phone access on the computer and use the code shown there now.' };
    }
    const token = crypto.randomBytes(32).toString('hex');
    cfg.devices.push({ id: crypto.randomBytes(6).toString('hex'), h: sha(token), name: nameFor(req), at: now, seen: now });
    save(); newCode();
    log('phone paired:', cfg.devices[cfg.devices.length - 1].name);
    return { cookie: 'pg=' + token + '; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict' };
  }
  const json = (res, code, obj, head) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...head }); res.end(JSON.stringify(obj)); };
  function pairPage(res, msg) {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(APP())}</title><style>
:root{--bg:#f2f5f7;--panel:#fff;--line:#d8dee5;--text:#0b1924;--dim:#5a6877;--btn:#8fd42a;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#0b1924;--panel:#11222f;--line:#233849;--text:#e9eef3;--dim:#93a4b4;--btn:#a6e22e;--bad:#ff8a80}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,"Segoe UI",sans-serif;padding:20px}
main{width:min(420px,100%);background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 14px;color:var(--dim)}
input{width:100%;font:600 24px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.12em;text-align:center;text-transform:uppercase;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--text)}
button{width:100%;margin-top:12px;font:inherit;font-weight:600;font-size:17px;padding:14px;border:0;border-radius:10px;background:var(--btn);color:#0b1924}
#m{color:var(--bad);min-height:1.5em;margin:10px 0 0}
</style></head><body><main><h1>Pair with ${esc(APP())}</h1>
<p>On the computer, open <b>File &gt; Phone access</b>. Point this device's camera at the square shown there, or type the eight-character code below.</p>
<p><b>Home network only, not encrypted.</b> Pair only on a network you trust, never on public Wi-Fi.</p>
<form id="f"><input id="c" maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" aria-label="Pairing code" enterkeyhint="go"><button>Pair this device</button></form>
<p id="m" role="alert"></p></main><script>
const m = document.getElementById('m'); m.textContent = ${JSON.stringify(msg || '')};
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault(); m.textContent = '';
  try {
    const r = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gallery': '1' }, body: JSON.stringify({ code: document.getElementById('c').value }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) location.replace('/'); else m.textContent = j.error || 'That did not work. Try again.';
  } catch { m.textContent = ${JSON.stringify('Could not reach the computer. Is ' + APP() + ' still running?').replace(/</g, '\\u003c')}; }
});
</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
    res.end(html);
  }
  const readSmall = req => new Promise(resolve => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 2000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });

  // Every request from the network passes here first. Returns the paired device, or answers the request itself and returns null.
  async function gate(req, res, u) {
    if (!isHome(req.socket.remoteAddress)) { res.writeHead(403); res.end('forbidden'); return null; }
    const route = u.pathname;
    if (route === '/pair') {
      if (req.method === 'POST') {
        if (req.headers['x-gallery'] !== '1' || !/^application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(403); res.end('forbidden'); return null; }
        const r = tryPair((await readSmall(req)).code, req);
        if (r.cookie) json(res, 200, { ok: true }, { 'Set-Cookie': r.cookie }); else json(res, 403, { error: r.error });
        return null;
      }
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return null; }
      if (deviceOf(req)) { res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); res.end(); return null; }
      const c = u.searchParams.get('c');
      if (!c) { pairPage(res, ''); return null; }
      const r = tryPair(c, req);
      if (r.cookie) { res.writeHead(302, { Location: '/', 'Set-Cookie': r.cookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); }
      else pairPage(res, r.error);
      return null;
    }
    const dev = deviceOf(req);
    if (!dev) {
      if (req.method === 'GET' && route === '/') pairPage(res, cookieOf(req) ? 'This device is no longer paired. Pair it again from the computer.' : '');
      else json(res, 401, { error: 'This device is not paired with ' + APP() + '.', pair: true });
      return null;
    }
    const now = Date.now();
    dev.seen = now;
    if (now - savedAt > 60000) { savedAt = now; save(); }
    return dev;
  }

  return { state, set, forget, gate, start: () => (cfg.on ? start() : Promise.resolve()), newCode: () => { newCode(); return state(); } };
};
