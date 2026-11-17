'use strict';
// Reading zip files: what is inside, and taking files out. Nothing here ever writes to a zip.
//   list(abs)                       the entries of a zip, read from its index at the end of the file
//   extract(abs, entry, dest, tick) one entry written to dest; its bytes are checked against the size and the checksum (CRC-32)
//                                   the zip records for it, and the file only takes its name once they match
//   read(abs, entry, max)           a small entry's bytes (checked the same way)
// A zip that cannot be read throws an error marked .zip = 'damaged'; a password-protected one is marked 'locked'.
// Names inside a zip are untrusted: an entry whose path would leave the folder it is unpacked into ("..", a path from the root,
// a drive letter) or that Windows cannot store is marked unsafe and is never written.
const fs = require('fs'), fsp = fs.promises, zlib = require('zlib');
const { Transform, pipeline } = require('stream');
const NAME = (() => { try { return require('./brand.js').name; } catch { return 'PrintBinder'; } })();   // the program's name, for the messages below

const bad = (msg, kind) => Object.assign(new Error(msg), { zip: kind || 'damaged' });
const MAX_INDEX = 96 * 1024 * 1024, MAX_ENTRIES = 250000;

async function readAt(fh, len, pos) {
  const b = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) { const { bytesRead } = await fh.read(b, got, len - got, pos + got); if (!bytesRead) break; got += bytesRead; }
  if (got < len) throw bad('This zip is damaged: it ends before it should (an incomplete download?).');
  return b;
}
// CP437, the character set of zips made by older programs (the upper half; the lower half is plain ASCII)
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const utf8 = new TextDecoder('utf-8', { fatal: true });
function nameOf(buf, flaggedUtf8) {
  if (!flaggedUtf8) { let ascii = true; for (const c of buf) if (c > 127) { ascii = false; break; } if (ascii) return buf.toString('latin1'); }
  try { return utf8.decode(buf); } catch {}   // many programs write UTF-8 without saying so
  let s = ''; for (const c of buf) s += c < 128 ? String.fromCharCode(c) : CP437[c - 128];
  return s;
}
// the path an entry may be written to, as its parts — or null when it must never be written
function safeParts(name) {
  const n = name.replace(/\\/g, '/');
  if (!n || n.includes('\0') || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/').filter((p, i, a) => p !== '' || i < a.length - 1);
  if (!parts.length || parts.length > 40) return null;
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || p.length > 200 || /[:*?"<>|\x00-\x1f]/.test(p) || /[. ]$/.test(p)) return null;
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)) return null;   // names Windows keeps for devices
  }
  return parts;
}
const dosTime = (d, t) => { const ms = new Date(1980 + (d >> 9), ((d >> 5) & 15) - 1, d & 31, t >> 11, (t >> 5) & 63, (t & 31) * 2).getTime(); return Number.isFinite(ms) && d ? ms : 0; };

async function list(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const size = (await fh.stat()).size;
    if (size < 22) throw bad(size === 0 ? 'This zip is empty (0 bytes).' : 'This is not a zip file, or it is damaged.');
    const tailLen = Math.min(size, 65557), tail = await readAt(fh, tailLen, size - tailLen);
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw bad('This zip is damaged: the list of what is inside it, at the end of the file, is missing (an incomplete download?).');
    let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) {   // zip64: the real numbers are in a second record
      const lp = size - tailLen + e - 20;
      if (lp < 0) throw bad('This zip is damaged: its list of contents cannot be found.');
      const loc = await readAt(fh, 20, lp);
      if (loc.readUInt32LE(0) !== 0x07064b50) throw bad('This zip is damaged: its list of contents cannot be found.');
      const zo = Number(loc.readBigUInt64LE(8));
      if (zo + 56 > size) throw bad('This zip is damaged: it has been cut short.');
      const z = await readAt(fh, 56, zo);
      if (z.readUInt32LE(0) !== 0x06064b50) throw bad('This zip is damaged: its list of contents cannot be found.');
      count = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
    if (cdOff + cdSize > size) throw bad('This zip is damaged: it has been cut short.');
    if (cdSize > MAX_INDEX || count > MAX_ENTRIES) throw bad('This zip lists more files than ' + NAME + ' will open (' + count.toLocaleString() + ').', 'toobig');
    const cd = await readAt(fh, cdSize, cdOff), entries = [];
    let o = 0;
    while (o + 46 <= cd.length && cd.readUInt32LE(o) === 0x02014b50) {
      const flags = cd.readUInt16LE(o + 8), nlen = cd.readUInt16LE(o + 28), xlen = cd.readUInt16LE(o + 30), clen = cd.readUInt16LE(o + 32);
      if (o + 46 + nlen + xlen + clen > cd.length) throw bad('This zip is damaged: its list of contents is cut short.');
      const raw = cd.subarray(o + 46, o + 46 + nlen);
      const ent = { name: nameOf(raw, !!(flags & 0x800)), method: cd.readUInt16LE(o + 10), crc: cd.readUInt32LE(o + 16), csize: cd.readUInt32LE(o + 20), usize: cd.readUInt32LE(o + 24),
        off: cd.readUInt32LE(o + 42), enc: !!(flags & 1) || cd.readUInt16LE(o + 10) === 99, m: dosTime(cd.readUInt16LE(o + 14), cd.readUInt16LE(o + 12)) };
      for (let x = o + 46 + nlen, xe = x + xlen; x + 4 <= xe;) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 1) {   // zip64: sizes too large for the ordinary fields
          let q = x + 4;
          const next = () => { const v = q + 8 <= xe ? Number(cd.readBigUInt64LE(q)) : 0; q += 8; return v; };
          if (ent.usize === 0xFFFFFFFF) ent.usize = next();
          if (ent.csize === 0xFFFFFFFF) ent.csize = next();
          if (ent.off === 0xFFFFFFFF) ent.off = next();
        } else if (id === 0x7075 && len > 5 && x + 4 + len <= xe && cd[x + 4] === 1 && cd.readUInt32LE(x + 5) === zlib.crc32(raw)) {   // the name again, in UTF-8
          try { ent.name = utf8.decode(cd.subarray(x + 9, x + 4 + len)); } catch {}
        }
        x += 4 + len;
      }
      ent.dir = /[\\/]$/.test(ent.name);
      ent.parts = safeParts(ent.name);
      ent.i = entries.length;
      entries.push(ent);
      o += 46 + nlen + xlen + clen;
    }
    if (entries.length !== count && !(count === 0xFFFF)) { if (!entries.length) throw bad('This zip is damaged: its list of contents cannot be read.'); }
    return { size, entries };
  } finally { await fh.close(); }
}

// where an entry's own bytes begin
async function dataStart(fh, size, ent) {
  if (ent.off + 30 > size) throw bad('This zip is damaged: it has been cut short.');
  const lh = await readAt(fh, 30, ent.off);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw bad('This zip is damaged: “' + ent.name + '” is not where the zip says it is.');
  const start = ent.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  if (start + ent.csize > size) throw bad('This zip is damaged: it has been cut short.');
  return start;
}
function check(ent) {
  if (ent.enc) throw bad('This zip is password-protected. ' + NAME + ' cannot open it — unpack it with the password in another program first.', 'locked');
  if (ent.method !== 0 && ent.method !== 8) throw bad('“' + ent.name + '” is packed in a way ' + NAME + ' cannot read (method ' + ent.method + ').', 'unsupported');
}
// The bytes of one entry as a stream that fails unless the size and the checksum both match what the zip records.
function entryStream(abs, start, ent, onBytes) {
  let crc = 0, n = 0;
  const src = ent.csize ? fs.createReadStream(abs, { start, end: start + ent.csize - 1 }) : require('stream').Readable.from([]);
  const verify = new Transform({
    transform(chunk, enc, cb) {
      n += chunk.length;
      if (n > ent.usize) return cb(bad('This zip is damaged: “' + ent.name + '” holds more than the zip says it does.'));   // also stops a zip made to swell without end
      crc = zlib.crc32(chunk, crc);
      if (onBytes) { try { onBytes(chunk.length); } catch (e) { return cb(e); } }
      cb(null, chunk);
    },
    flush(cb) {
      if (n !== ent.usize) return cb(bad('This zip is damaged: “' + ent.name + '” is shorter than the zip says it is.'));
      if ((crc >>> 0) !== (ent.crc >>> 0)) return cb(bad('This zip is damaged: “' + ent.name + '” does not match the checksum the zip keeps for it.'));
      cb();
    },
  });
  const stages = ent.method === 8 ? [src, zlib.createInflateRaw(), verify] : [src, verify];
  return { stages, verify };
}
const inflateErr = (e, ent) => e && e.zip ? e : e && (e.code === 'Z_DATA_ERROR' || e.code === 'Z_BUF_ERROR' || /zlib|inflate|invalid|unexpected end/i.test(e.message || '')) ? bad('This zip is damaged: “' + ent.name + '” cannot be unpacked.') : e;

// Writes one entry to dest. The bytes go to dest + '.pgpart' first; the file takes its name only after the check has passed.
async function extract(abs, ent, dest, onBytes) {
  check(ent);
  const fh = await fsp.open(abs, 'r');
  let start;
  try { start = await dataStart(fh, (await fh.stat()).size, ent); } finally { await fh.close(); }
  const part = dest + '.pgpart';
  try {
    const { stages } = entryStream(abs, start, ent, onBytes);
    await new Promise((ok, no) => pipeline(...stages, fs.createWriteStream(part), e => e ? no(inflateErr(e, ent)) : ok()));
    if (ent.m) await fsp.utimes(part, new Date(), new Date(ent.m)).catch(() => {});   // the file keeps the date it has in the zip
    await fsp.rename(part, dest);
  } catch (e) { await fsp.unlink(part).catch(() => {}); throw e; }
}
async function read(abs, ent, max) {
  check(ent);
  if (ent.usize > (max || 64 * 1024 * 1024)) throw bad('“' + ent.name + '” is too large to show from inside the zip.', 'toobig');
  const fh = await fsp.open(abs, 'r');
  let start;
  try { start = await dataStart(fh, (await fh.stat()).size, ent); } finally { await fh.close(); }
  const chunks = [], { stages, verify } = entryStream(abs, start, ent);
  verify.on('data', d => chunks.push(d));
  await new Promise((ok, no) => pipeline(...stages, e => e ? no(inflateErr(e, ent)) : ok()));
  return Buffer.concat(chunks);
}
module.exports = { list, extract, read, safeParts };
