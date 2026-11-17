'use strict';
// Draws every picture the program and its installer show, from one drawing of the mark and the app's own navy-and-green look:
//   icon.png                       512 x 512   the program's icon (window, taskbar, drag picture)
//   icon.ico                       16, 24, 32, 48, 64, 128 and 256 px in one file (the exe, shortcuts, the installer)
//   public/logo.png                200 x 200   the mark in the page's header
//   build/installerSidebar.bmp     164 x 314   the tall panel on the Welcome and Finish pages, with the maker's logo
//   build/uninstallerSidebar.bmp   164 x 314   the same panel, quieter, for the uninstaller
//   build/installerHeader.bmp      150 x 57    the small picture at the top right of the other pages
// THE MARK is the maker's "II" — the Roman numeral of JRII Designs — drawn as two ring binders standing side by side, seen
// from their spines: two upright rounded bars, each with a label and a finger ring. It is drawn below as an SVG (mark()),
// so it stays sharp at every size; the smallest sizes use a plainer drawing without the details that would only blur.
// The two labels are lettered "STL" and "3MF", the two kinds of file the library mostly holds, written up the spine the way a
// real binder's label is (across the label the letters would be a third of the size). There are four drawings, by size:
//   'plain'  16 to 32 px   no lettering, no ring, thicker bars: letters could not be read here at all
//   'lines'  48 px         the full drawing with three lines on each label in place of letters, which would only smudge
//   'bold'   64 px, and the 200 px header logo (shown at 40 px)   wider spines and labels, so the letters are as large as they can be
//   'full'   128 px and up the lettered mark as designed
// public/jrii.png, the maker's own logo, is NOT made here: it is kept as it is and placed on the installer's side panel.
// Run with:  npm run art -- [folder for PNG copies to look at]      (npx electron scripts/make-installer-art.js [folder])
// Run it again after changing the name or the maker line in brand.js (both are written on the panel). Nothing is downloaded:
// the pictures are drawn in a hidden Electron window and saved from there.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path'), os = require('os');
const root = path.join(__dirname, '..'), brand = require(path.join(root, 'brand.js'));
const preview = process.argv.slice(2).find(a => !a.startsWith('-') && a !== __filename && path.resolve(a) !== path.resolve(__filename)) || null;

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pg-art-')));   // keeps this run's scraps out of anyone's settings

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// the palette: the page's own colours (public/index.html) and the greens of the maker's logo
const NAVY = '#0b1924', NAVY2 = '#14324a', GREEN = '#a6e22e', LIME = '#baea36', LEAF = '#7ac336', DEEP = '#4a8c0c', BLUE = '#5fbdf0', PALE = '#c4e3f8';

// The mark, on a 512 grid, in one of the four drawings above.
const kindFor = n => n <= 32 ? 'plain' : n < 64 ? 'lines' : n < 128 ? 'bold' : 'full';
function mark(kind) {
  const plain = kind === 'plain', bold = kind === 'bold';
  const bar = (x, id) => {
    const w = plain ? 132 : bold ? 138 : 116, y = plain ? 84 : bold ? 80 : 92, h = plain ? 344 : bold ? 352 : 328, r = plain ? 26 : 24;
    if (plain) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#g)"/><rect x="${x + 30}" y="${y + 52}" width="${w - 60}" height="92" rx="12" fill="#fff"/>`;
    const cx = x + w / 2;
    return `<rect x="${x + 5}" y="${y + 9}" width="${w}" height="${h}" rx="${r}" fill="#000" opacity=".28"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#g)"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="url(#sh)"/>
      <rect x="${x + 9}" y="${y + 14}" width="9" height="${h - 28}" rx="4.5" fill="#fff" opacity=".42"/>
      ${kind === 'lines' ? `<rect x="${x + 25}" y="${y + 42}" width="${w - 50}" height="104" rx="10" fill="#fff"/>
      <rect x="${x + 37}" y="${y + 64}" width="${w - 74}" height="9" rx="4.5" fill="${NAVY2}"/>
      <rect x="${x + 37}" y="${y + 86}" width="${w - 74}" height="9" rx="4.5" fill="${NAVY2}" opacity=".55"/>
      <rect x="${x + 37}" y="${y + 108}" width="${(w - 74) * 0.6}" height="9" rx="4.5" fill="${NAVY2}" opacity=".55"/>`
      : bold ? `<rect x="${x + 14}" y="${y + 22}" width="${w - 28}" height="226" rx="12" fill="#fff"/>
      <text transform="translate(${cx + 34} ${y + 135}) rotate(-90)" text-anchor="middle" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="800" font-size="96" textLength="${id === 'a' ? 176 : 196}" lengthAdjust="spacingAndGlyphs" fill="${NAVY}">${id === 'a' ? 'STL' : '3MF'}</text>`
      : `<rect x="${x + 19}" y="${y + 30}" width="${w - 38}" height="184" rx="11" fill="#fff"/>
      <text transform="translate(${cx + 24} ${y + 122}) rotate(-90)" text-anchor="middle" font-family="Segoe UI, Arial, Helvetica, sans-serif" font-weight="800" font-size="68" textLength="${id === 'a' ? 132 : 142}" lengthAdjust="spacingAndGlyphs" fill="${NAVY}">${id === 'a' ? 'STL' : '3MF'}</text>`}
      <circle cx="${cx}" cy="${y + h - (bold ? 56 : 66)}" r="27" fill="${NAVY}"/>
      <circle cx="${cx}" cy="${y + h - (bold ? 56 : 66)}" r="27" fill="none" stroke="${PALE}" stroke-width="${bold ? 9 : 7}"/>
      <circle cx="${cx}" cy="${y + h - (bold ? 56 : 66)}" r="9" fill="${NAVY2}"/>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <defs>
      <linearGradient id="t" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${NAVY2}"/><stop offset="1" stop-color="${NAVY}"/></linearGradient>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${LIME}"/><stop offset=".55" stop-color="${GREEN}"/><stop offset="1" stop-color="${LEAF}"/></linearGradient>
      <linearGradient id="sh" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".72" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="${DEEP}" stop-opacity=".55"/></linearGradient>
      <linearGradient id="e" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${GREEN}"/><stop offset="1" stop-color="${BLUE}"/></linearGradient>
    </defs>
    <rect x="16" y="16" width="480" height="480" rx="${plain ? 96 : 108}" fill="url(#t)"/>
    <rect x="${plain ? 26 : 22}" y="${plain ? 26 : 22}" width="${plain ? 460 : 468}" height="${plain ? 460 : 468}" rx="${plain ? 88 : 102}" fill="none" stroke="url(#e)" stroke-width="${plain ? 20 : 12}" opacity="${plain ? 1 : .9}"/>
    ${bar(plain ? 104 : bold ? 100 : 118, 'a')}${bar(plain ? 276 : bold ? 274 : 278, 'b')}
  </svg>`;
}
const svgUrl = s => 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64');

// In the hidden page: the drawing at one size, as a PNG and as plain pixels (red, green, blue, see-through; top row first).
const rasterInPage = async (url, n) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = n;
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, n, n);
  const bin = Array.from(x.getImageData(0, 0, n, n).data, v => String.fromCharCode(v)).join('');
  return { png: c.toDataURL('image/png').split(',')[1], rgba: btoa(bin) };
};

const page = (w, h, body, css) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden} body{position:relative;font-family:"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  ${css}</style></head><body>${body}</body></html>`;

const sidebar = (icon, jrii, quiet) => page(164, 314, `
  <div class="glow"></div><div class="grid"></div>
  <img class="mark" src="${icon}">
  <div class="name">${esc(brand.name)}</div>
  <div class="rule"></div>
  <div class="tag">${esc(quiet ? 'Your library stays as it is' : 'Your 3D print library, in order')}</div>
  <div class="maker">${jrii ? `<img src="${jrii}">` : ''}<span>${esc(brand.maker || '')}</span></div>
  <div class="bar"></div>`, `
  body{background:linear-gradient(168deg,${NAVY2} 0%,${NAVY} 58%,#070f17 100%)}
  .glow{position:absolute;left:-40px;top:-40px;width:244px;height:230px;background:radial-gradient(closest-side,rgba(95,189,240,${quiet ? '.10' : '.22'}),rgba(95,189,240,0))}
  .grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:20px 20px;-webkit-mask-image:linear-gradient(180deg,transparent 40%,#000 100%)}
  .mark{position:absolute;left:32px;top:24px;width:100px;height:100px;filter:drop-shadow(0 6px 10px rgba(0,0,0,.45))${quiet ? ' saturate(.7)' : ''}}
  .name{position:absolute;left:0;right:0;top:136px;text-align:center;color:#fff;font-size:${brand.name.length > 16 ? 15 : 20}px;font-weight:600;letter-spacing:.2px}
  .rule{position:absolute;left:62px;top:168px;width:40px;height:3px;border-radius:2px;background:${quiet ? '#5a6877' : GREEN}}
  .tag{position:absolute;left:10px;right:10px;top:180px;text-align:center;color:#a9bccb;font-size:11px;line-height:1.35}
  .maker{position:absolute;left:0;right:0;bottom:16px;text-align:center;color:#cfdbe5;font-size:10.5px;letter-spacing:.3px}
  .maker img{display:block;margin:0 auto 5px;height:50px;width:auto;filter:drop-shadow(0 2px 5px rgba(0,0,0,.5))${quiet ? ' saturate(.7)' : ''}}
  .bar{position:absolute;left:0;right:0;bottom:0;height:5px;background:linear-gradient(90deg,${quiet ? '#5a6877,#3a4a59' : GREEN + ',' + BLUE})}`);

const header = icon => page(150, 57, `<div class="panel"></div><div class="edge"></div><img src="${icon}">`, `
  body{background:#fff}
  .panel{position:absolute;inset:0;background:linear-gradient(120deg,${NAVY2},${NAVY});clip-path:polygon(34px 0,100% 0,100% 100%,10px 100%)}
  .edge{position:absolute;inset:0;background:linear-gradient(180deg,${GREEN},${BLUE});clip-path:polygon(29px 0,34px 0,10px 100%,5px 100%)}
  img{position:absolute;right:28px;top:5px;width:47px;height:47px}`);

// one page for the owner to look at: the icon at every size on a light and a dark background, and in the page's header
const sheet = (pngs, logo) => page(860, 330, ['#f2f5f7', '#0b1924'].map((bg, i) => `<div class="row" style="background:${bg};color:${i ? '#e9eef3' : '#0b1924'}">
  ${[256, 128, 64, 48, 32, 24, 16].map(n => `<figure><img src="data:image/png;base64,${pngs[n]}" width="${n > 128 ? 128 : n}" height="${n > 128 ? 128 : n}"><figcaption>${n > 128 ? '256 (shown at 128)' : n}</figcaption></figure>`).join('')}
  <div class="hd" style="background:${i ? '#11222f' : '#fff'}"><img src="${logo}" height="40"><b>${esc(brand.name)}</b></div></div>`).join(''), `
  .row{display:flex;align-items:flex-end;gap:22px;padding:18px 22px;height:129px} figure{margin:0;text-align:center;font-size:11px} figure img{display:block;margin:0 auto 6px}
  .hd{margin-left:auto;align-self:center;display:flex;align-items:center;gap:8px;padding:10px 18px;border-radius:8px;border-bottom:2px solid ${GREEN};font-size:17px}`);

// plain 24-bit BMP, bottom row first, from Electron's picture of a page (blue, green, red, see-through; top row first)
function bmp(img, w, h) {
  if (img.getSize().width !== w || img.getSize().height !== h) img = img.resize({ width: w, height: h, quality: 'best' });
  const px = img.toBitmap(), row = (w * 3 + 3) & ~3, out = Buffer.alloc(54 + row * h);
  out.write('BM', 0); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(w, 18); out.writeInt32LE(h, 22); out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(row * h, 34);
  out.writeInt32LE(2835, 38); out.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = 54 + (h - 1 - y) * row + x * 3; out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; }
  return out;
}
// An .ico holding several sizes. 256 px is stored as a PNG (the form Windows expects at that size); the smaller ones as the
// plain 32-bit pictures every program that reads icons understands, each followed by its 1-bit mask.
function ico(list) {
  const parts = list.map(({ n, png, rgba }) => {
    if (n >= 256) return png;
    const mrow = ((n + 31) >> 5) << 2, b = Buffer.alloc(40 + n * n * 4 + mrow * n);
    b.writeUInt32LE(40, 0); b.writeInt32LE(n, 4); b.writeInt32LE(n * 2, 8); b.writeUInt16LE(1, 12); b.writeUInt16LE(32, 14); b.writeUInt32LE(n * n * 4 + mrow * n, 20);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const s = (y * n + x) * 4, d = 40 + ((n - 1 - y) * n + x) * 4;
      b[d] = rgba[s + 2]; b[d + 1] = rgba[s + 1]; b[d + 2] = rgba[s]; b[d + 3] = rgba[s + 3];
      if (rgba[s + 3] < 128) b[40 + n * n * 4 + (n - 1 - y) * mrow + (x >> 3)] |= 0x80 >> (x & 7);
    }
    return b;
  });
  const head = Buffer.alloc(6 + 16 * list.length); head.writeUInt16LE(1, 2); head.writeUInt16LE(list.length, 4);
  let at = head.length;
  list.forEach(({ n }, i) => { const o = 6 + 16 * i; head[o] = n >= 256 ? 0 : n; head[o + 1] = n >= 256 ? 0 : n; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(parts[i].length, o + 8); head.writeUInt32LE(at, o + 12); at += parts[i].length; });
  return Buffer.concat([head, ...parts]);
}

app.on('window-all-closed', () => {});   // each picture has its own window; the app ends when the last one is saved
app.whenReady().then(async () => {
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  if (preview) fs.mkdirSync(preview, { recursive: true });
  const look = (name, buf) => { if (preview) fs.writeFileSync(path.join(preview, name), buf); };

  // ---- the mark at every size
  const draw = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await draw.loadURL('data:text/html,<body></body>');
  const raster = async (n, kind) => { const r = await draw.webContents.executeJavaScript(`(${rasterInPage.toString()})(${JSON.stringify(svgUrl(mark(kind || kindFor(n))))}, ${n})`); return { n, png: Buffer.from(r.png, 'base64'), rgba: Buffer.from(r.rgba, 'base64') }; };
  const sizes = [];
  for (const n of [16, 24, 32, 48, 64, 128, 256]) sizes.push(await raster(n));
  const big = await raster(512), logo = await raster(200, 'bold'), small = await raster(94, 'lines');   // small: for the installer's 47 px corner picture
  draw.destroy();
  fs.writeFileSync(path.join(root, 'icon.png'), big.png); look('icon-512.png', big.png);
  fs.writeFileSync(path.join(root, 'icon.ico'), ico(sizes)); for (const s of sizes) look('icon-' + s.n + '.png', s.png);
  fs.writeFileSync(path.join(root, 'public', 'logo.png'), logo.png); look('header-logo-200.png', logo.png);
  console.log('icon.png 512, icon.ico ' + sizes.map(s => s.n).join('/') + ', public/logo.png 200');

  // ---- the installer's pictures, laid out as small pages and photographed
  const icon = 'data:image/png;base64,' + sizes[sizes.length - 1].png.toString('base64');
  const jriiFile = path.join(root, 'public', 'jrii.png'), jrii = fs.existsSync(jriiFile) ? 'data:image/png;base64,' + fs.readFileSync(jriiFile).toString('base64') : '';
  const shoot = async (name, w, h, html, asBmp) => {
    const win = new BrowserWindow({ show: false, width: w, height: h, useContentSize: true, frame: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await win.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.decode())).then(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 150))))');
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h });
    if (asBmp) fs.writeFileSync(path.join(root, 'build', name + '.bmp'), bmp(img, w, h));
    look(name + '.png', img.toPNG());
    console.log(name + (asBmp ? '.bmp' : '.png (to look at only)'), w + ' x ' + h, '(captured ' + img.getSize().width + ' x ' + img.getSize().height + ')');
    win.destroy();
  };
  await shoot('installerSidebar', 164, 314, sidebar(icon, jrii, false), true);
  await shoot('uninstallerSidebar', 164, 314, sidebar(icon, jrii, true), true);
  await shoot('installerHeader', 150, 57, header('data:image/png;base64,' + small.png.toString('base64')), true);
  if (preview) await shoot('icon-all-sizes', 860, 330, sheet(Object.fromEntries(sizes.map(s => [s.n, s.png.toString('base64')])), 'data:image/png;base64,' + logo.png.toString('base64')), false);
  app.quit();
}).catch(e => { console.error(e && e.stack || e); app.exit(1); });
