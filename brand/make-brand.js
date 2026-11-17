// Turns brand/logo-original.webp (which has a checkerboard baked in instead of real transparency) into
// public/jrii.png: the maker's logo (JRII Designs), shown in About and on the installer's side panel.
// Run with:  npx electron brand/make-brand.js      It no longer makes the program's own icon or header mark: those are the
// PrintBinder "II" binders, drawn by scripts/make-installer-art.js (npm run art).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const inPage = async b64 => {
  const img = new Image();
  img.src = 'data:image/webp;base64,' + b64;
  await img.decode();
  const W = img.width, H = img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, W, H), p = d.data;
  // background = light, colourless pixels reachable from the border (the logo's dark outline stops the fill)
  const light = i => { const r = p[i], g = p[i + 1], b = p[i + 2]; return Math.min(r, g, b) > 196 && Math.max(r, g, b) - Math.min(r, g, b) < 26; };
  const seen = new Uint8Array(W * H), stack = [];
  const push = (px, py) => { if (px < 0 || py < 0 || px >= W || py >= H) return; const k = py * W + px; if (!seen[k] && light(k * 4)) { seen[k] = 1; stack.push(k); } };
  for (let i = 0; i < W; i++) { push(i, 0); push(i, H - 1); }
  for (let j = 0; j < H; j++) { push(0, j); push(W - 1, j); }
  while (stack.length) { const k = stack.pop(), px = k % W, py = (k - px) / W; push(px + 1, py); push(px - 1, py); push(px, py + 1); push(px, py - 1); }
  let x0 = W, y0 = H, x1 = 0, y1 = 0, cleared = 0;
  for (let k = 0; k < W * H; k++) {
    if (seen[k]) { p[k * 4 + 3] = 0; cleared++; }
    else { const px = k % W, py = (k - px) / W; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
  }
  // soften the cut edge: a kept pixel that touches the cleared area and is itself fairly light becomes half transparent
  for (let k = 0; k < W * H; k++) {
    if (seen[k]) continue;
    const px = k % W, py = (k - px) / W;
    const edge = (px > 0 && seen[k - 1]) || (px < W - 1 && seen[k + 1]) || (py > 0 && seen[k - W]) || (py < H - 1 && seen[k + W]);
    if (edge) { const l = (p[k * 4] + p[k * 4 + 1] + p[k * 4 + 2]) / 3; if (l > 120) p[k * 4 + 3] = Math.round(255 * Math.max(0.15, 1 - (l - 120) / 110)); }
  }
  x.putImageData(d, 0, 0);
  const pad = 6; x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const out = (w, h, dw, dh) => { const o = document.createElement('canvas'); o.width = w; o.height = h; const ox = o.getContext('2d'); ox.imageSmoothingQuality = 'high'; ox.drawImage(c, x0, y0, bw, bh, (w - dw) / 2, (h - dh) / 2, dw, dh); return o.toDataURL('image/png').split(',')[1]; };
  const lh = 200, lw = Math.round(lh * bw / bh);
  const sample = (fx, fy) => { const k = (Math.round(y0 + fy * bh) * W + Math.round(x0 + fx * bw)) * 4; return '#' + [p[k], p[k + 1], p[k + 2]].map(v => v.toString(16).padStart(2, '0')).join(''); };
  return { W, H, box: [x0, y0, bw, bh], cleared, logo: out(lw, lh, lw, lh), icon: out(256, 256, 252, Math.round(252 * bh / bw)),
    colours: { greenBar: sample(0.76, 0.3), greenText: sample(0.3, 0.8), navy: sample(0.52, 0.8), blue: sample(0.2, 0.52), white: sample(0.3, 0.2) } };
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  const b64 = fs.readFileSync(path.join(__dirname, 'logo-original.webp')).toString('base64');
  const r = await win.webContents.executeJavaScript(`(${inPage.toString()})(${JSON.stringify(b64)})`);
  const logo = Buffer.from(r.logo, 'base64'), icon = Buffer.from(r.icon, 'base64');
  fs.writeFileSync(path.join(root, 'public', 'jrii.png'), logo);
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ size: [r.W, r.H], box: r.box, cleared: r.cleared, colours: r.colours, logoBytes: logo.length, iconBytes: icon.length }, null, 1));
  app.quit();
}).catch(e => { fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ error: String(e && e.stack || e) })); app.exit(1); });
