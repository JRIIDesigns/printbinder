'use strict';
// The bridge for the bar of the "Find models online" window (browser.html), and for nothing else. The pages
// shown below the bar get no bridge at all. The bar can ask for a small fixed set of things; the window decides what happens.
const { contextBridge, ipcRenderer } = require('electron');
const ACTIONS = new Set(['go', 'home', 'back', 'fwd', 'reload', 'stop', 'outside', 'clear', 'sites', 'save', 'unsave', 'showhave', 'showdl', 'search', 'tab', 'libshow', 'setq']);
contextBridge.exposeInMainWorld('pbBrowser', {
  nav: (a, url, more) => { if (ACTIONS.has(a)) ipcRenderer.send('pb-nav', { a, url: a === 'go' || a === 'unsave' || a === 'search' || a === 'setq' ? String(url || '').slice(0, 2000) : undefined, i: a === 'showdl' || a === 'tab' ? (url | 0) : undefined, q: a === 'setq' ? String(more || '').slice(0, 700) : undefined }); },
  onState: f => ipcRenderer.on('pb-state', (e, s) => f(s)),
  onSites: f => ipcRenderer.on('pb-sites', (e, l) => f(l)),
  onHave: f => ipcRenderer.on('pb-have', (e, h) => f(h)),
  onDownloads: f => ipcRenderer.on('pb-dl', (e, l) => f(l)),
  onTabs: f => ipcRenderer.on('pb-tabs', (e, t) => f(t)),
  onNote: f => ipcRenderer.on('pb-note', (e, n) => f(n)),
});
