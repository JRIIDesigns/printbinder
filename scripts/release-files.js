'use strict';
// After a build: puts the installer in dist\ under every name a release needs, and writes latest.json for a library's
// "updates" folder. Run by  npm run dist  (after electron-builder); it can also be run by itself:  node scripts/release-files.js
//
// Why more than one name: an installed copy only accepts an update whose file is named the way IT expects. Copies installed
// while the program was called Print Gallery (up to 2.0.2) accept only  Print-Gallery-Setup-<version>.exe ; newer ones accept
// both. So a release carries the SAME installer under both names, and latest.json names the one every install accepts.
// The names come from brand.js (name and formerNames). See docs/RELEASING.md.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..'), brand = require(path.join(root, 'brand.js'));
const version = require(path.join(root, 'package.json')).version, dist = path.join(root, 'dist');
const names = brand.setupNames(version), main = path.join(dist, names[0]);
if (!fs.existsSync(main)) { console.error('release-files: ' + main + ' is not there. Build first (npm run dist).'); process.exit(1); }
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for (const n of names.slice(1)) fs.copyFileSync(main, path.join(dist, n));
// the name every install accepts: the oldest former name when there is one
const forAll = names[names.length - 1];
fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify({ version, file: forAll }, null, 2) + '\n');
const size = fs.statSync(main).size, sum = sha(main);
for (const n of names) console.log(n.padEnd(34), (fs.statSync(path.join(dist, n)).size / 1048576).toFixed(1) + ' MB', sha(path.join(dist, n)) === sum ? 'same file' : 'DIFFERENT - build again');
console.log('latest.json                        names ' + forAll + ' (version ' + version + ')');
console.log('sha256 ' + sum + '  ' + size + ' bytes');
