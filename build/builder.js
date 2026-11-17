'use strict';
// electron-builder settings for the real program:  npm run dist   (electron-builder --config build/builder.js)
// Everything is worked out from brand.js by build/make-config.js.
module.exports = require('./make-config.js')(require('../brand.js'));
