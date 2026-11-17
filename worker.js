'use strict';
// Preview renderer. Runs in a worker thread so a huge or damaged model can never freeze the web page.
// Every job reads one file and writes one preview image; nothing in the 3D Prints folder is ever modified.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const zlib = require('zlib');

class Corrupt extends Error {}      // the file itself looks damaged
class Unsupported extends Error {}  // the file is probably fine, we just can't draw it

const OUT = 420, SS = 2, W = OUT * SS;
const MAX_BYTES = 1500 * 1024 * 1024;

function readFull(fd, len, pos) {
  const b = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, b, got, len - got, pos + got);
    if (!n) break;
    got += n;
  }
  if (got < len) throw new Corrupt('file ends unexpectedly');
  return b;
}

function readWhole(abs) {
  const size = fs.statSync(abs).size;
  if (size > MAX_BYTES) throw new Unsupported('file is too large to preview');
  return fs.readFileSync(abs);
}

// ---------- PNG ----------
function encodePNG(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < h; y++) src.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Reads a PNG back into pixels (8 bits a channel, not interlaced: what slicers write). Anything else gives null and is left as it is.
function decodePNG(buf) {
  try {
    if (buf.length < 57 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    let w = 0, h = 0, ct = -1, pal = null, trns = null;
    const idat = [];
    for (let o = 8; o + 12 <= buf.length;) {
      const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
      if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12] !== 0) return null; }
      else if (type === 'PLTE') pal = d;
      else if (type === 'tRNS') trns = d;
      else if (type === 'IDAT') idat.push(d);
      else if (type === 'IEND') break;
      o += 12 + len;
    }
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (!ch || !w || !h || w > 4096 || h > 4096 || (ct === 3 && !pal)) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch;
    if (raw.length < (stride + 1) * h) return null;
    const px = Buffer.alloc(stride * h), out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
      for (let x = 0; x < stride; x++) {
        const a = x >= ch ? px[dst + x - ch] : 0, b = y ? px[dst + x - stride] : 0, c = x >= ch && y ? px[dst + x - stride - ch] : 0;
        let p = 0;
        if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
        else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        px[dst + x] = (raw[src + x] + p) & 255;
      }
    }
    for (let i = 0, n = w * h; i < n; i++) {
      const s = i * ch, o = i * 4;
      if (ct === 6) { out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = px[s + 3]; }
      else if (ct === 2) { out[o] = px[s]; out[o + 1] = px[s + 1]; out[o + 2] = px[s + 2]; out[o + 3] = 255; }
      else if (ct === 3) { const k = px[s] * 3; out[o] = pal[k]; out[o + 1] = pal[k + 1]; out[o + 2] = pal[k + 2]; out[o + 3] = trns && px[s] < trns.length ? trns[px[s]] : 255; }
      else { out[o] = out[o + 1] = out[o + 2] = px[s]; out[o + 3] = ct === 4 ? px[s + 1] : 255; }
    }
    return { w, h, data: out };
  } catch { return null; }
}

// A model in black (or nearly black) material is a featureless shape on a light tile and all but disappears on a dark one.
// Its tones are raised to a charcoal grey that still reads as "black" but shows the model's faces. Colours that are not very dark are left alone.
const DARK = 60, FLOOR = 60;                                                        // "very dark" is below DARK (of 255); black becomes FLOOR
const liftTone = v => FLOOR + (255 - FLOOR) * (v / 255);                           // what a brightness of v becomes in a lifted picture
function liftRGB(r, g, b) {                                                         // a material colour: only a very dark one changes (and is marked, so its faces are lit more strongly)
  const v = Math.max(r, g, b);
  if (v >= DARK) return [r, g, b, 0];
  const d = liftTone(v) - v;
  return [Math.min(255, r + d), Math.min(255, g + d), Math.min(255, b + d), 1];
}
// A slicer's own picture of the plate: when most of what it shows is very dark, the whole picture is lifted. Returns a new PNG, or null when nothing needs doing.
function liftDarkPicture(buf) {
  const img = decodePNG(buf);
  if (!img) return null;
  const { w, h, data } = img;
  let solid = 0, dark = 0;
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] < 128) continue;
    solid++;
    if (Math.max(data[o], data[o + 1], data[o + 2]) < DARK) dark++;
  }
  if (solid < w * h * 0.005 || dark < solid * 0.6) return null;
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = liftTone(v) - v;
  for (let o = 0; o < data.length; o += 4) {
    if (!data[o + 3]) continue;
    const d = lut[Math.max(data[o], data[o + 1], data[o + 2])];
    data[o] = Math.min(255, data[o] + d); data[o + 1] = Math.min(255, data[o + 1] + d); data[o + 2] = Math.min(255, data[o + 2] + d);
  }
  return encodePNG(w, h, data);
}

// ---------- software renderer ----------
// `each(cb)` must call cb(x0,y0,z0, x1,y1,z1, x2,y2,z2) for every triangle, and be callable twice.
function renderMesh(each) {
  const AZ = 35 * Math.PI / 180, EL = 28 * Math.PI / 180;
  const cx = Math.sin(AZ) * Math.cos(EL), cy = -Math.cos(AZ) * Math.cos(EL), cz = Math.sin(EL); // toward camera
  const rx = Math.cos(AZ), ry = Math.sin(AZ);                                                    // screen right
  const ux = -cz * ry, uy = cz * rx, uz = cx * ry - cy * rx;                                     // screen up
  let lx = cx * 0.75 + ux * 0.55 - rx * 0.4, ly = cy * 0.75 + uy * 0.55 - ry * 0.4, lz = cz * 0.75 + uz * 0.55;
  const ll = Math.hypot(lx, ly, lz); lx /= ll; ly /= ll; lz /= ll;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
  const acc = (x, y, z) => {
    const sx = x * rx + y * ry, sy = x * ux + y * uy + z * uz;
    if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
  };
  each((a, b, c, d, e, f, g, h, i) => {
    if (!Number.isFinite(a + b + c + d + e + f + g + h + i)) return;
    n++; acc(a, b, c); acc(d, e, f); acc(g, h, i);
  });
  if (!n) throw new Corrupt('contains no 3D geometry');

  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const pad = W * 0.06, sc = (W - 2 * pad) / span;
  const ox = (W - (maxX - minX) * sc) / 2 - minX * sc;
  const oy = (W - (maxY - minY) * sc) / 2 + maxY * sc;

  const zb = new Float32Array(W * W).fill(-Infinity);
  const sh = new Uint8Array(W * W);
  // material colours, when the file names them (a 3MF project): 0 is "no colour given", drawn in the usual blue
  const coloured = (each.parts || []).filter(p => p.color);
  const pal = [null], palOf = new Map(), ci = coloured.length ? new Uint8Array(W * W) : null;
  let cur = 0;
  const useColour = c => {
    if (!c) { cur = 0; return; }
    if (!palOf.has(c) && pal.length < 255) { palOf.set(c, pal.length); pal.push(liftRGB(parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16))); }
    cur = palOf.get(c) || 0;
  };

  const tri = (x0, y0, z0, x1, y1, z1, x2, y2, z2) => {
    if (!Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1 + x2 + y2 + z2)) return;
    const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0, e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz);
    if (!nl) return;
    if (nx * cx + ny * cy + nz * cz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const lam = Math.max(0, (nx * lx + ny * ly + nz * lz) / nl);
    const v = 1 + Math.round((0.3 + 0.7 * lam) * 254);

    const ax = ox + (x0 * rx + y0 * ry) * sc, ay = oy - (x0 * ux + y0 * uy + z0 * uz) * sc, ad = x0 * cx + y0 * cy + z0 * cz;
    const bx = ox + (x1 * rx + y1 * ry) * sc, by = oy - (x1 * ux + y1 * uy + z1 * uz) * sc, bd = x1 * cx + y1 * cy + z1 * cz;
    const gx = ox + (x2 * rx + y2 * ry) * sc, gy = oy - (x2 * ux + y2 * uy + z2 * uz) * sc, gd = x2 * cx + y2 * cy + z2 * cz;

    const fx0 = Math.min(ax, bx, gx), fx1 = Math.max(ax, bx, gx), fy0 = Math.min(ay, by, gy), fy1 = Math.max(ay, by, gy);
    const area = (bx - ax) * (gy - ay) - (by - ay) * (gx - ax);
    if ((fx1 - fx0 < 1.5 && fy1 - fy0 < 1.5) || area === 0) {
      const px = Math.floor((ax + bx + gx) / 3), py = Math.floor((ay + by + gy) / 3);
      if (px >= 0 && px < W && py >= 0 && py < W) {
        const d = (ad + bd + gd) / 3, k = py * W + px;
        if (d > zb[k]) { zb[k] = d; sh[k] = v; if (ci) ci[k] = cur; }
      }
      return;
    }
    const X0 = Math.max(0, Math.floor(fx0)), X1 = Math.min(W - 1, Math.ceil(fx1));
    const Y0 = Math.max(0, Math.floor(fy0)), Y1 = Math.min(W - 1, Math.ceil(fy1));
    const inv = 1 / area;
    for (let y = Y0; y <= Y1; y++) {
      const py = y + 0.5;
      for (let x = X0; x <= X1; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (gy - py) - (by - py) * (gx - px)) * inv;
        if (w0 < 0) continue;
        const w1 = ((gx - px) * (ay - py) - (gy - py) * (ax - px)) * inv;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        const d = w0 * ad + w1 * bd + w2 * gd, k = y * W + x;
        if (d > zb[k]) { zb[k] = d; sh[k] = v; if (ci) ci[k] = cur; }
      }
    }
  };
  if (ci) for (const p of each.parts) { useColour(p.color); p.each(tri); }
  else each(tri);

  // darken silhouettes and sharp depth steps so shapes read clearly
  const thr = 8 / sc;
  const edge = new Uint8Array(W * W);
  for (let y = 0; y < W - 1; y++) for (let x = 0; x < W - 1; x++) {
    const k = y * W + x;
    const a = sh[k], r = sh[k + 1], d = sh[k + W];
    if (!a && !r && !d) continue;
    if (!a || !r || Math.abs(zb[k] - zb[k + 1]) > thr) { edge[k] = 1; edge[k + 1] = 1; }
    if (!a || !d || Math.abs(zb[k] - zb[k + W]) > thr) { edge[k] = 1; edge[k + W] = 1; }
  }

  const out = new Uint8Array(OUT * OUT * 4);
  for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
    let sum = 0, cov = 0, r = 0, g = 0, b = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
      const k = (y * SS + j) * W + x * SS + i;
      if (!sh[k]) continue;
      const t = (sh[k] / 255) * (edge[k] ? 0.5 : 1), c = ci ? pal[ci[k]] : null;
      cov++; sum += t;
      if (c) { const s = c[3] ? 0.85 + 0.85 * t : 0.12 + 0.88 * t; r += c[0] * s; g += c[1] * s; b += c[2] * s; }
      else if (ci) { r += 112 * t + 20; g += 170 * t + 22; b += 215 * t + 26; }
    }
    if (!cov) continue;
    const t = sum / cov, o = (y * OUT + x) * 4;
    if (ci) { out[o] = Math.round(r / cov); out[o + 1] = Math.round(g / cov); out[o + 2] = Math.round(b / cov); }
    else { out[o] = Math.round(112 * t + 20); out[o + 1] = Math.round(170 * t + 22); out[o + 2] = Math.round(215 * t + 26); }
    out[o + 3] = Math.round(255 * cov / (SS * SS));
  }
  return encodePNG(OUT, OUT, out);
}

const eachIndexed = (pos, idx) => cb => {
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    cb(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2], pos[c], pos[c + 1], pos[c + 2]);
  }
};

// ---------- STL ----------
function loadSTL(abs) {
  const buf = readWhole(abs);
  if (buf.length === 0) throw new Corrupt('empty file (0 bytes)');
  const head = buf.toString('latin1', 0, Math.min(buf.length, 2048)).trimStart().toLowerCase();
  const n = buf.length >= 84 ? buf.readUInt32LE(80) : 0;
  const expect = 84 + n * 50;
  const binaryOK = buf.length >= 84 && n > 0 && buf.length >= expect && buf.length - expect < 1024;
  if (!binaryOK && head.startsWith('solid') && head.includes('facet')) {
    if (buf.length > 400 * 1024 * 1024) throw new Unsupported('text STL is too large to preview');
    const text = buf.toString('latin1');
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    const v = [];
    let m;
    while ((m = re.exec(text))) v.push(+m[1], +m[2], +m[3]);
    const tris = Math.floor(v.length / 9);
    if (!tris) throw new Corrupt('text STL contains no triangles');
    if (!/endsolid/i.test(text.slice(-2048))) throw new Corrupt('text STL is cut off before the end (incomplete file)');
    return cb => { for (let i = 0; i < tris * 9; i += 9) cb(v[i], v[i + 1], v[i + 2], v[i + 3], v[i + 4], v[i + 5], v[i + 6], v[i + 7], v[i + 8]); };
  }
  if (buf.length < 84) throw new Corrupt('too small to be an STL (' + buf.length + ' bytes)');
  if (n === 0) throw new Corrupt('STL header says it contains 0 triangles');
  if (buf.length < expect) {
    throw new Corrupt('STL is cut off: header promises ' + n.toLocaleString() + ' triangles, file only holds ' +
      Math.floor((buf.length - 84) / 50).toLocaleString() + ' (incomplete download?)');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return cb => {
    for (let i = 0, o = 96; i < n; i++, o += 50) {
      cb(dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true),
        dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true),
        dv.getFloat32(o + 24, true), dv.getFloat32(o + 28, true), dv.getFloat32(o + 32, true));
    }
  };
}

// ---------- OBJ ----------
function loadOBJ(abs) {
  const buf = readWhole(abs);
  if (buf.length === 0) throw new Corrupt('empty file (0 bytes)');
  if (buf.length > 400 * 1024 * 1024) throw new Unsupported('OBJ is too large to preview');
  const text = buf.toString('latin1');
  const pos = [], idx = [];
  const re = /^[ \t]*(v|f)[ \t]+([^\r\n]*)/gm;
  let m;
  while ((m = re.exec(text))) {
    const parts = m[2].trim().split(/\s+/);
    if (m[1] === 'v') pos.push(+parts[0], +parts[1], +parts[2]);
    else {
      const nv = pos.length / 3;
      const f = parts.map(p => { const i = parseInt(p, 10); return i < 0 ? nv + i : i - 1; });
      for (let i = 1; i + 1 < f.length; i++) {
        if (f[0] >= 0 && f[i] >= 0 && f[i + 1] >= 0 && f[0] < nv && f[i] < nv && f[i + 1] < nv) idx.push(f[0], f[i], f[i + 1]);
      }
    }
  }
  if (!idx.length) throw new Corrupt('OBJ contains no faces');
  return eachIndexed(pos, idx);
}

// ---------- ZIP / 3MF ----------
function openZip(fd, size) {
  if (size < 22) throw new Corrupt(size === 0 ? 'empty file (0 bytes)' : 'too small to be a 3MF archive');
  const tailLen = Math.min(size, 65557);
  const tail = readFull(fd, tailLen, size - tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Corrupt('not a complete archive — the end of the file is missing (incomplete download?)');
  let cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || tail.readUInt16LE(e + 10) === 0xFFFF) {   // zip64
    const lp = size - tailLen + e - 20;
    if (lp < 0) throw new Corrupt('archive index is damaged');
    const loc = readFull(fd, 20, lp);
    if (loc.readUInt32LE(0) !== 0x07064b50) throw new Corrupt('archive index is damaged');
    const zo = Number(loc.readBigUInt64LE(8));
    if (zo + 56 > size) throw new Corrupt('archive index points past the end of the file (cut off)');
    const z = readFull(fd, 56, zo);
    if (z.readUInt32LE(0) !== 0x06064b50) throw new Corrupt('archive index is damaged');
    cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
  }
  if (cdOff + cdSize > size) throw new Corrupt('archive index points past the end of the file (cut off)');
  const cd = readFull(fd, cdSize, cdOff);
  const entries = [];
  for (let o = 0; o + 46 <= cd.length && cd.readUInt32LE(o) === 0x02014b50;) {
    const nlen = cd.readUInt16LE(o + 28), xlen = cd.readUInt16LE(o + 30), clen = cd.readUInt16LE(o + 32);
    const ent = {
      name: cd.toString('utf8', o + 46, o + 46 + nlen), method: cd.readUInt16LE(o + 10),
      csize: cd.readUInt32LE(o + 20), usize: cd.readUInt32LE(o + 24), off: cd.readUInt32LE(o + 42),
    };
    for (let x = o + 46 + nlen, xe = Math.min(x + xlen, cd.length); x + 4 <= xe;) {   // zip64 extra field
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        const next = () => { const v = q + 8 <= xe ? Number(cd.readBigUInt64LE(q)) : 0; q += 8; return v; };
        if (ent.usize === 0xFFFFFFFF) ent.usize = next();
        if (ent.csize === 0xFFFFFFFF) ent.csize = next();
        if (ent.off === 0xFFFFFFFF) ent.off = next();
      }
      x += 4 + len;
    }
    entries.push(ent);
    o += 46 + nlen + xlen + clen;
  }
  if (!entries.length) throw new Corrupt('archive is empty');
  return entries;
}

function readEntry(fd, size, ent) {
  if (ent.off + 30 > size) throw new Corrupt('archive is cut off');
  const lh = readFull(fd, 30, ent.off);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Corrupt('archive contents are damaged');
  const start = ent.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (start + ent.csize > size) throw new Corrupt('archive is cut off');
  const c = readFull(fd, ent.csize, start);
  if (ent.method === 0) return c;
  if (ent.method !== 8) throw new Unsupported('unusual zip compression');
  try { return zlib.inflateRawSync(c); } catch (e) { throw new Corrupt('archive data is damaged (' + (e.code || e.message) + ')'); }
}

const isImg = b => (b.length > 8 && b[0] === 0x89 && b[1] === 0x50) || (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8);

function pickEmbedded(entries) {
  const score = name => {
    const n = name.toLowerCase();
    if (!/\.(png|jpe?g)$/.test(n)) return 0;
    if (/metadata\/plate_1\.png$/.test(n)) return 100;
    if (/metadata\/plate_\d+\.png$/.test(n)) return 90;
    if (/metadata\/thumbnail\.(png|jpe?g)$/.test(n)) return 85;
    if (/thumbnail_3mf\.png$/.test(n)) return 80;
    if (/thumbnail_middle\.png$/.test(n)) return 75;
    if (/metadata\/top_\d+\.png$/.test(n)) return 60;
    if (/thumbnail/.test(n) && !/small/.test(n)) return 50;
    return 0;
  };
  return entries.map(e => ({ e, s: score(e.name) })).filter(x => x.s && x.e.usize > 600)
    .sort((a, b) => b.s - a.s || b.e.usize - a.e.usize).map(x => x.e);
}

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const parseT = s => { if (!s) return IDENT; const a = s.trim().split(/\s+/).map(Number); return a.length === 12 && a.every(Number.isFinite) ? a : IDENT; };
// 3MF uses row vectors: p' = p * M. mul(a, b) applies a first, then b.
function mul(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c] + (r === 3 ? b[9 + c] : 0);
  }
  return o;
}
const attr = (s, name) => { const m = new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(s); return m ? m[1] : null; };

// Bambu/Orca projects: which filament each object/part uses, the filament colours, and which parts are
// not real geometry (modifiers, negative volumes, support blockers) and must not be drawn.
function readSlicerSettings(fd, size, byName) {
  const out = { objects: new Map(), colors: [] };
  try {
    const e = byName.get('metadata/model_settings.config');
    if (e && e.usize < 30e6) {
      const xml = readEntry(fd, size, e).toString('utf8');
      const exOf = s => { const m = /<metadata\s+key="extruder"\s+value="(\d+)"/.exec(s); return m ? +m[1] : 0; };
      const or = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
      let m;
      while ((m = or.exec(xml))) {
        const body = m[2], fp = body.search(/<part\b/);
        const o = { ex: exOf(fp < 0 ? body : body.slice(0, fp)), parts: new Map() };
        const pr = /<part\b([^>]*)>([\s\S]*?)<\/part>/g;
        let p;
        while ((p = pr.exec(body))) o.parts.set(attr(p[1], 'id'), { sub: attr(p[1], 'subtype') || 'normal_part', ex: exOf(p[2]) });
        out.objects.set(attr(m[1], 'id'), o);
      }
    }
    const pe = byName.get('metadata/project_settings.config');
    if (pe && pe.usize < 8e6) {
      const j = JSON.parse(readEntry(fd, size, pe).toString('utf8'));
      if (Array.isArray(j.filament_colour)) out.colors = j.filament_colour;
    }
  } catch {}
  return out;
}

// Slicer colour painting: which filament a whole triangle was painted with (0 = not painted / partly painted).
function paintEx(s) {
  if (!s) return 0;
  if (s === '4') return 1;
  if (s === '8') return 2;
  if (s.length === 2 && s[1] === 'C') { const n = parseInt(s[0], 16); return Number.isNaN(n) ? 0 : 3 + n; }
  return 0;
}

function load3MFMesh(fd, size, entries) {
  const byName = new Map(entries.map(e => [e.name.replace(/^\/+/, '').toLowerCase(), e]));
  const settings = readSlicerSettings(fd, size, byName);
  const colorOf = ex => { const c = settings.colors[(ex || 1) - 1]; return typeof c === 'string' && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) : null; };
  const models = entries.filter(e => /\.model$/i.test(e.name));
  if (!models.length) throw new Corrupt('3MF contains no model data');
  if (models.reduce((a, e) => a + e.usize, 0) > 700 * 1024 * 1024) throw new Unsupported('3MF model is too large to preview');
  const parsed = new Map();
  const parse = name => {
    const key = name.replace(/^\/+/, '').toLowerCase();
    if (parsed.has(key)) return parsed.get(key);
    const ent = byName.get(key);
    const model = { objects: new Map(), items: [] };
    parsed.set(key, model);
    if (!ent) return model;
    const xml = readEntry(fd, size, ent).toString('utf8');
    const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
    let m;
    while ((m = objRe.exec(xml))) {
      const id = attr(m[1], 'id'), body = m[2];
      const obj = { pos: null, idx: null, comps: [] };
      if (body.includes('<mesh')) {
        const pos = [], idx = [];
        const vr = /<vertex\b[^>]*?\bx="([^"]+)"[^>]*?\by="([^"]+)"[^>]*?\bz="([^"]+)"/g;
        const tr = /<triangle\b[^>]*?\bv1="(\d+)"[^>]*?\bv2="(\d+)"[^>]*?\bv3="(\d+)"(?:[^>]*?\bpaint_color="([^"]*)")?/g;
        let q, painted = false;
        const tex = [];
        while ((q = vr.exec(body))) pos.push(+q[1], +q[2], +q[3]);
        const nv = pos.length / 3;
        while ((q = tr.exec(body))) {
          const a = +q[1], b = +q[2], c = +q[3];
          if (a < nv && b < nv && c < nv) { idx.push(a, b, c); const e = paintEx(q[4]); if (e) painted = true; tex.push(e); }
        }
        obj.pos = pos; obj.idx = idx; obj.tex = painted ? tex : null;
      }
      const cr = /<component\b([^>]*)>/g;
      let c;
      while ((c = cr.exec(body))) obj.comps.push({ path: attr(c[1], 'p:path') || attr(c[1], 'path'), id: attr(c[1], 'objectid'), t: parseT(attr(c[1], 'transform')) });
      model.objects.set(id, obj);
    }
    const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml);
    if (build) {
      const ir = /<item\b([^>]*)>/g;
      let it;
      while ((it = ir.exec(build[1]))) model.items.push({ path: attr(it[1], 'p:path') || attr(it[1], 'path'), id: attr(it[1], 'objectid'), t: parseT(attr(it[1], 'transform')) });
    }
    return model;
  };

  const rootEnt = byName.has('3d/3dmodel.model') ? '3d/3dmodel.model' : models[0].name;
  const root = parse(rootEnt);
  const inst = [];
  let curItem = 0;
  const walk = (modelName, id, t, depth, so, ex) => {
    if (depth > 8) return;
    const obj = parse(modelName).objects.get(id);
    if (!obj) return;
    if (obj.idx && obj.idx.length) inst.push({ pos: obj.pos, idx: obj.idx, t, color: colorOf(ex), tex: obj.tex, item: curItem });
    for (const c of obj.comps) {
      const part = depth === 0 && so ? so.parts.get(c.id) : null;
      if (part && part.sub !== 'normal_part') continue;
      walk(c.path || modelName, c.id, mul(c.t, t), depth + 1, null, (part && part.ex) || ex);
    }
  };
  for (const it of root.items) { curItem++; const so = settings.objects.get(it.id); walk(it.path || rootEnt, it.id, it.t, 0, so, so ? so.ex : 0); }
  if (!inst.length) {
    for (const e of models) for (const o of parse(e.name).objects.values()) if (o.idx && o.idx.length) inst.push({ pos: o.pos, idx: o.idx, t: IDENT });
  }
  if (!inst.length) throw new Corrupt('3MF contains no 3D geometry');
  const one = ({ pos, idx, t, tex }, want) => cb => {
    const X = i => pos[i] * t[0] + pos[i + 1] * t[3] + pos[i + 2] * t[6] + t[9];
    const Y = i => pos[i] * t[1] + pos[i + 1] * t[4] + pos[i + 2] * t[7] + t[10];
    const Z = i => pos[i] * t[2] + pos[i + 1] * t[5] + pos[i + 2] * t[8] + t[11];
    for (let i = 0; i + 2 < idx.length; i += 3) {
      if (want >= 0 && tex[i / 3] !== want) continue;
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      cb(X(a), Y(a), Z(a), X(b), Y(b), Z(b), X(c), Y(c), Z(c));
    }
  };
  const parts = [];
  for (const i of inst) {
    if (!i.tex) { parts.push({ color: i.color || null, item: i.item || 0, each: one(i, -1) }); continue; }
    for (const e of new Set(i.tex)) parts.push({ color: (e ? colorOf(e) : i.color) || null, item: i.item || 0, each: one(i, e) });
  }
  const each = cb => { for (const p of parts) p.each(cb); };
  each.parts = parts;
  return each;
}

function thumb3MF(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const entries = openZip(fd, size);
    // A slicer's own picture shows plate 1 only. A project saved with several plates is therefore drawn here instead, so the
    // preview holds every object in the file, laid out as the 3D view shows them. (If that cannot be done, plate 1's picture is better than none.)
    const plates = new Set(entries.map(e => (/(?:^|\/)metadata\/plate_(\d+)\.png$/i.exec(e.name) || [])[1]).filter(Boolean)).size;
    if (plates > 1) { try { return renderMesh(load3MFMesh(fd, size, entries)); } catch (e) { if (e && e.syscall) throw e; } }
    for (const ent of pickEmbedded(entries).slice(0, 3)) {
      try { const img = readEntry(fd, size, ent); if (isImg(img)) return liftDarkPicture(img) || img; } catch (e) { if (!(e instanceof Corrupt)) throw e; }
    }
    return renderMesh(load3MFMesh(fd, size, entries));
  } finally { fs.closeSync(fd); }
}

// ---------- STEP ----------
let occtP = null;
async function loadSTEP(abs) {
  const buf = readWhole(abs);
  if (buf.length === 0) throw new Corrupt('empty file (0 bytes)');
  if (!buf.toString('latin1', 0, 256).includes('ISO-10303')) throw new Corrupt('does not start like a STEP file');
  if (!occtP) occtP = require('occt-import-js')();
  const occt = await occtP;
  const res = occt.ReadStepFile(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), null);
  if (!res || !res.success) throw new Corrupt('STEP file could not be read by the CAD importer');
  const meshes = (res.meshes || []).filter(m => m.index && m.index.array.length);
  if (!meshes.length) throw new Corrupt('STEP file contains no solid geometry');
  return cb => { for (const m of meshes) eachIndexed(m.attributes.position.array, m.index.array)(cb); };
}

// ---------- HEIC ----------
async function thumbHEIC(abs) {
  const buf = readWhole(abs);
  if (buf.length === 0) throw new Corrupt('empty file (0 bytes)');
  let img;
  try { img = await require('heic-decode')({ buffer: buf }); } catch (e) { throw new Corrupt('HEIC photo could not be decoded (' + e.message + ')'); }
  const { width: w, height: h, data } = img;
  const f = Math.max(1, Math.ceil(Math.max(w, h) / 900));
  const ow = Math.floor(w / f), oh = Math.floor(h / f);
  const out = new Uint8Array(ow * oh * 4);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
      const o = ((y * f + j) * w + x * f + i) * 4;
      r += data[o]; g += data[o + 1]; b += data[o + 2];
    }
    const o = (y * ow + x) * 4, k = f * f;
    out[o] = r / k; out[o + 1] = g / k; out[o + 2] = b / k; out[o + 3] = 255;
  }
  return encodePNG(ow, oh, out);
}

async function make(abs, ext) {
  switch (ext) {
    case 'stl': return renderMesh(loadSTL(abs));
    case 'obj': return renderMesh(loadOBJ(abs));
    case '3mf': return thumb3MF(abs);
    case 'step': case 'stp': return renderMesh(await loadSTEP(abs));
    case 'heic': case 'heif': return thumbHEIC(abs);
    default: throw new Unsupported('no preview for .' + ext);
  }
}

// ---------- full geometry for the 3D viewer ----------
async function meshOf(abs, ext) {
  switch (ext) {
    case 'stl': return loadSTL(abs);
    case 'obj': return loadOBJ(abs);
    case 'step': case 'stp': return loadSTEP(abs);
    case '3mf': {
      const fd = fs.openSync(abs, 'r');
      try { const size = fs.fstatSync(fd).size; return load3MFMesh(fd, size, openZip(fd, size)); } finally { fs.closeSync(fd); }
    }
    default: throw new Unsupported('no 3D view for .' + ext);
  }
}
async function makeMesh(abs, ext) {
  const each = await meshOf(abs, ext);
  const parts = (each.parts || [{ color: null, each }]).slice().sort((a, b) => String(a.color).localeCompare(String(b.color)));
  let total = 0;
  for (const p of parts) p.each((a, b, c, d, e, f, g, h, i) => { if (Number.isFinite(a + b + c + d + e + f + g + h + i)) total++; });
  if (!total) throw new Corrupt('contains no 3D geometry');
  if (total > 6e6) throw new Unsupported('this model is too detailed to show in 3D (' + total.toLocaleString() + ' triangles)');
  const pos = new Float32Array(total * 9), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], groups = [];
  let o = 0;
  for (const p of parts) {
    const start = o / 3;
    p.each((a, b, c, d, e, f, g, h, i) => {
      if (!Number.isFinite(a + b + c + d + e + f + g + h + i)) return;
      pos[o] = a; pos[o + 1] = b; pos[o + 2] = c; pos[o + 3] = d; pos[o + 4] = e; pos[o + 5] = f; pos[o + 6] = g; pos[o + 7] = h; pos[o + 8] = i;
      for (let k = 0; k < 9; k++) { const v = pos[o + k], ax = k % 3; if (v < min[ax]) min[ax] = v; if (v > max[ax]) max[ax] = v; }
      o += 9;
    });
    const last = groups[groups.length - 1];
    if (last && last.color === p.color) last.count += o / 3 - start; else groups.push({ start, count: o / 3 - start, color: p.color });
  }
  return { buf: pos.buffer, groups, min, max, tris: total };
}

// ---------- slicer facts: the printer, material and print time a project or print file was last saved with ----------
function metaFromText(head, tail) {
  const pick = (re, s) => { const m = re.exec(s); return m ? m[1].trim().replace(/^"|"$/g, '').slice(0, 80) : ''; };
  const both = tail + '\n' + head;
  const uniq = s => [...new Set(s.split(/[;,]/).map(x => x.trim().replace(/^"|"$/g, '')).filter(Boolean))].join(', ').slice(0, 60);
  const out = {
    pr: pick(/^; ?printer_model ?= ?(.+)$/m, both) || pick(/^;Machine Name: ?(.+)$/m, head) || pick(/printer_model=([^\r\n]+)/, head),
    pf: pick(/^; ?printer_settings_id ?= ?(.+)$/m, both) || pick(/printer_settings_id=([^\r\n]+)/, head),
    mt: uniq(pick(/^; ?filament_type ?= ?(.+)$/m, both) || pick(/^;Material Type: ?(.+)$/m, head) || pick(/filament_type=([^\r\n]+)/, head)),
    pt: pick(/^; ?estimated printing time(?: \(normal mode\))? ?= ?(.+)$/m, both) || pick(/^; ?model printing time: ?([^;\r\n]+)/m, both) || pick(/estimated printing time \(normal mode\)=([^\r\n]+)/, head),
  };
  if (!out.pt) { const s = +pick(/^;TIME: ?([\d.]+)/m, head); if (s > 0) out.pt = fmtSecs(s); }
  return out;
}
const fmtSecs = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + 'h ' + m + 'm' : m ? m + 'm' : s + 's'; };
function readMeta(abs, ext) {
  const fd = fs.openSync(abs, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (ext !== '3mf') {
      const hl = Math.min(size, 400000), tl = Math.min(size, 160000);
      return metaFromText(readFull(fd, hl, 0).toString('latin1'), size > hl ? readFull(fd, tl, size - tl).toString('latin1') : '');
    }
    const entries = openZip(fd, size);
    const byName = new Map(entries.map(e => [e.name.replace(/^\/+/, '').toLowerCase(), e]));
    const text = n => { const e = byName.get(n); return e && e.usize < 20e6 ? readEntry(fd, size, e).toString('utf8') : ''; };
    let out = {};
    const ps = text('metadata/project_settings.config');
    if (ps) {
      try {
        const j = JSON.parse(ps), one = v => Array.isArray(v) ? v : v ? [v] : [];
        out = { pr: String(one(j.printer_model)[0] || '').slice(0, 80), pf: String(one(j.printer_settings_id)[0] || '').slice(0, 80), mt: [...new Set(one(j.filament_type).map(String).filter(Boolean))].join(', ').slice(0, 60), pt: '' };
      } catch {}
    }
    if (!out.pr) { const t = text('metadata/slic3r_pe.config'); if (t) out = metaFromText(t.slice(0, 400000), ''); }
    const si = text('metadata/slice_info.config');
    if (si) { const m = /key="prediction"\s+value="(\d+)"/.exec(si); if (m && +m[1] > 0) out.pt = fmtSecs(+m[1]); }
    try { Object.assign(out, selfFacts(fd, size, byName, abs)); } catch {}
    return out;
  } finally { fs.closeSync(fd); }
}

// ---------- what a 3MF says about itself: the listing title, designer and description a download site wrote into it, and its part names ----------
function plainText(s) {
  s = String(s || '');
  for (let i = 0; i < 3; i++) {
    s = s.replace(/&#x([0-9a-f]{1,6});/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
      .replace(/&#(\d{1,7});/g, (m, n) => { try { return String.fromCodePoint(+n); } catch { return ' '; } })
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  return s.replace(/<[^>]{0,300}>/g, ' ').replace(/[\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// The part of a listing that says what the thing is: sales talk, update logs and links are skipped before it is cut to length.
const PITCH = /\b(boost|membership|patreon|subscribe|subscription|commercial (use|licen[cs]e)|licen[cs]e|follow me|my (profile|page|shop|store)|thank(s| you) for (your|the) (amazing |great )?support|sell(ing)? (physical )?prints?|buy me a coffee|ko-?fi|tip jar|rate (this|my) (model|print)|leave a (like|comment|rating)|check out my|download (and|&) (like|rate)|print profile|exclusive model)\b|https?:\/\/|www\./i;
const LOGLINE = /^\W*(update[ds]?|upd|edit|v(ersion)? ?\d[\d.]*|changelog|new)\b[^.!?]{0,40}\d{1,4}[\/.\-]\d{1,2}([\/.\-]\d{1,4})?/i;
function listingText(s) {
  s = String(s || '').replace(/!{2,}/g, '!');
  if (!s) return '';
  const parts = s.split(/(?<=[.!?\u3002\uff01\uff1f])\s+|\s+(?=(?:update[ds]?|edit)\s+\d{1,4}[\/.\-]\d)/i).map(x => x.trim()).filter(Boolean);
  const keep = parts.filter(x => !PITCH.test(x) && !LOGLINE.test(x) && x.replace(/[^\p{L}\p{N}]+/gu, '').length > 2);
  const text = (keep.length ? keep : parts).join(' ');
  return text.length > 700 ? text.slice(0, 700).replace(/\s+\S*$/, '') + '…' : text;
}
const loose = s => String(s || '').toLowerCase().replace(/\.(stl|step|stp|obj|3mf)(_[\w]+)*$/i, '').replace(/[^\p{L}\p{N}]+/gu, '');
const VAGUE = /^(assembly|object|part|body|mesh|solid|unnamed|untitled|default|group|model|component|k[oö]rper|cuerpo|corps|exp|tinker|merged|plate)\d*$/;
const PARTS_MAX = 40;
function selfFacts(fd, size, byName, abs) {
  const out = {};
  const head = (n, max) => {   // the start of an entry, without unpacking a huge one in full
    const e = byName.get(n);
    if (!e) return '';
    if (e.usize <= max) return readEntry(fd, size, e).toString('utf8');
    if (e.method !== 8) return '';
    const lh = readFull(fd, 30, e.off), start = e.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    try { return zlib.inflateRawSync(readFull(fd, Math.min(e.csize, max), start), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8').slice(0, max); } catch { return ''; }
  };
  const root = head('3d/3dmodel.model', 400000);
  const md = k => { const m = new RegExp('<metadata\\s+name="' + k + '"[^>]*>([^<]*)<', 'i').exec(root); return m ? plainText(m[1]) : ''; };
  const own = loose(abs.split(/[\\/]/).pop());
  const ti = md('Title').slice(0, 160), by = md('Designer').slice(0, 60), ab = listingText(md('Description'));
  if (ti && !/^[\[\]{}\s]*$/.test(ti)) out.ti = ti;
  if (by) out.by = by;
  if (ab && loose(ab) !== loose(ti)) out.ab = ab;
  const names = [], srcs = [];
  for (const n of ['metadata/model_settings.config', 'metadata/slic3r_pe_model.config']) {
    const t = head(n, 4000000);
    let m;
    const nr = /key="name"\s+value="([^"]*)"/g, sr = /key="source_file"\s+value="([^"]*)"/g;
    while ((m = nr.exec(t))) names.push(plainText(m[1]));
    while ((m = sr.exec(t))) srcs.push(plainText(m[1]).split(/[\\/]/).pop());
  }
  { let m; const or = /<object\b[^>]*?\bname="([^"]+)"/g; while ((m = or.exec(root))) names.push(plainText(m[1])); }
  const tidy = list => { const seen = new Set(), keep = []; for (const n of list) { const k = loose(n); if (!k || k === own || VAGUE.test(k) || seen.has(k)) continue; seen.add(k); keep.push(n.replace(/\.(stl|step|stp|obj|3mf)(_[\w]+)*$/i, '').slice(0, 60)); } return keep; };
  // Every part is listed (a very long list is cut at PARTS_MAX, and the number left out is kept). The name the file once had is the
  // file it was made from in the slicer: only a file made from ONE other file has such a name. Where several files were brought
  // together, those are the parts' own names — they belong in Parts, and none of them is what this file "was called".
  const all = tidy(names), from = tidy(srcs);
  const pn = all.slice(0, PARTS_MAX), og = from.length === 1 && !all.some(p => loose(p) === loose(from[0])) ? from : [];
  if (pn.length) out.pn = pn;
  if (all.length > pn.length) out.pm = all.length - pn.length;
  if (og.length) out.og = og;
  return out;
}

// the real size of a model in millimetres: the largest separate object, and how many objects the file holds
async function sizeOf(abs, ext) {
  const each = await meshOf(abs, ext);
  const boxes = new Map();
  for (const p of each.parts || [{ each, item: 0 }]) {
    const k = p.item || 0;
    let b = boxes.get(k);
    if (!b) boxes.set(k, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    const put = (x, y, z) => { if (x < b[0]) b[0] = x; if (x > b[3]) b[3] = x; if (y < b[1]) b[1] = y; if (y > b[4]) b[4] = y; if (z < b[2]) b[2] = z; if (z > b[5]) b[5] = z; };
    p.each((a, b2, c, d, e, f, g, h, i) => { put(a, b2, c); put(d, e, f); put(g, h, i); });
  }
  const dims = [...boxes.values()].map(b => [b[3] - b[0], b[4] - b[1], b[5] - b[2]]).filter(d => d.every(v => Number.isFinite(v) && v >= 0) && Math.max(...d) > 0 && Math.max(...d) < 100000);
  if (!dims.length) return {};
  dims.sort((x, y) => Math.max(...y) - Math.max(...x));
  return { sz: dims[0].map(v => Math.round(v * 10) / 10), n: dims.length };
}

parentPort.on('message', async job => {
  if (job.mode === 'meta') {
    let meta = {};
    try { if (job.slicer) meta = readMeta(job.abs, job.ext); }
    catch (e) { if (e && e.syscall) { parentPort.postMessage({ key: job.key, ok: false, io: true }); return; } }
    if (job.size) {
      try { Object.assign(meta, await sizeOf(job.abs, job.ext)); }
      catch (e) { if (e && e.syscall) { parentPort.postMessage({ key: job.key, ok: false, io: true }); return; } }
    }
    parentPort.postMessage({ key: job.key, ok: true, meta });
    return;
  }
  if (job.mode === 'retone') {
    try {
      const png = liftDarkPicture(fs.readFileSync(job.out));
      if (png) { fs.writeFileSync(job.out + '.tmp', png); fs.renameSync(job.out + '.tmp', job.out); }
      parentPort.postMessage({ key: job.key, ok: true, same: !png });
    } catch (e) { parentPort.postMessage({ key: job.key, ok: false, kind: 'io', msg: String((e && e.message) || e).slice(0, 300) }); }
    return;
  }
  if (job.mode === 'mesh') {
    try { const m = await makeMesh(job.abs, job.ext); parentPort.postMessage({ key: job.key, ok: true, mesh: m }, [m.buf]); }
    catch (e) { parentPort.postMessage({ key: job.key, ok: false, msg: String((e && e.message) || e).slice(0, 300) }); }
    return;
  }
  try {
    const png = await make(job.abs, job.ext);
    if (job.cmp) { let was = null; try { was = fs.readFileSync(job.out); } catch {} if (was && was.equals(png)) { parentPort.postMessage({ key: job.key, ok: true, same: true }); return; } }
    fs.writeFileSync(job.out + '.tmp', png);
    fs.renameSync(job.out + '.tmp', job.out);
    parentPort.postMessage({ key: job.key, ok: true });
  } catch (e) {
    const kind = e instanceof Corrupt ? 'corrupt' : e instanceof Unsupported ? 'unsupported' : e && e.syscall ? 'io' : 'unsupported';
    parentPort.postMessage({ key: job.key, ok: false, kind, msg: String((e && e.message) || e).slice(0, 300) });
  }
});
