'use strict';
// A second program, "<name> Test", that installs BESIDE the real one so that installing, updating and uninstalling can be
// tried for real without touching the real install or its settings:
//   another name          its own install folder (%LOCALAPPDATA%\Programs\<name> Test), shortcuts and "Apps & features" entry
//   another app id        Windows and the installer treat it as a different program
//   its own settings      %APPDATA%\<name> Test
//   its own output        dist-test
// Build:  npm run dist:test          Another version number for trying an update:  set PG_TEST_VERSION=2.0.91  first.
// The built app is told its test name through "brandOverride" in its own package.json (see the end of brand.js).
// PG_TEST_ONECLICK=1 builds it as the older one-click kind of installer (what versions up to 2.0.2 were), for trying the
// step from an old install to the setup wizard.
// The program's former names get " Test" too ("Print Gallery Test"), so that a test install made under the old name is carried
// over by the test build exactly as a real old install is by the real one — its settings folder kept, its installer file name
// accepted, its shortcuts removed — while the real "Print Gallery" install, shortcuts and settings are never looked at.
// (build/make-config.js refuses to build a test variant that shares a former name with the real program.)
const brand = require('../brand.js');
const T = ' Test';
const over = { name: brand.name + T, shortName: brand.shortName + T, appId: brand.appId + '.test', formerNames: (brand.formerNames || []).map(n => n + T) };
const test = brand.variant(over);
module.exports = require('./make-config.js')(test, { output: 'dist-test', packageName: require('../package.json').name + '-test', brandOverride: over, version: process.env.PG_TEST_VERSION || undefined,
  nsis: process.env.PG_TEST_ONECLICK === '1' ? { oneClick: true, runAfterFinish: false, allowElevation: undefined, allowToChangeInstallationDirectory: undefined, uninstallDisplayName: undefined } : undefined });
