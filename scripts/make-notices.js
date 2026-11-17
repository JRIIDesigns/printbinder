'use strict';
// Writes THIRD-PARTY-NOTICES.txt: the name, version, licence and licence text of every library that is shipped inside the
// program. Run with:  node scripts/make-notices.js      (npm run dist does it before every build)
//
// What counts as shipped: what electron-builder copies into the installer — the packages named under "dependencies" in
// package.json and everything those need in turn (their "dependencies" and "optionalDependencies"), found in node_modules the
// way Node finds them. Packages used only to build ("devDependencies") and optional extras that are not installed are left out.
// It also prints a short summary, and names every licence that is not a simple permissive one (LGPL, GPL, MPL …), because
// those carry conditions that matter when deciding between an open and a closed release.
//   --check   only print the summary; write nothing
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const brand = require(path.join(root, 'brand.js'));

const PERMISSIVE = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|Unlicense|CC0-1\.0|BlueOak-1\.0\.0|Zlib|Python-2\.0)$/i;
const permissive = id => String(id).replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/i).every(p => PERMISSIVE.test(p.trim()));
const licenceId = pj => {
  const l = pj.license || pj.licenses;
  if (!l) return 'UNKNOWN';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map(x => (x && x.type) || x).join(' OR ');
  return l.type || 'UNKNOWN';
};
const TEXT = /^(licen[cs]e|copying|notice|unlicense)([.\-_].*)?$/i;
const texts = dir => fs.readdirSync(dir).filter(f => TEXT.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort()
  .map(f => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trimEnd() }));

const list = [], missing = [], seen = new Set();
// where Node would find a package when it is asked for from a file in "from": the nearest node_modules on the way up to the project
const find = (name, from) => { for (let d = from; ; d = path.dirname(d)) { const p = path.join(d, 'node_modules', name); if (fs.existsSync(path.join(p, 'package.json'))) return p; if (path.resolve(d) === path.resolve(root)) return null; } };
const walk = (names, from, optional) => {
  for (const name of names) {
    const dir = find(name, from);
    if (!dir) { if (!optional) missing.push(name); continue; }   // an optional package that is not installed is not shipped
    if (seen.has(dir)) continue;
    seen.add(dir);
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const repo = pj.repository && (typeof pj.repository === 'string' ? pj.repository : pj.repository.url) || pj.homepage || '';
    list.push({ name: pj.name || name, version: pj.version || '', licence: licenceId(pj), where: path.relative(root, dir).split(path.sep).join('/'),
      author: (pj.author && (typeof pj.author === 'string' ? pj.author : pj.author.name)) || '', repo: String(repo).replace(/^git\+/, '').replace(/\.git$/, ''), texts: texts(dir) });
    walk(Object.keys(pj.dependencies || {}), dir, false);
    walk(Object.keys(pj.optionalDependencies || {}), dir, true);
  }
};
const own = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
walk(Object.keys(own.dependencies || {}), root, false);
walk(Object.keys(own.optionalDependencies || {}), root, true);
list.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const line = '='.repeat(100), thin = '-'.repeat(100);
const out = [];
out.push('THIRD-PARTY NOTICES', '', brand.name + ' includes the software listed below. Each part belongs to its own authors and is used under its own',
  'licence, which is reproduced in full after the list. This file is made by scripts/make-notices.js from the libraries that',
  'are actually shipped with the program.', '', line, 'OTHER SOFTWARE THE PROGRAM IS BUILT ON', line, '',
  'Electron, Chromium and Node.js — the window, the page engine and the runtime. Their notices are installed beside the',
  'program as "LICENSE.electron.txt" and "LICENSES.chromium.html" (open the folder the program is installed in). Chromium',
  'includes FFmpeg, used under the LGPL 2.1.', '',
  'three.js OrbitControls (public/OrbitControls.js) — part of three.js, MIT licence; see "three" below.', '',
  'The setup program is made with NSIS (zlib/libpng licence) and unpacks with 7-Zip code (LGPL 2.1, with the unRAR restriction).', '',
  line, 'LIBRARIES SHIPPED INSIDE THE PROGRAM (' + list.length + ')', line, '');
const w = Math.max(...list.map(p => (p.name + ' ' + p.version).length));
for (const p of list) out.push((p.name + ' ' + p.version).padEnd(w + 2) + p.licence);
out.push('');
for (const p of list) {
  out.push(line, p.name + ' ' + p.version, 'Licence: ' + p.licence);
  if (p.author) out.push('Author: ' + p.author);
  if (p.repo) out.push('Source: ' + p.repo);
  out.push(line, '');
  if (!p.texts.length) out.push('(This package does not include a licence file. Its licence is the one named above; the full text is at', ' https://spdx.org/licenses/' + encodeURIComponent(p.licence) + '.html)', '');
  for (const t of p.texts) { if (p.texts.length > 1) out.push(thin, t.file, thin); out.push(t.text, ''); }
}
const text = out.join('\n') + '\n';

const byLicence = {};
for (const p of list) (byLicence[p.licence] = byLicence[p.licence] || []).push(p.name);
const flagged = list.filter(p => !permissive(p.licence)), noText = list.filter(p => !p.texts.length);
console.log('Libraries shipped: ' + list.length + (missing.length ? '  (NEEDED BUT NOT INSTALLED — run npm install: ' + missing.join(', ') + ')' : ''));
for (const [l, names] of Object.entries(byLicence).sort((a, b) => b[1].length - a[1].length)) console.log('  ' + l.padEnd(16) + names.length);
console.log(flagged.length ? 'NOT simply permissive — read before choosing open or closed source:' : 'Every licence is a permissive one.');
for (const p of flagged) console.log('  ' + p.name + ' ' + p.version + '  —  ' + p.licence);
if (noText.length) console.log('No licence file in the package (named by id only): ' + noText.map(p => p.name).join(', '));
if (process.argv.includes('--check')) process.exit(0);
const file = path.join(root, 'THIRD-PARTY-NOTICES.txt');
fs.writeFileSync(file, text);
console.log('Wrote ' + path.basename(file) + ' (' + Math.round(text.length / 1024) + ' KB)');
