'use strict';
// The one small bridge between the gallery page and the desktop window. The page stays isolated and sandboxed; it is given
// only these four things:
//   pathFor(file) — where on this computer a file that was dropped onto the window (or chosen in "Add files…") lives, so the
//                   app can copy it into the library itself, folders included;
//   view(state)   — the page saying which picture size, layout and sort it is showing, so the View menu can show the same ticks;
//   dragOut(list) — the page saying that the file-type badge of these library files is being dragged, so the window can start a
//                   real Windows drag (to the desktop, an Explorer folder or a slicer). The page names files by their place in
//                   the library; the window itself works out where they are and refuses anything that is not a file on show.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

//   findModels() — the page asking for the Find models online window (browser.js) to be opened; it carries nothing.
contextBridge.exposeInMainWorld('pgDesk', {
  findModels: () => { try { ipcRenderer.send('pg-find-models'); } catch {} },
  pathFor: file => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  view: v => { try { ipcRenderer.send('pg-view', { size: String(v.size), layout: String(v.layout), sort: String(v.sort), rev: !!v.rev }); } catch {} },
  dragOut: list => { try { ipcRenderer.send('pg-drag', (Array.isArray(list) ? list : [list]).map(String).slice(0, 500)); } catch {} },
});
