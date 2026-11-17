'use strict';
// After a build: checks that the installer is in dist\ under its one name, and writes latest.json beside it for a library's
// "updates" folder. Run by  npm run dist  (after electron-builder); it can also be run by itself:
//   node scripts/release-files.js [folder to use instead of dist]
//
// A release carries ONE installer:  <name>-Setup-<version>.exe  (the name comes from brand.js), and latest.json names that file.
// Releases used to carry a second copy named after the program's former name. That copy is no longer made, and one left in the
// folder by an earlier build of this same version is taken away here, so it cannot be attached to a release by mistake.
// (The program itself still accepts an installer named after a former name if it is ever offered one: isSetup in brand.js.)
// See docs/RELEASING.md.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..'), brand = require(path.join(root, 'brand.js'));
const version = require(path.join(root, 'package.json')).version;
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist');
const name = brand.setupName(version), main = path.join(dist, name);
if (!fs.existsSync(main)) { console.error('release-files: ' + main + ' is not there. Build first (npm run dist).'); process.exit(1); }
// copies under a former name, of this version only: made by earlier builds, not part of a release any more
for (const p of brand.formerSetupPrefixes || []) {
  const old = p + version + '.exe';
  if (old !== name && fs.existsSync(path.join(dist, old))) { fs.rmSync(path.join(dist, old)); console.log(old.padEnd(34), 'removed: a release has one installer, ' + name); }
}
fs.writeFileSync(path.join(dist, 'latest.json'), JSON.stringify({ version, file: name }, null, 2) + '\n');
// anything else in the folder that looks like an installer is from another version: said, and left alone
const others = fs.readdirSync(dist).filter(f => f !== name && brand.isSetup(f));
const size = fs.statSync(main).size, sum = crypto.createHash('sha256').update(fs.readFileSync(main)).digest('hex');
console.log(name.padEnd(34), (size / 1048576).toFixed(1) + ' MB');
console.log('latest.json'.padEnd(34), 'names ' + name + ' (version ' + version + ')');
if (others.length) console.log('Not part of this release (another version, left as it is): ' + others.join(', '));
console.log('sha256 ' + sum + '  ' + size + ' bytes');
